import * as Y from 'yjs'
import * as awarenessProtocol from 'y-protocols/awareness'
import { outputEnvelope } from './outputFeed.js'

const PING_MS = 5000
const MAX_BACKOFF = 10000

/**
 * Minimal Yjs provider speaking the same JSON envelope PyTogether uses:
 *   { type: 'sync' | 'update' | 'awareness' | 'output' | 'ping' | 'pong', ... }
 * Updates are base64 Yjs binary updates.
 */
export function createProvider({ roomId, user, doc, onPeers, onStatus, onOutput, onGone }) {
  const awareness = new awarenessProtocol.Awareness(doc)
  awareness.setLocalStateField('user', user)

  const state = { synced: false, peers: new Map() }
  let ws = null
  let backoff = 500
  let pingTimer = null
  let closedByUs = false

  const send = (msg) => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
  }

  const url = () => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const params = new URLSearchParams({ name: user.name, color: user.color, userId: user.id })
    return `${proto}://${location.host}/ws/rooms/${roomId}?${params}`
  }

  function publishPeers() {
    const peers = []
    for (const [clientId, s] of awareness.getStates()) {
      if (s?.user) peers.push({ clientId, ...s.user })
    }
    state.peers = new Map(peers.map((p) => [p.clientId, p]))
    onPeers?.(peers)
  }

  function connect() {
    ws = new WebSocket(url())
    onStatus?.('connecting')

    ws.onopen = () => {
      backoff = 500
      onStatus?.('connected')
      pingTimer = setInterval(() => send({ type: 'ping', timestamp: Date.now() }), PING_MS)
      // Push our current doc state so a mid-session joiner catches us up,
      // and announce our presence.
      send({ type: 'update', update_b64: toB64(Y.encodeStateAsUpdate(doc)) })
      pushAwareness()
    }

    ws.onmessage = (ev) => {
      let msg
      try {
        msg = JSON.parse(ev.data)
      } catch {
        return
      }

      switch (msg.type) {
        case 'sync': {
          const update = fromB64(msg.update_b64)
          if (update) Y.applyUpdate(doc, update, 'remote')
          state.synced = true
          pushAwareness()
          break
        }
        case 'update': {
          const update = fromB64(msg.update_b64)
          if (update) Y.applyUpdate(doc, update, 'remote')
          break
        }
        case 'awareness': {
          const update = fromB64(msg.update_b64)
          if (update) awarenessProtocol.applyAwarenessUpdate(awareness, update, 'remote')
          break
        }
        case 'connection':
          publishPeers()
          break
        case 'output':
          onOutput?.(msg)
          break
        case 'ping':
          send({ type: 'pong', timestamp: msg.timestamp })
          break
      }
    }

    ws.onclose = (ev) => {
      clearInterval(pingTimer)
      // 4004 means the notebook was deleted underneath us (see the server's
      // room.dispose). Reconnecting would be pointless — worse, it would look
      // like a flaky connection instead of the truth: this notebook is gone.
      if (ev?.code === 4004) {
        closedByUs = true
        onStatus?.('gone')
        onGone?.()
        return
      }
      onStatus?.('disconnected')
      if (closedByUs) return
      setTimeout(connect, backoff)
      backoff = Math.min(backoff * 2, MAX_BACKOFF)
    }

    ws.onerror = () => ws.close()
  }

  function pushAwareness() {
    const ids = [...awareness.getStates().keys()]
    if (!ids.length) return
    send({
      type: 'awareness',
      update_b64: toB64(awarenessProtocol.encodeAwarenessUpdate(awareness, ids)),
    })
  }

  // Re-broadcast local doc edits, tagged as a local origin so we skip the echo.
  doc.on('update', (update, origin) => {
    if (origin === 'remote') return
    send({ type: 'update', update_b64: toB64(update) })
  })

  awareness.on('update', ({ added, updated, removed }, origin) => {
    if (origin === 'remote') return
    const ids = added.concat(updated, removed)
    if (ids.length) pushAwareness()
    publishPeers()
  })

  connect()

  return {
    awareness,
    /**
     * Share what this browser's kernel printed. The server only stamps the
     * sender's identity onto the envelope and forwards it.
     */
    sendOutput: (msg) => send(outputEnvelope(msg)),
    destroy() {
      closedByUs = true
      clearInterval(pingTimer)
      awarenessProtocol.removeAwarenessStates(awareness, [doc.clientID], 'local')
      ws?.close()
    },
  }
}

const toB64 = (u8) => {
  let s = ''
  const chunk = 0x8000
  for (let i = 0; i < u8.length; i += chunk) {
    s += String.fromCharCode.apply(null, u8.subarray(i, i + chunk))
  }
  return btoa(s)
}

const fromB64 = (s) => {
  if (typeof s !== 'string') return null
  try {
    const bin = atob(s)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  } catch {
    return null
  }
}
