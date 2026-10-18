/**
 * Drives the real server over HTTP and WebSocket, in a throwaway data directory.
 *
 * The behaviour under test is the whole point of "delete all notebooks": after a
 * wipe the rooms are gone from the disk, from the API and from the websocket, so
 * an old link cannot quietly bring one back to life.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as Y from 'yjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SERVER = path.join(__dirname, '..', 'server', 'index.js')

let checks = 0
const ok = (label) => {
  checks++
  console.log(`  ok  ${label}`)
}

function startServer(env = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nbcollab-test-'))
  const port = 8800 + Math.floor(Math.random() * 190)
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', NBCOLLAB_DATA: dataDir, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`))
  return { port, dataDir, child, base: `http://127.0.0.1:${port}` }
}

async function waitForServer(base, child) {
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`server exited with ${child.exitCode}`)
    try {
      const res = await fetch(`${base}/api/rooms`)
      if (res.ok) return
    } catch {}
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error('server never came up')
}

function stopServer({ child, dataDir }) {
  child.kill('SIGKILL')
  fs.rmSync(dataDir, { recursive: true, force: true })
}

/** Resolves with the open websocket, or rejects with how the handshake failed. */
function connect(base, roomId, { timeout = 3000 } = {}) {
  const url = `${base.replace('http', 'ws')}/ws/rooms/${roomId}?name=Test%20User&userId=tester`
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    const timer = setTimeout(() => reject(new Error('websocket neither opened nor failed')), timeout)
    ws.onopen = () => {
      clearTimeout(timer)
      resolve(ws)
    }
    ws.onerror = () => {
      clearTimeout(timer)
      reject(new Error('handshake refused'))
    }
    ws.onclose = (ev) => {
      clearTimeout(timer)
      reject(new Error(`closed before opening (${ev.code})`))
    }
  })
}

/** Waits for a specific close code on an already-open socket. */
function closedWith(ws, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('socket stayed open')), timeout)
    ws.onclose = (ev) => {
      clearTimeout(timer)
      resolve(ev.code)
    }
  })
}

/* ---------------- the API ---------------- */

const server = startServer()
try {
  await waitForServer(server.base, server.child)
  const api = (p, init) => fetch(`${server.base}${p}`, init)
  const jsonPost = (p, body, method = 'POST') =>
    api(p, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

  let res = await api('/api/rooms')
  let body = await res.json()
  assert.deepEqual(body.rooms, [])
  assert.equal(body.canReset, true)
  ok('a fresh server lists no notebooks and offers a reset')

  res = await jsonPost('/api/rooms', { name: 'week-3 lists' })
  assert.equal(res.status, 201)
  const { id, name } = await res.json()
  assert.equal(name, 'week-3 lists')
  assert.match(id, /^week-3-lists-[a-z0-9]+$/)
  ok('creating a notebook returns a name-derived code')

  body = await (await api(`/api/rooms/${id}`)).json()
  assert.equal(body.name, 'week-3 lists')
  ok('a created notebook can be looked up by link')

  await jsonPost(`/api/rooms/${id}`, { name: 'week-4 dicts' }, 'PATCH')
  body = await (await api(`/api/rooms/${id}`)).json()
  assert.equal(body.name, 'week-4 dicts')
  ok('renaming a notebook updates the name the lobby shows')

  assert.equal((await api('/api/rooms/no-such-room')).status, 404)
  ok('an unknown code is a 404, not an empty notebook')

  await assert.rejects(() => connect(server.base, 'no-such-room'), /handshake refused/)
  ok('a socket to an unknown room is refused rather than inventing it')

  // A notebook whose metadata was lost is still someone's work: keep it openable
  // instead of stranding it behind a 404.
  const orphanId = 'lonely-room-abc123'
  const orphanDoc = new Y.Doc()
  orphanDoc.getText('scratch').insert(0, 'still mine')
  fs.writeFileSync(
    path.join(server.dataDir, 'rooms', `${orphanId}.ydoc`),
    Buffer.from(Y.encodeStateAsUpdate(orphanDoc)),
  )
  assert.equal((await api(`/api/rooms/${orphanId}`)).status, 200)
  const orphanWs = await connect(server.base, orphanId)
  orphanWs.close()
  ok('a notebook without metadata still opens, so its work is not stranded')

  const ws = await connect(server.base, id)
  const sync = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no sync message')), 3000)
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.type === 'sync') {
        clearTimeout(timer)
        resolve(msg)
      }
    }
  })
  assert.ok(sync.update_b64)
  ok('a socket to a real room gets the document')

  /* ---------------- deleting everything ---------------- */

  res = await api('/api/rooms', { method: 'DELETE' })
  body = await res.json()
  assert.equal(res.status, 200)
  assert.equal(body.deleted, 2, 'the registered notebook and the metadata-less one')
  ok('deleting everything reports how much went')

  assert.equal((await api(`/api/rooms/${orphanId}`)).status, 404)
  ok('the wipe takes metadata-less notebooks with it, not just registered ones')

  assert.deepEqual((await (await api('/api/rooms')).json()).rooms, [])
  assert.equal((await api(`/api/rooms/${id}`)).status, 404)
  ok('the notebook is gone from the API')

  const docs = fs.existsSync(path.join(server.dataDir, 'rooms'))
    ? fs.readdirSync(path.join(server.dataDir, 'rooms'))
    : []
  assert.deepEqual(docs.filter((f) => f.endsWith('.ydoc')), [])
  ok('the saved notebook is gone from the disk')

  await assert.rejects(() => connect(server.base, id), /handshake refused/)
  ok('the old link no longer opens a notebook')

  body = await (await api('/api/rooms', { method: 'DELETE' })).json()
  assert.equal(body.deleted, 0)
  ok('deleting twice is harmless')

  /* ---------------- wiping a live session ---------------- */

  const live = await jsonPost('/api/rooms', { name: 'in progress' })
  const liveId = (await live.json()).id
  const editing = await connect(server.base, liveId)
  const code = closedWith(editing)
  await api('/api/rooms', { method: 'DELETE' })
  assert.equal(await code, 4004)
  ok('students editing when the wipe lands are disconnected, not left hanging')

  assert.deepEqual((await (await api('/api/rooms')).json()).rooms, [])
  ok('the wiped room did not save itself back onto the disk')
} finally {
  stopServer(server)
}

/* ---------------- the opt-out ---------------- */

const locked = startServer({ NBCOLLAB_ALLOW_RESET: '0' })
try {
  await waitForServer(locked.base, locked.child)
  const body = await (await fetch(`${locked.base}/api/rooms`)).json()
  assert.equal(body.canReset, false)
  ok('NBCOLLAB_ALLOW_RESET=0 hides the reset button')

  const res = await fetch(`${locked.base}/api/rooms`, { method: 'DELETE' })
  assert.equal(res.status, 403)
  ok('and refuses the delete even if the button is called directly')
} finally {
  stopServer(locked)
}

console.log(`\nall ${checks} room-api checks passed`)
