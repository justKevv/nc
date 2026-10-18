/**
 * One Durable Object per notebook: the Cloudflare-side twin of `server/index.js`.
 *
 * Same envelope (see `shared/protocol.js`), same caps, same "the room is the
 * authority on whether it still exists" rule. What is different is the shape of
 * the runtime:
 *
 *   - Sockets hibernate. `ctx.acceptWebSocket` means a class full of idle
 *     browsers costs nothing between messages, so identity has to live in the
 *     per-socket attachment rather than in a map this object happens to be
 *     holding.
 *   - No timers. Persisting is debounced with a storage alarm instead of
 *     `setTimeout`, and the output token bucket refills lazily from elapsed time
 *     rather than on an interval — otherwise the object could never sleep.
 *   - The document is chunked. A Durable Object value is capped at ~128 kB, so
 *     the encoded Yjs update is written as numbered parts.
 */
import * as Y from 'yjs'
import { seedDoc } from '../shared/room.js'
import { indexCall } from './rooms-index.js'
import {
  OUTPUT_CAPS,
  awarenessMessage,
  connectionMessage,
  fromBase64,
  pongMessage,
  sanitizeOutput,
  syncMessage,
  toBase64,
  updateMessage,
} from '../shared/protocol.js'

const CHUNK_BYTES = 120 * 1024
const SAVE_AFTER_MS = 2000
const DRAIN_AFTER_MS = 100
// Attachments are meant to be small; a presence payload bigger than this is
// relayed but not kept for replay to late joiners.
const MAX_ATTACHMENT_AWARENESS = 1024

export class RoomServer {
  constructor(ctx, env) {
    this.ctx = ctx
    this.env = env
    this.doc = new Y.Doc()
    this.seeded = false
    this.wiped = false
    this.dirty = false
    this.alarmPending = false
    this.tokens = OUTPUT_CAPS.chunksPerSecond
    this.lastRefill = Date.now()
    this.overflow = new Map()

    this.doc.on('update', () => this.markDirty())
    // Nothing may be served before the document is back from storage: a sync
    // frame sent first would tell the newcomer the notebook is empty.
    this.ready = ctx.blockConcurrencyWhile(() => this.load())
  }

  /* ------------------------------------------------------------------ *
   * Storage
   * ------------------------------------------------------------------ */

  async load() {
    const parts = (await this.ctx.storage.get('doc:parts')) || 0
    if (!parts) return
    const keys = Array.from({ length: parts }, (_, i) => `doc:${i}`)
    const stored = await this.ctx.storage.get(keys)
    const chunks = keys.map((k) => stored.get(k)).filter(Boolean)
    if (!chunks.length) return
    const total = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0))
    let at = 0
    for (const chunk of chunks) {
      total.set(chunk, at)
      at += chunk.byteLength
    }
    Y.applyUpdate(this.doc, total, 'storage')
    this.seeded = true
  }

  markDirty() {
    this.dirty = true
    this.scheduleAlarm(SAVE_AFTER_MS)
  }

  scheduleAlarm(delayMs) {
    if (this.alarmPending || this.wiped) return
    this.alarmPending = true
    this.ctx.storage.setAlarm(Date.now() + delayMs)
  }

  async alarm() {
    this.alarmPending = false
    if (this.wiped) return
    await this.persist()
    // Anything still held for an unanswered flood goes out as soon as the
    // bucket has refilled a little, so it is delayed rather than stranded.
    this.drain(false)
    if (this.overflow.size) this.scheduleAlarm(DRAIN_AFTER_MS)
  }

  async persist() {
    if (!this.dirty || this.wiped) return
    this.dirty = false
    const state = Y.encodeStateAsUpdate(this.doc)
    const parts = Math.max(1, Math.ceil(state.length / CHUNK_BYTES))
    const entries = { 'doc:parts': parts }
    for (let i = 0; i < parts; i++) {
      // `slice`, not `subarray`: a view would keep the whole update alive in
      // every stored part.
      entries[`doc:${i}`] = state.slice(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES)
    }
    // A shrinking document would otherwise leave stale parts behind.
    const previous = (await this.ctx.storage.get('doc:parts')) || 0
    const stale = []
    for (let i = parts; i < previous; i++) stale.push(`doc:${i}`)
    if (stale.length) await this.ctx.storage.delete(stale)
    await this.ctx.storage.put(entries)
  }

  /** There is no `dispose` in the Workers runtime; the alarm is the last word. */
  async flush() {
    if (this.alarmPending) {
      await this.ctx.storage.deleteAlarm()
      this.alarmPending = false
    }
    await this.persist()
  }

  /* ------------------------------------------------------------------ *
   * Sockets
   * ------------------------------------------------------------------ */

  async fetch(request) {
    await this.ready
    const url = new URL(request.url)

    if (url.pathname.endsWith('/wipe') && request.method === 'POST') return this.wipe()

    if ((request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') {
      return json({ error: 'expected a websocket' }, 426)
    }
    // The Worker checks the index before routing here; this is the second lock,
    // for the case where the object outlives the index entry.
    if (this.wiped) return json({ error: 'no such room' }, 404)

    const roomId = url.pathname.match(/\/rooms\/([\w-]+)\/?$/)?.[1] || ''
    await this.seed(roomId)

    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair)
    this.ctx.acceptWebSocket(server)
    server.serializeAttachment({
      userId: url.searchParams.get('userId') || Math.random().toString(36).slice(2, 10),
      name: url.searchParams.get('name') || 'Guest',
      color: url.searchParams.get('color') || '#888',
      awareness: null,
    })

    this.send(server, syncMessage(toBase64(Y.encodeStateAsUpdate(this.doc))))
    this.send(server, connectionMessage({ peers: this.peers(), docName: roomId }))

    // Presence is only relayed at the moment it changes, so a late joiner has to
    // be handed what everyone else last said.
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === server) continue
      const seen = ws.deserializeAttachment?.()
      if (seen?.awareness) this.send(server, awarenessMessage(seen.awareness))
    }

    return new Response(null, { status: 101, webSocket: client })
  }

  async webSocketMessage(ws, raw) {
    await this.ready
    let msg
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw))
    } catch {
      return
    }
    const me = ws.deserializeAttachment() || {}

    switch (msg.type) {
      case 'update': {
        const update = fromBase64(msg.update_b64)
        if (!update) return
        // Valid base64 is not the same as a valid update; a throw in here would
        // take the whole room down.
        try {
          Y.applyUpdate(this.doc, update, ws)
        } catch (err) {
          console.warn(`[room] ignored a bad update: ${err.message}`)
          return
        }
        this.markDirty()
        this.broadcast(JSON.stringify(updateMessage(msg.update_b64)), ws)
        break
      }

      case 'awareness': {
        if (typeof msg.update_b64 === 'string' && msg.update_b64.length <= MAX_ATTACHMENT_AWARENESS) {
          ws.serializeAttachment({ ...me, awareness: msg.update_b64 })
        }
        this.broadcast(JSON.stringify(awarenessMessage(msg.update_b64)), ws)
        break
      }

      case 'output': {
        const out = sanitizeOutput(msg, me)
        if (!out) return
        this.refill()

        // start/result/end are never dropped: they are few, and a peer that
        // misses the result sits on "is running…" forever.
        if (out.event !== 'chunk') {
          this.drainRun(out.runId)
          this.broadcast(JSON.stringify(out), ws)
          return
        }

        if (this.tokens > 0) {
          this.tokens--
          this.broadcast(JSON.stringify(out), ws)
          return
        }

        const key = `${out.runId}|${out.cellId}|${out.stream}`
        const held = this.overflow.get(key)
        const roomLeft = OUTPUT_CAPS.held - (held ? held.text.length : 0)
        if (roomLeft > 0) {
          this.overflow.set(key, {
            out: held ? held.out : out,
            text: (held ? held.text : '') + out.text.slice(0, roomLeft),
          })
        }
        this.scheduleAlarm(DRAIN_AFTER_MS)
        break
      }

      case 'ping':
        this.send(ws, pongMessage(msg.timestamp))
        break
    }
  }

  async webSocketClose(ws) {
    // Nothing to clean up: presence lives in the attachment, and the clients
    // expire a peer that has stopped speaking on their own.
    ws.close()
  }

  async webSocketError(ws) {
    ws.close()
  }

  /* ------------------------------------------------------------------ *
   * Output, presence and teardown
   * ------------------------------------------------------------------ */

  /** Refilled from elapsed time rather than a timer, so the object can sleep. */
  refill() {
    const now = Date.now()
    const elapsed = Math.max(0, now - this.lastRefill)
    this.lastRefill = now
    this.tokens = Math.min(
      OUTPUT_CAPS.chunksPerSecond,
      this.tokens + (elapsed / 1000) * OUTPUT_CAPS.chunksPerSecond,
    )
  }

  drain(force) {
    for (const [key, held] of this.overflow) {
      if (!force && this.tokens <= 0) return
      if (!force) this.tokens--
      this.overflow.delete(key)
      this.broadcast(JSON.stringify({ ...held.out, text: held.text }))
    }
  }

  /** A run's final result must never overtake text still waiting in overflow. */
  drainRun(runId) {
    for (const [key, held] of this.overflow) {
      if (held.out.runId !== runId) continue
      this.overflow.delete(key)
      this.broadcast(JSON.stringify({ ...held.out, text: held.text }))
    }
  }

  peers() {
    const out = []
    for (const ws of this.ctx.getWebSockets()) {
      const me = ws.deserializeAttachment?.()
      if (!me?.userId) continue
      out.push({ clientId: me.userId, name: me.name, color: me.color, cursor: null })
    }
    return out
  }

  /**
   * A new room's title starts as the name it was created with — which the index
   * holds — so the lobby list and the notebook header agree from the first
   * second. If the index cannot be reached the room still works, under its id.
   */
  async seed(roomId) {
    if (this.seeded || this.wiped) return
    this.seeded = true
    let title = null
    try {
      const found = await indexCall(this.env, `/rooms/${roomId}`)
      if (found.ok) title = (await found.json()).name || null
    } catch {}
    seedDoc(this.doc, title || roomId)
  }

  send(ws, msg) {
    try {
      ws.send(JSON.stringify(msg))
    } catch {
      // A socket that has gone away since the last frame; its close handler is
      // already on the way.
    }
  }

  broadcast(raw, except) {
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue
      try {
        ws.send(raw)
      } catch {}
    }
  }

  /**
   * Delete the notebook under its clients. 4004 lets the browser tell "this
   * notebook is gone" apart from a dropped connection and stop reconnecting —
   * the same code the Node relay uses.
   */
  async wipe() {
    if (!this.wiped) {
      this.wiped = true
      for (const ws of this.ctx.getWebSockets()) {
        try {
          ws.close(4004, 'notebook deleted')
        } catch {}
      }
      this.overflow.clear()
      this.doc.destroy()
      if (this.alarmPending) {
        await this.ctx.storage.deleteAlarm()
        this.alarmPending = false
      }
      await this.ctx.storage.deleteAll()
    }
    return json({ deleted: 1 })
  }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}
