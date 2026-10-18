/**
 * Standalone smoke test for the sync protocol — two fake browsers join the same
 * room, one edits a cell, and the other must see it.
 *
 * Run with: npm test
 */
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import * as Y from 'yjs'
import * as awarenessProtocol from 'y-protocols/awareness'
import { WebSocket } from 'ws'

const PORT = 8799
const BASE = `http://127.0.0.1:${PORT}`
const DATA = '/tmp/nbcollab-test'

// The client's real envelope, so these tests exercise the same construction the
// app uses rather than a hand-rolled copy of it.
const { outputEnvelope } = await import('../web/src/lib/outputFeed.js')

const toB64 = (u8) => Buffer.from(u8).toString('base64')
const fromB64 = (s) => new Uint8Array(Buffer.from(s, 'base64'))

let passed = 0
let failed = 0

function check(label, fn) {
  try {
    fn()
    passed++
    console.log(`  ok  ${label}`)
  } catch (err) {
    failed++
    console.log(`FAIL  ${label}\n      ${err.message}`)
  }
}

const eq = (a, b, msg) => {
  if (a !== b) throw new Error(msg || `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`)
}
const ok = (v, msg) => {
  if (!v) throw new Error(msg || 'expected truthy')
}

/** A browser-shaped client speaking the same envelope as the real app. */
function fakeClient(roomId, { name, color }) {
  const doc = new Y.Doc()
  const awareness = new awarenessProtocol.Awareness(doc)
  awareness.setLocalStateField('user', { name, color })

  const seen = { synced: false, output: [] }
  const qs = new URLSearchParams({ name, color }).toString()
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/rooms/${roomId}?${qs}`)

  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString())
    if (msg.type === 'sync') {
      Y.applyUpdate(doc, fromB64(msg.update_b64), 'remote')
      seen.synced = true
    } else if (msg.type === 'update') {
      Y.applyUpdate(doc, fromB64(msg.update_b64), 'remote')
    } else if (msg.type === 'output') {
      seen.output.push(msg)
    } else if (msg.type === 'awareness') {
      awarenessProtocol.applyAwarenessUpdate(awareness, fromB64(msg.update_b64), 'remote')
    }
  })

  doc.on('update', (update, origin) => {
    if (origin === 'remote') return
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'update', update_b64: toB64(update) }))
    }
  })

  return {
    doc,
    awareness,
    seen,
    open: () =>
      new Promise((res) =>
        ws.on('open', () => {
          ws.send(
            JSON.stringify({
              type: 'awareness',
              update_b64: toB64(
                awarenessProtocol.encodeAwarenessUpdate(awareness, [...awareness.getStates().keys()]),
              ),
            }),
          )
          res()
        }),
      ),
    output: (msg) => ws.send(JSON.stringify(outputEnvelope(msg))),
    close: () => ws.close(),
  }
}

async function newRoom(name) {
  const res = await fetch(`${BASE}/api/rooms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  })
  eq(res.status, 201, 'room creation should return 201')
  return (await res.json()).id
}

async function run() {
  const server = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, PORT: String(PORT), NBCOLLAB_DATA: DATA },
    stdio: 'ignore',
  })

  let up = false
  for (let i = 0; i < 60 && !up; i++) {
    try {
      await fetch(`${BASE}/api/rooms`)
      up = true
    } catch {
      await sleep(100)
    }
  }
  if (!up) {
    console.log('FAIL  server did not start')
    server.kill()
    process.exit(1)
  }

  console.log('\nroom creation and seeding')
  {
    const id = await newRoom('Week 3 Lists')
    check('slugifies the notebook name into the room id', () => {
      ok(/^week-3-lists-[a-z0-9]{5}$/.test(id), `got ${id}`)
    })
    const alice = fakeClient(id, { name: 'alice', color: '#f00' })
    await alice.open()
    await sleep(300)
    check('client receives the sync message', () => eq(alice.seen.synced, true))
    check('seed notebook has two cells', () => eq(alice.doc.getArray('cells').length, 2))
    check('first cell is markdown', () =>
      eq(alice.doc.getArray('cells').get(0).get('type'), 'markdown'),
    )
    check('second cell holds the welcome code', () =>
      ok(
        alice.doc.getArray('cells').get(1).get('source').toString().includes('hello from'),
        'welcome cell missing',
      ),
    )
    alice.close()
  }

  console.log('\ncollaborative sync')
  {
    const id = await newRoom('pair')
    const alice = fakeClient(id, { name: 'alice', color: '#f00' })
    const bob = fakeClient(id, { name: 'bob', color: '#00f' })
    await Promise.all([alice.open(), bob.open()])
    await sleep(300)

    check('a late joiner receives the existing notebook', () =>
      eq(bob.doc.getArray('cells').length, 2),
    )

    const cell = new Y.Map()
    cell.set('id', 'abc')
    cell.set('type', 'code')
    const text = new Y.Text()
    text.insert(0, 'print("hi")')
    cell.set('source', text)
    alice.doc.getArray('cells').push([cell])
    await sleep(300)

    check('an added cell reaches the other client', () =>
      eq(bob.doc.getArray('cells').length, 3),
    )
    check('the cell body arrives intact', () =>
      eq(bob.doc.getArray('cells').get(2).get('source').toString(), 'print("hi")'),
    )

    alice.doc.getArray('cells').get(0).get('source').insert(0, '# alice\n')
    bob.doc.getArray('cells').get(0).get('source').insert(0, '# bob\n')
    await sleep(400)

    const merged = bob.doc.getArray('cells').get(0).get('source').toString()
    check('concurrent edits to one cell both survive the merge', () => {
      ok(merged.includes('# alice'), 'alice edit lost')
      ok(merged.includes('# bob'), 'bob edit lost')
    })

    alice.close()
    bob.close()
  }

  console.log('\nink and presence')
  {
    const id = await newRoom('ink')
    const alice = fakeClient(id, { name: 'alice', color: '#f00' })
    const bob = fakeClient(id, { name: 'bob', color: '#00f' })
    await Promise.all([alice.open(), bob.open()])
    await sleep(400)

    alice.doc.getArray('drawings').push([
      { type: 'pen', color: '#EF4444', width: 2.5, points: [{ x: 10, y: 20 }, { x: 30, y: 44 }] },
    ])
    await sleep(300)

    check('a drawn stroke reaches the other client', () => eq(bob.doc.getArray('drawings').length, 1))
    check('the stroke keeps its points', () =>
      eq(bob.doc.getArray('drawings').get(0).points[1].y, 44),
    )

    alice.doc.getArray('drawings').push([
      { type: 'erase', color: '#000', width: 22, points: [{ x: 1, y: 2 }, { x: 5, y: 8 }] },
    ])
    await sleep(300)
    check('strokes from both users coexist in draw order', () =>
      eq(bob.doc.getArray('drawings').get(1).type, 'erase'),
    )

    bob.doc.getArray('drawings').delete(0, bob.doc.getArray('drawings').length)
    await sleep(300)
    check('clearing ink reaches the other client', () => eq(alice.doc.getArray('drawings').length, 0))

    const names = [...bob.awareness.getStates().values()].map((s) => s.user?.name).filter(Boolean)
    check('awareness lists both users', () => {
      ok(names.includes('alice'), `saw ${names}`)
      ok(names.includes('bob'), `saw ${names}`)
    })

    alice.close()
    await sleep(200)
    const after = [...bob.awareness.getStates().values()].map((s) => s.user?.name).filter(Boolean)
    check('a disconnecting user leaves the presence list', () =>
      ok(!after.includes('alice'), `saw ${after}`),
    )
    bob.close()
  }

  console.log('\nshared output')
  {
    const id = await newRoom('output')
    const alice = fakeClient(id, { name: 'alice', color: '#f00' })
    const bob = fakeClient(id, { name: 'bob', color: '#00f' })
    await Promise.all([alice.open(), bob.open()])
    await sleep(300)

    alice.output({ event: 'start', cellId: 'c1', runId: 'r1' })
    alice.output({ event: 'chunk', cellId: 'c1', runId: 'r1', stream: 'stdout', text: 'hello\n' })
    await sleep(300)

    check('a run in progress is announced', () => eq(bob.seen.output.length, 2))
    check('output is attributed to the sender, not trusted from the client', () =>
      eq(bob.seen.output[1].name, 'alice'),
    )
    check('streamed text arrives intact', () =>
      eq(bob.seen.output[1].text, 'hello\n'),
    )

    alice.output({
      event: 'result',
      cellId: 'c1',
      runId: 'r1',
      stdout: 'hello\n',
      repr: '42',
      html: '<b>ok</b><script>window.hacked=1</script><img src=x onerror="alert(1)">',
      images: ['data:image/png;base64,AAAA', 'javascript:alert(1)'],
      error: null,
    })
    await sleep(300)
    const result = bob.seen.output.at(-1)
    check('the final result is relayed', () => eq(result.repr, '42'))
    check('script tags are stripped from relayed html', () =>
      ok(!/script/i.test(result.html), result.html),
    )
    check('inline handlers are stripped from relayed html', () =>
      ok(!/onerror/i.test(result.html), result.html),
    )
    check('harmful html survives the strip', () => ok(result.html.includes('<b>ok</b>'), result.html))
    check('only real image payloads are relayed', () => eq(result.images.length, 1))

    // A kernel result carries a `type` field of its own ("result"). Letting it
    // win the merge makes the server match no case and drop the message, which
    // leaves every peer stuck on "is running…" after the text has arrived.
    alice.output({
      event: 'result',
      type: 'result',
      cellId: 'c1',
      runId: 'r2',
      stdout: 'done\n',
      repr: '7',
    })
    await sleep(300)
    check('a result that carries its own message type still arrives', () =>
      eq(bob.seen.output.at(-1).repr, '7'),
    )

    alice.output({ event: 'chunk', cellId: 'c1', runId: 'r1', stream: 'stdout', text: 'x'.repeat(200000) })
    await sleep(300)
    check('oversized chunks are truncated', () => ok(bob.seen.output.at(-1).text.length <= 32 * 1024))

    // A cell that prints a few thousand lines in a second outruns the relay's
    // per-second budget. The overflow used to be dropped, so the class saw the
    // first few hundred lines and then nothing -- which reads as "it's so slow"
    // rather than "your output was thrown away".
    const burst = await newRoom('burst')
    const fast = fakeClient(burst, { name: 'fast', color: '#0f0' })
    const watcher = fakeClient(burst, { name: 'watcher', color: '#00f' })
    await Promise.all([fast.open(), watcher.open()])
    await sleep(300)
    fast.output({ event: 'start', cellId: 'c9', runId: 'rb', })
    const TOTAL = 4000
    for (let i = 0; i < TOTAL; i++) {
      fast.output({ event: 'chunk', cellId: 'c9', runId: 'rb', stream: 'stdout', text: `line ${i}\n` })
    }
    fast.output({ event: 'result', cellId: 'c9', runId: 'rb', stdout: '', repr: null })
    await sleep(2500)

    const text = watcher.seen.output
      .filter((o) => o.event === 'chunk')
      .map((o) => o.text)
      .join('')
    check('a fast-printing cell loses no output', () =>
      ok(text.includes(`line ${TOTAL - 1}`), `held ${text.length} bytes, ends: ${JSON.stringify(text.slice(-24))}`),
    )
    check('every line arrives, in order', () => {
      const lines = text.split('\n').filter((l) => l.startsWith('line '))
      return ok(lines.length === TOTAL, `${lines.length} of ${TOTAL}`)
    })
    check('the result still arrives after a flood', () =>
      ok(watcher.seen.output.some((o) => o.event === 'result' && o.runId === 'rb')),
    )

    alice.output({ event: 'nonsense' })
    await sleep(200)
    check('unknown output events are dropped', () =>
      ok(!bob.seen.output.some((m) => m.event === 'nonsense')),
    )

    alice.close()
    bob.close()
  }

  console.log('\nlate joiner')
  {
    const id = await newRoom('late')
    // Alice arrives first and then sits still. Bob joins afterwards and must
    // still see her — otherwise cursors stay invisible until someone happens
    // to move their mouse.
    const alice = fakeClient(id, { name: 'alice', color: '#f00' })
    await alice.open()
    await sleep(400)

    const bob = fakeClient(id, { name: 'bob', color: '#00f' })
    await bob.open()
    await sleep(400)

    const names = [...bob.awareness.getStates().values()].map((s) => s.user?.name).filter(Boolean)
    check('a late joiner receives existing presence', () =>
      ok(names.includes('alice'), `bob saw ${names}`),
    )
    check('a late joiner receives the notebook', () => eq(bob.doc.getArray('cells').length, 2))

    alice.close()
    bob.close()
  }

  console.log('\npersistence')
  {
    const id = await newRoom('saved')
    const alice = fakeClient(id, { name: 'alice', color: '#f00' })
    await alice.open()
    await sleep(300)
    alice.doc.getArray('cells').get(1).get('source').insert(0, '# saved\n')
    await sleep(2500) // server debounces writes at 1.5s
    alice.close()
    server.kill('SIGINT')
    await sleep(500)

    const restarted = spawn(process.execPath, ['server/index.js'], {
      env: { ...process.env, PORT: String(PORT), NBCOLLAB_DATA: DATA },
      stdio: 'ignore',
    })
    for (let i = 0; i < 60; i++) {
      try {
        await fetch(`${BASE}/api/rooms`)
        break
      } catch {
        await sleep(100)
      }
    }

    const carol = fakeClient(id, { name: 'carol', color: '#0a0' })
    await carol.open()
    await sleep(400)
    check('a notebook survives a server restart', () => {
      const src = carol.doc.getArray('cells').get(1).get('source').toString()
      ok(src.includes('# saved'), 'saved edit missing after restart')
    })
    carol.close()
    restarted.kill()
  }

  console.log(`\n${passed} passed, ${failed} failed\n`)
  process.exit(failed ? 1 : 0)
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
