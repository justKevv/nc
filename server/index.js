import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'
import * as Y from 'yjs'
import * as awarenessProtocol from 'y-protocols/awareness'
import { getRoom, resetAllRooms, saveAll } from './rooms.js'
import {
  listRooms,
  setRoomMeta,
  getRoomMeta,
  roomExists,
  wipeAllRooms,
  DATA_DIR,
} from './store.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DIST = path.join(__dirname, '..', 'web', 'dist')
const PYODIDE_DIR = path.join(__dirname, '..', 'vendor', 'pyodide')
const PORT = Number(process.env.PORT || 8787)
const HOST = process.env.HOST || '0.0.0.0'

/**
 * Wiping every notebook is one click away on the lobby, which is what a teacher
 * wants between classes — and also one click away for a student in the room.
 * `NBCOLLAB_ALLOW_RESET=0` takes the button off the lobby and 403s the endpoint.
 */
const ALLOW_RESET = process.env.NBCOLLAB_ALLOW_RESET !== '0'

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)

  if (url.pathname.startsWith('/api/')) {
    res.setHeader('content-type', 'application/json')
    try {
      if (req.method === 'POST' && url.pathname === '/api/rooms') {
        const name = (await readBody(req)).name || 'Untitled notebook'
        const id = newRoomId(name)
        setRoomMeta(id, { name })
        getRoom(id, name)
        return json(res, 201, { id, name })
      }
      if (req.method === 'GET' && url.pathname === '/api/rooms') {
        return json(res, 200, { rooms: listRooms(), canReset: ALLOW_RESET })
      }
      if (req.method === 'DELETE' && url.pathname === '/api/rooms') {
        if (!ALLOW_RESET) {
          return json(res, 403, { error: 'resetting is disabled on this server (NBCOLLAB_ALLOW_RESET=0)' })
        }
        // Live rooms first: closing their sockets must not race a pending save
        // back onto the disk we are about to clear.
        const live = resetAllRooms()
        const { deleted } = wipeAllRooms()
        console.log(`[room] reset — deleted ${deleted} notebook(s), ${live.length} live`)
        return json(res, 200, { deleted })
      }
      const m = url.pathname.match(/^\/api\/rooms\/([\w-]+)$/)
      if (m) {
        if (!roomExists(m[1])) return json(res, 404, { error: 'no such room' })
        if (req.method === 'PATCH') {
          const name = String((await readBody(req)).name || '').trim().slice(0, 120)
          if (!name) return json(res, 400, { error: 'name required' })
          return json(res, 200, setRoomMeta(m[1], { name }))
        }
        // Metadata can go missing while the notebook itself survives; the link
        // should still work rather than 404 a room whose contents exist.
        return json(res, 200, getRoomMeta(m[1]) || { id: m[1], name: m[1] })
      }
      return json(res, 404, { error: 'not found' })
    } catch (err) {
      return json(res, 500, { error: err.message })
    }
  }

  if (url.pathname.startsWith('/pyodide/')) {
    return servePyodide(url.pathname.slice('/pyodide/'.length), res)
  }

  serveStatic(url.pathname, res)
})

/**
 * The vendored Python runtime (`npm run fetch:pyodide`), served from the same
 * origin as the app so a student never depends on a third-party CDN being
 * reachable from their classroom. Cache hard: the files are versioned by
 * Pyodide and never change in place.
 */
function servePyodide(rel, res) {
  const name = decodeURIComponent(rel)
  const file = path.join(PYODIDE_DIR, name)
  if (!file.startsWith(PYODIDE_DIR) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    return res.writeHead(404, { 'content-type': 'text/plain' }).end('pyodide not vendored')
  }
  const type =
    name.endsWith('.mjs') || name.endsWith('.js')
      ? 'text/javascript; charset=utf-8'
      : name.endsWith('.wasm')
        ? 'application/wasm'
        : name.endsWith('.json')
          ? 'application/json'
          : 'application/octet-stream'
  res.writeHead(200, { 'content-type': type, 'cache-control': 'public, max-age=31536000, immutable' })
  fs.createReadStream(file).pipe(res)
}

function newRoomId(name) {
  const slug = String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 24)
  return `${slug || 'room'}-${Math.random().toString(36).slice(2, 7)}`
}

function json(res, code, body) {
  res.writeHead(code)
  res.end(JSON.stringify(body))
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', (c) => {
      raw += c
      if (raw.length > 1e6) reject(new Error('body too large'))
    })
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {})
      } catch {
        resolve({})
      }
    })
    req.on('error', reject)
  })
}

function serveStatic(pathname, res) {
  let rel = decodeURIComponent(pathname)
  if (rel === '/' || !path.extname(rel)) rel = '/index.html' // SPA fallback
  const file = path.join(DIST, rel)
  if (!file.startsWith(DIST)) {
    res.writeHead(403).end('forbidden')
    return
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found')
      return
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'cache-control': rel === '/index.html' ? 'no-cache' : 'public, max-age=3600',
    })
    res.end(buf)
  })
}

/* ------------------------------------------------------------------ *
 * WebSocket: same envelope shape PyTogether uses
 *   { type: 'update' | 'sync' | 'awareness' | 'output' | 'ping' | 'pong', ... }
 * ------------------------------------------------------------------ */

const OUTPUT_CAPS = {
  text: 32 * 1024, // one streamed chunk
  field: 128 * 1024, // stdout / stderr / traceback in a final result
  repr: 16 * 1024,
  html: 128 * 1024,
  image: 4 * 1024 * 1024,
  images: 4,
  chunksPerSecond: 250,
  // How much of a flooded stream is held while waiting for budget. Comfortably
  // more than a cell can legitimately produce (the runner itself stops at
  // 200 kB), so a burst is delayed rather than discarded.
  held: 256 * 1024,
}

const str = (v, max) =>
  typeof v === 'string' ? v.slice(0, max) : ''

/**
 * Output is relayed, never interpreted — but it does come from a browser, so it
 * is trimmed and stripped before it reaches the rest of the class. Peers render
 * `html` straight into the DOM, so a script tag or an inline handler coming off
 * the wire is the one thing worth refusing.
 */
function sanitizeOutput(msg, conn) {
  const event = ['start', 'chunk', 'result', 'end'].includes(msg.event) ? msg.event : null
  if (!event) return null

  const out = {
    type: 'output',
    event,
    cellId: str(msg.cellId, 64),
    runId: str(msg.runId, 64),
    userId: conn.userId,
    name: conn.name,
    color: conn.color,
  }

  if (event === 'chunk') {
    out.stream = msg.stream === 'stderr' ? 'stderr' : 'stdout'
    out.text = str(msg.text, OUTPUT_CAPS.text)
    return out
  }

  if (event === 'result') {
    const html = str(msg.html, OUTPUT_CAPS.html)
    out.stdout = str(msg.stdout, OUTPUT_CAPS.field)
    out.stderr = str(msg.stderr, OUTPUT_CAPS.field)
    out.error = str(msg.error, OUTPUT_CAPS.field)
    out.repr = str(msg.repr, OUTPUT_CAPS.repr)
    out.durationMs = Number.isFinite(msg.durationMs) ? Math.min(msg.durationMs, 1e7) : null
    out.images = Array.isArray(msg.images)
      ? msg.images
          .slice(0, OUTPUT_CAPS.images)
          .filter((src) => typeof src === 'string' && src.startsWith('data:image/') && src.length <= OUTPUT_CAPS.image)
      : []
    out.html = html
      .replace(/<\s*(script|style|iframe|object|embed|link|meta)[\s\S]*?>/gi, '')
      .replace(/<\s*\/(?:script|style|iframe|object|embed|link|meta)\s*>/gi, '')
      .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
      .replace(/(href|src)\s*=\s*("|')?\s*javascript:[^"'\s>]*/gi, '$1="#"')
    return out
  }

  return out
}

const wss = new WebSocketServer({ noServer: true })

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
  const m = url.pathname.match(/^\/ws\/rooms\/([\w-]+)\/?$/)
  if (!m) {
    socket.destroy()
    return
  }
  // Refusing unknown ids is what makes "delete all notebooks" stick: without
  // this, anyone opening an old link would silently recreate a blank room.
  if (!roomExists(m[1])) {
    socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
    socket.destroy()
    return
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req, m[1], url)
  })
})

wss.on('connection', (ws, req, roomId, url) => {
  const room = getRoom(roomId)
  const name = url.searchParams.get('name') || 'Guest'
  const color = url.searchParams.get('color') || '#888'
  const userId = url.searchParams.get('userId') || Math.random().toString(36).slice(2, 10)

  const conn = { ws, userId, name, color, clientIds: new Set() }
  room.conns.add(conn)

  // Relays awareness to the rest of the room, and records which Yjs clientIDs
  // this socket owns so we can drop them cleanly when it disconnects.
  const onAwarenessChange = ({ added, updated, removed }, origin) => {
    const changed = added.concat(updated, removed)
    if (origin === conn) {
      for (const id of added.concat(updated)) conn.clientIds.add(id)
      for (const id of removed) conn.clientIds.delete(id)
    } else {
      broadcast(room, encodeAwareness(room, changed), origin)
    }
  }
  room.awareness.on('update', onAwarenessChange)

  send(ws, { type: 'sync', update_b64: toB64(Y.encodeStateAsUpdate(room.doc)) })
  send(ws, { type: 'connection', peers: room.peers(), docName: roomId })

  // Hand the newcomer everyone's current presence. Without this they'd see no
  // remote cursors until someone happened to move, because awareness updates
  // are only relayed at the moment they change.
  const known = [...room.awareness.getStates().keys()]
  if (known.length) {
    send(ws, {
      type: 'awareness',
      update_b64: toB64(awarenessProtocol.encodeAwarenessUpdate(room.awareness, known)),
    })
  }

  // Output can arrive in bursts — a chatty cell streams many chunks a second —
  // so each socket gets a cheap token bucket rather than unbounded relaying.
  let tokens = OUTPUT_CAPS.chunksPerSecond

  // Over the line, the bucket alone is not enough: a cell that prints a few
  // thousand lines in a second used to have everything past the first 250
  // chunks thrown away, which looked exactly like the class seeing half an
  // answer and then nothing at all. Excess chunks are held here instead,
  // merged per stream, and released as one frame when the budget returns.
  const overflow = new Map()
  let flooding = false

  const drain = (force) => {
    for (const [key, held] of overflow) {
      if (!force && tokens <= 0) return
      if (!force) tokens--
      overflow.delete(key)
      broadcast(room, JSON.stringify({ ...held.out, text: held.text }), conn)
    }
    if (overflow.size === 0) flooding = false
  }

  // A run's final result must never overtake text still waiting in overflow, so
  // everything held for that run goes out first — budget or no budget.
  const drainRun = (runId) => {
    for (const [key, held] of overflow) {
      if (held.out.runId !== runId) continue
      overflow.delete(key)
      broadcast(room, JSON.stringify({ ...held.out, text: held.text }), conn)
    }
  }

  // Refilled smoothly rather than in one 250-chunk lump per second: a burst
  // queued by the bucket then leaves within a tenth of a second or so.
  const refill = setInterval(() => {
    tokens = Math.min(OUTPUT_CAPS.chunksPerSecond, tokens + OUTPUT_CAPS.chunksPerSecond / 10)
    drain(false)
  }, 100)

  ws.on('message', (raw) => {
    let msg
    try {
      msg = JSON.parse(raw.toString())
    } catch {
      return
    }

    switch (msg.type) {
      case 'update': {
        const update = fromB64(msg.update_b64)
        if (!update) return
        Y.applyUpdate(room.doc, update, conn)
        setRoomMeta(roomId, {})
        broadcast(room, JSON.stringify({ type: 'update', update_b64: msg.update_b64 }), conn)
        break
      }
      case 'awareness': {
        const update = fromB64(msg.update_b64)
        if (!update) return
        awarenessProtocol.applyAwarenessUpdate(room.awareness, update, conn)
        break
      }
      case 'output': {
        const out = sanitizeOutput(msg, conn)
        if (!out) break

        // start/result/end are never dropped: they are few, and a peer that
        // misses the result sits on "is running…" forever.
        if (out.event !== 'chunk') {
          drainRun(out.runId)
          broadcast(room, JSON.stringify(out), conn)
          break
        }

        if (tokens > 0) {
          tokens--
          broadcast(room, JSON.stringify(out), conn)
          break
        }

        const key = `${out.runId}|${out.cellId}|${out.stream}`
        const held = overflow.get(key)
        const roomLeft = OUTPUT_CAPS.held - (held ? held.text.length : 0)
        if (roomLeft > 0) {
          overflow.set(key, {
            out: held ? held.out : out,
            text: (held ? held.text : '') + out.text.slice(0, roomLeft),
          })
        }
        if (!flooding) {
          flooding = true
          console.warn(
            `[ws ${roomId}] ${conn.name} is printing faster than the relay carries; coalescing the rest`,
          )
        }
        break
      }
      case 'ping':
        send(ws, { type: 'pong', timestamp: msg.timestamp })
        break
      case 'pong':
        // The client's reply to our heartbeat. There is nothing to do with it,
        // but it is not junk, and a relay that runs a classroom should only warn
        // about things it genuinely didn't understand.
        break
      default:
        // Anything unrecognised is dropped, which is right for a relay — but it
        // should be visible. A client envelope whose `type` got clobbered by its
        // own payload looked exactly like this from here.
        console.warn(`[ws ${roomId}] ignoring unknown message type: ${str(msg.type, 40)}`)
    }
  })

  const heartbeat = setInterval(() => send(ws, { type: 'ping', timestamp: Date.now() }), 25000)

  const cleanup = () => {
    clearInterval(heartbeat)
    clearInterval(refill)
    room.awareness.off('update', onAwarenessChange)
    room.conns.delete(conn)
    // A wiped room is already off the disk; saving it here would resurrect it.
    if (!room.disposed) {
      // Remove awareness for clients this socket owned, then tell everyone.
      awarenessProtocol.removeAwarenessStates(room.awareness, [...conn.clientIds], null)
      if (room.conns.size === 0) {
        room.save()
        setRoomMeta(roomId, { active: false })
      }
    }
    if (ws.readyState === ws.OPEN) ws.close()
  }

  ws.on('close', cleanup)
  ws.on('error', cleanup)
})

function encodeAwareness(room, clients) {
  if (!clients.length) return null
  const encoded = awarenessProtocol.encodeAwarenessUpdate(room.awareness, clients)
  return JSON.stringify({ type: 'awareness', update_b64: toB64(encoded) })
}

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg))
}

function broadcast(room, raw, except) {
  for (const c of room.conns) {
    if (c === except) continue
    if (c.ws.readyState === c.ws.OPEN) c.ws.send(raw)
  }
}

const toB64 = (u8) => Buffer.from(u8).toString('base64')
const fromB64 = (s) => {
  if (typeof s !== 'string') return null
  try {
    return new Uint8Array(Buffer.from(s, 'base64'))
  } catch {
    return null
  }
}

server.listen(PORT, HOST, () => {
  console.log(`\n  nbcollab server  http://localhost:${PORT}`)
  console.log(`  data             ${DATA_DIR}`)
  console.log(
    fs.existsSync(PYODIDE_DIR)
      ? `  python runtime  local copy at /pyodide/\n`
      : `  python runtime  CDN only — run \`npm run fetch:pyodide\` to vendor it\n`,
  )

  if (process.argv.includes('--tunnel')) {
    const tunnel = spawn(process.execPath, [path.join(__dirname, 'tunnel.js')], {
      env: { ...process.env, PORT: String(PORT) },
      stdio: 'inherit',
    })
    const stop = () => tunnel.kill('SIGINT')
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)
    process.on('exit', stop)
  }
})

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    saveAll()
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 1000)
  })
}
