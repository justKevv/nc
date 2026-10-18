/**
 * Drives the Cloudflare side of the relay — the Worker, the room index and a
 * room's Durable Object — inside Node, with the runtime pieces it depends on
 * stubbed out.
 *
 * `wrangler dev` is the real thing, and `npm run cloud` is how you use it, but it
 * cannot be the only proof: this file runs in CI, on every `npm test`, and it can
 * do the awkward things on purpose — evict the object and prove the notebook
 * comes back, flood a socket past the token bucket, wipe a room out from under
 * its clients.
 *
 * Three globals are faked, and only those three:
 *   WebSocketPair  — the runtime's pair of sockets, and hibernation attachments.
 *   Response       — Node refuses `status: 101`, and a Durable Object returns one.
 *   Durable Object — ctx.storage, ctx.acceptWebSocket, ctx.blockConcurrencyWhile.
 */
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import * as awarenessProtocol from 'y-protocols/awareness'
import { fromBase64, toBase64 } from '../shared/protocol.js'

/* ------------------------------------------------------------------ *
 * The fake runtime
 * ------------------------------------------------------------------ */

class FakeClient {
  constructor() {
    this.readyState = 1
    this.inbox = []
    this.closeCode = null
    this.send = () => {}
  }
  close(code) {
    this.readyState = 3
    this.closeCode = code
  }
  frames() {
    return this.inbox.map((raw) => JSON.parse(raw))
  }
  get closed() {
    return this.readyState !== 1
  }
}

class FakeServer {
  constructor(client) {
    this.readyState = 1
    this.attachment = null
    this.client = client
    this.handler = () => {}
  }
  send(data) {
    if (this.readyState !== 1) throw new Error('send on a closed socket')
    this.client.inbox.push(String(data))
  }
  close(code) {
    this.readyState = 3
    this.client.closeCode = code
  }
  serializeAttachment(value) {
    this.attachment = structuredClone(value)
  }
  deserializeAttachment() {
    return this.attachment ? structuredClone(this.attachment) : null
  }
}

globalThis.WebSocketPair = class WebSocketPair {
  constructor() {
    const client = new FakeClient()
    const server = new FakeServer(client)
    client.send = (msg) => server.handler(JSON.stringify(msg))
    this[0] = client
    this[1] = server
  }
}

class TestResponse {
  constructor(body, init = {}) {
    this.body = body
    this.status = init.status ?? 200
    this.headers = new Headers(init.headers || {})
    this.webSocket = init.webSocket || null
  }
  get ok() {
    return this.status >= 200 && this.status < 300
  }
  async json() {
    return this.body ? JSON.parse(this.body) : null
  }
  async text() {
    return this.body ?? ''
  }
}

globalThis.Response = TestResponse

function memoryStorage() {
  const map = new Map()
  return {
    map,
    alarm: null,
    async get(key) {
      if (Array.isArray(key)) {
        const found = new Map()
        for (const k of key) if (map.has(k)) found.set(k, map.get(k))
        return found
      }
      return map.has(key) ? map.get(key) : undefined
    },
    async put(key, value) {
      if (typeof key === 'string') map.set(key, value)
      else for (const [k, v] of Object.entries(key)) map.set(k, v)
    },
    async delete(key) {
      if (Array.isArray(key)) for (const k of key) map.delete(k)
      else map.delete(key)
    },
    async list({ prefix } = {}) {
      const found = new Map()
      for (const [k, v] of map) if (!prefix || k.startsWith(prefix)) found.set(k, v)
      return found
    },
    async deleteAll() {
      map.clear()
    },
    async setAlarm(at) {
      this.alarm = at
    },
    async deleteAlarm() {
      this.alarm = null
    },
    async getAlarm() {
      return this.alarm
    },
  }
}

/**
 * A Durable Object "instance": the object plus the context the runtime hands it.
 * Evicting is deleting it from the table — the storage stays, exactly as it does
 * on Cloudflare when an idle object is stopped.
 */
function instantiate(Klass, storage, env, carriedSockets = []) {
  const sockets = carriedSockets
  let object = null
  const ctx = {
    storage,
    blockConcurrencyWhile: (fn) => Promise.resolve(fn()),
    acceptWebSocket: (ws) => {
      sockets.push(ws)
      ws.handler = (raw) => object.webSocketMessage(ws, raw)
    },
    getWebSockets: () => sockets.filter((ws) => ws.readyState === 1),
  }
  object = new Klass(ctx, env)
  // A hibernated socket outlives the object it was accepted by, so the runtime
  // delivers its next message to whichever instance is live now.
  for (const ws of sockets) ws.handler = (raw) => object.webSocketMessage(ws, raw)
  return { object, ctx, sockets }
}

function harness() {
  const storages = new Map()
  const storageFor = (name) => {
    if (!storages.has(name)) storages.set(name, memoryStorage())
    return storages.get(name)
  }

  const rooms = new Map()
  const indexes = new Map()
  // Sockets accepted before an eviction, kept so the next instance inherits them.
  const carried = new Map()
  const env = {
    NBCOLLAB_ALLOW_RESET: '1',
    ASSETS: {
      fetch: async () =>
        new TestResponse('<!doctype html><title>app</title>', {
          headers: { 'content-type': 'text/html' },
        }),
    },
    ROOMS: {
      idFromName: (name) => name,
      get: (name) => ({
        fetch: (request) => {
          if (!rooms.has(name)) {
            rooms.set(
              name,
              instantiate(RoomServer, storageFor(`room:${name}`), env, carried.get(name) || []),
            )
          }
          return rooms.get(name).object.fetch(request)
        },
      }),
    },
    ROOMS_INDEX: {
      idFromName: (name) => name,
      get: (name) => ({
        fetch: (request) => {
          if (!indexes.has(name)) indexes.set(name, instantiate(RoomsIndex, storageFor(`index:${name}`), env))
          return indexes.get(name).object.fetch(request)
        },
      }),
    },
  }

  return {
    env,
    rooms,
    indexes,
    storageFor,
    /** What the browser does: a plain HTTP call to the Worker. */
    http: (path, init) => worker.fetch(new Request(`https://app.example${path}`, init), env),
    /** What the browser does: ask for the socket upgrade. */
    upgrade: (path) =>
      worker.fetch(
        new Request(`https://app.example${path}`, { headers: { Upgrade: 'websocket' } }),
        env,
      ),
    // Evicting keeps the storage and the hibernated sockets; only the object goes.
    evictRoom: (id) => {
      const previous = rooms.get(id)
      if (previous) {
        carried.set(id, previous.sockets)
        rooms.delete(id)
      }
    },
  }
}

const { default: worker, RoomServer, RoomsIndex } = await import('../worker/index.js')

/* ------------------------------------------------------------------ *
 * Checks
 * ------------------------------------------------------------------ */

let passed = 0
let failed = 0
const check = (label, condition, extra = '') => {
  if (condition) {
    passed++
    console.log(`  ok  ${label}`)
  } else {
    failed++
    console.log(`FAIL  ${label}${extra ? ` — ${extra}` : ''}`)
  }
}

const h = harness()

/** Connect the way the browser does, and hand back the fake client socket. */
async function connect(roomId, { name = 'Guest', color = '#888', userId = 'u1' } = {}) {
  const params = new URLSearchParams({ name, color, userId })
  const res = await h.upgrade(`/ws/rooms/${roomId}?${params}`)
  return { res, client: res.webSocket }
}

const post = (body) =>
  h.http('/api/rooms', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

/* ---- the lobby API ------------------------------------------------- */

console.log('lobby API')
const created = await post({ name: 'Cloud lesson' })
const room = await created.json()
check('creating a notebook answers 201', created.status === 201, String(created.status))
check('the id is readable and unique', /^cloud-lesson-[\w]{5}$/.test(room.id), room.id)

const listed = await (await h.http('/api/rooms')).json()
check('it appears in the lobby list', listed.rooms.some((r) => r.id === room.id))
check('and the reset button is offered by default', listed.canReset === true)

const patched = await h.http(`/api/rooms/${room.id}`, {
  method: 'PATCH',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'Renamed in the cloud' }),
})
check('renaming works', (await patched.json()).name === 'Renamed in the cloud')

const missing = await h.http('/api/rooms/never-existed')
check('an unknown notebook is a 404', missing.status === 404, String(missing.status))

/* ---- connecting ---------------------------------------------------- */

console.log('connecting')
const noRoom = await h.upgrade('/ws/rooms/never-existed')
check('a socket to an unknown notebook is refused', noRoom.status === 404, String(noRoom.status))
check('and no room object was ever created for it', h.rooms.has('never-existed') === false)

const alice = await connect(room.id, { name: 'Alice', color: '#f00', userId: 'u1' })
check('a real notebook upgrades', alice.res.status === 101, String(alice.res.status))

const sync = alice.client.frames().find((f) => f.type === 'sync')
const aliceDoc = new Y.Doc()
Y.applyUpdate(aliceDoc, fromBase64(sync.update_b64))
check('the seed notebook arrives with the sync', aliceDoc.getArray('cells').length === 2)
check(
  'seeded with the name it was created under',
  aliceDoc.getMap('meta').get('title') === 'Renamed in the cloud',
  String(aliceDoc.getMap('meta').get('title')),
)

const bob = await connect(room.id, { name: 'Bob', color: '#00f', userId: 'u2' })
const bobDoc = new Y.Doc()
Y.applyUpdate(bobDoc, fromBase64(bob.client.frames().find((f) => f.type === 'sync').update_b64))
check('a second client gets the same notebook', bobDoc.getArray('cells').length === 2)

/* ---- relaying ------------------------------------------------------ */

console.log('relaying')
aliceDoc.getArray('cells').get(1).get('source').insert(0, '# edited by alice\n')
await alice.client.send({ type: 'update', update_b64: toBase64(Y.encodeStateAsUpdate(aliceDoc)) })
Y.applyUpdate(bobDoc, fromBase64(bob.client.frames().find((f) => f.type === 'update').update_b64))
check(
  'an edit reaches the other client',
  bobDoc.getArray('cells').get(1).get('source').toString().startsWith('# edited by alice'),
)
check(
  'the author is not sent their own edit back',
  alice.client.frames().filter((f) => f.type === 'update').length === 0,
)

// The bug this file exists for: a client ping has to be answered. The Node relay
// answered with a function that was not imported and died on the first ping.
await alice.client.send({ type: 'ping', timestamp: 12345 })
const pong = alice.client.frames().find((f) => f.type === 'pong')
check('a ping is answered with a pong', pong?.timestamp === 12345, JSON.stringify(pong))

await alice.client.send({
  type: 'output',
  event: 'chunk',
  cellId: 'c1',
  runId: 'r1',
  stdout: 'from the cloud',
  text: 'from the cloud\n',
})
const chunk = bob.client.frames().find((f) => f.type === 'output')
check('output is relayed', chunk?.text === 'from the cloud\n', JSON.stringify(chunk))
check('stamped with the sender, not the payload', chunk?.name === 'Alice' && chunk?.userId === 'u1')
check(
  'the author does not receive their own output',
  alice.client.frames().every((f) => f.type !== 'output'),
)

await alice.client.send({
  type: 'output',
  event: 'result',
  cellId: 'c1',
  runId: 'r1',
  stdout: 'done',
  html: '<b onclick="steal()">hi</b><script>bad()</script>',
})
const result = bob.client.frames().filter((f) => f.type === 'output').at(-1)
check('the result is relayed', result?.event === 'result' && result?.stdout === 'done')
check('and its html is stripped of scripts', !/script|onclick/i.test(result?.html), result?.html)

/* ---- a flood is delayed, never dropped ----------------------------- */

console.log('a flood')
const before = bob.client.frames().filter((f) => f.type === 'output').length
for (let i = 0; i < 3000; i++) {
  await alice.client.send({
    type: 'output',
    event: 'chunk',
    cellId: 'c1',
    runId: 'flood',
    stream: 'stdout',
    text: `${i}\n`,
  })
}
await alice.client.send({
  type: 'output',
  event: 'result',
  cellId: 'c1',
  runId: 'flood',
  stdout: 'flood done',
})
const flood = bob.client.frames().filter((f) => f.type === 'output').slice(before)
const floodText = flood
  .filter((f) => f.event === 'chunk')
  .map((f) => f.text)
  .join('')
check('every line of a flood arrives', floodText.split('\n').filter(Boolean).length === 3000, `${floodText.split('\n').filter(Boolean).length} lines`)
check('in order', floodText.startsWith('0\n1\n2\n') && floodText.endsWith('2999\n'), floodText.slice(-8))
check('with the result last', flood.at(-1)?.event === 'result', flood.at(-1)?.event)

/* ---- presence ------------------------------------------------------ */

console.log('presence')
const aliceAwareness = new awarenessProtocol.Awareness(aliceDoc)
aliceAwareness.setLocalStateField('user', { name: 'Alice', color: '#f00' })
const payload = toBase64(
  awarenessProtocol.encodeAwarenessUpdate(aliceAwareness, [aliceDoc.clientID]),
)
await alice.client.send({ type: 'awareness', update_b64: payload })

const carol = await connect(room.id, { name: 'Carol', color: '#0f0', userId: 'u3' })
const replayed = carol.client.frames().filter((f) => f.type === 'awareness')
check('a late joiner is handed the presence already in the room', replayed.some((f) => f.update_b64 === payload))

/* ---- the document survives eviction -------------------------------- */

console.log('eviction')
const big = 'x'.repeat(200000)
aliceDoc.getArray('cells').get(1).get('source').insert(0, big)
await alice.client.send({ type: 'update', update_b64: toBase64(Y.encodeStateAsUpdate(aliceDoc)) })

const aliceRoom = h.rooms.get(room.id)
await aliceRoom.object.alarm() // the debounced save
const storage = h.storageFor(`room:${room.id}`)
check('the document is chunked into parts', storage.map.get('doc:parts') >= 2, String(storage.map.get('doc:parts')))
check('each part is within the Durable Object value limit', [...storage.map.entries()].filter(([k]) => k.startsWith('doc:') && k !== 'doc:parts').every(([, v]) => v.byteLength <= 128 * 1024))

h.evictRoom(room.id)
const back = await connect(room.id, { name: 'Alice', color: '#f00', userId: 'u1' })
const backDoc = new Y.Doc()
Y.applyUpdate(backDoc, fromBase64(back.client.frames().find((f) => f.type === 'sync').update_b64))
check('an evicted notebook comes back with its edits', backDoc.getArray('cells').get(1).get('source').toString().includes('# edited by alice'))
check('and comes back without being seeded twice', backDoc.getArray('cells').length === 2, `${backDoc.getArray('cells').length} cells`)
check('including the large cell', backDoc.getArray('cells').get(1).get('source').toString().length >= 200000)

/* ---- wiping -------------------------------------------------------- */

console.log('wiping')
const closedBefore = alice.client.closed
check('the live socket was still open before the wipe', closedBefore === false)

const wiped = await h.http('/api/rooms', { method: 'DELETE' })
const wipeBody = await wiped.json()
check('the wipe reports what it deleted', wipeBody.deleted >= 1, JSON.stringify(wipeBody))
check('a live client is told the notebook is gone (4004)', alice.client.closeCode === 4004, String(alice.client.closeCode))
check('room storage is emptied', storage.map.size === 0, `${storage.map.size} values left`)

const listedAfter = await (await h.http('/api/rooms')).json()
check('the lobby is empty', listedAfter.rooms.length === 0)

const reopened = await h.upgrade(`/ws/rooms/${room.id}`)
check('an old link no longer opens the room', reopened.status === 404, String(reopened.status))
check('and does not resurrect it in the lobby', (await (await h.http('/api/rooms')).json()).rooms.length === 0)

/* ---- the switch, and the routes around it -------------------------- */

console.log('the routes around it')
const locked = { ...h.env, NBCOLLAB_ALLOW_RESET: '0' }
const lockedList = await (
  await worker.fetch(new Request('https://app.example/api/rooms'), locked)
).json()
check('disabling the reset hides the button', lockedList.canReset === false)
const lockedWipe = await worker.fetch(new Request('https://app.example/api/rooms', { method: 'DELETE' }), locked)
check('and refuses the endpoint', lockedWipe.status === 403, String(lockedWipe.status))

const pyodide = await h.http('/pyodide/pyodide.mjs')
check('pyodide is not served from the Worker', pyodide.status === 404, String(pyodide.status))
check('and says so as plain text, not as the app', pyodide.headers.get('content-type')?.startsWith('text/plain'))

const app = await h.http('/r/some-notebook')
check('a notebook URL falls through to the app', (await app.text()).includes('<!doctype html'))

assert.ok(passed > 0)
console.log(`\n${passed} checks passed, ${failed} failed\n`)
process.exit(failed ? 1 : 0)
