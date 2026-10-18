/**
 * The output under a cell: one block, showing whoever ran it last, and what
 * happens when someone presses run again while their previous run is still
 * streaming. Pure functions, so the awkward cases are cheap to pin down here.
 */
import assert from 'node:assert/strict'

let checks = 0
const ok = (label, fn) => {
  fn()
  checks++
  console.log(`  ok  ${label}`)
}

const { applyRemoteMessage, latestRun, isVisible, outputEnvelope } = await import(
  '../web/src/lib/outputFeed.js'
)

const peer = (over = {}) => ({ userId: 'u1', runId: 'r1', cellId: 'c1', name: 'swift otter', color: '#f00', ...over })
const chunk = (text, over = {}) => peer({ event: 'chunk', stream: 'stdout', text, ...over })
const result = (over = {}) => peer({ event: 'result', stdout: 'done', durationMs: 4, ...over })

ok('a first message creates a running entry', () => {
  const feed = applyRemoteMessage({}, peer({ event: 'start' }), 1000)
  assert.equal(Object.keys(feed).length, 1)
  assert.equal(feed.u1.state, 'running')
  assert.equal(feed.u1.startedAt, 1000)
  assert.equal(feed.u1.name, 'swift otter')
})

ok('chunks accumulate on the entry', () => {
  let feed = applyRemoteMessage({}, chunk('a'), 1)
  feed = applyRemoteMessage(feed, chunk('b'), 2)
  assert.equal(feed.u1.stdout, 'ab')
})

ok('stderr goes to its own field', () => {
  let feed = applyRemoteMessage({}, chunk('oops', { stream: 'stderr' }), 1)
  feed = applyRemoteMessage(feed, chunk('fine'), 2)
  assert.equal(feed.u1.stderr, 'oops')
  assert.equal(feed.u1.stdout, 'fine')
})

ok('the result replaces the streamed text with the final one', () => {
  let feed = applyRemoteMessage({}, chunk('partial'), 1)
  feed = applyRemoteMessage(feed, result({ stdout: 'final' }), 2)
  assert.equal(feed.u1.stdout, 'final')
  assert.equal(feed.u1.state, 'done')
  assert.equal(feed.u1.durationMs, 4)
})

ok('running the cell again replaces that person, rather than adding an entry', () => {
  let feed = applyRemoteMessage({}, result(), 1)
  feed = applyRemoteMessage(feed, peer({ event: 'start', runId: 'r2' }), 5000)
  assert.equal(Object.keys(feed).length, 1, 'still one entry for one person')
  assert.equal(feed.u1.runId, 'r2')
  assert.equal(feed.u1.stdout, '', 'the old result is gone')
  assert.equal(feed.u1.startedAt, 5000, 'and it is re-dated to the new run')
})

ok('a chunk from the previous run cannot land in the new one', () => {
  let feed = applyRemoteMessage({}, chunk('old', { runId: 'r1' }), 1)
  feed = applyRemoteMessage(feed, chunk('new', { runId: 'r2' }), 2)
  assert.equal(feed.u1.stdout, 'new')
})

ok('a result arriving after a newer run started does not overwrite it', () => {
  let feed = applyRemoteMessage({}, chunk('new', { runId: 'r2' }), 2)
  feed = applyRemoteMessage(feed, result({ runId: 'r1', stdout: 'stale' }), 3)
  assert.equal(feed.u1.stdout, 'stale', 'the stale result is treated as its own run')
  assert.equal(feed.u1.runId, 'r1')
})

ok('two people are tracked apart, so the later one can take the block', () => {
  let feed = applyRemoteMessage({}, result({ userId: 'u1' }), 1)
  feed = applyRemoteMessage(feed, result({ userId: 'u2', name: 'quiet lynx' }), 2)
  assert.equal(Object.keys(feed).length, 2)
})

ok('someone running the cell elsewhere follows it, leaving nothing behind', () => {
  let feed = applyRemoteMessage({}, result({ cellId: 'c1' }), 1)
  feed = applyRemoteMessage(feed, peer({ event: 'start', runId: 'r2', cellId: 'c9' }), 2)
  assert.equal(feed.u1.cellId, 'c9')
})

ok('messages without a user or run are ignored', () => {
  const feed = applyRemoteMessage({}, { event: 'chunk', text: 'x' })
  assert.deepEqual(feed, {})
})

ok('the envelope type cannot be clobbered by the payload', () => {
  // Exactly what a kernel result looks like on the wire.
  const env = outputEnvelope({ event: 'result', type: 'result', cellId: 'c1', runId: 'r1', repr: '7' })
  assert.equal(env.type, 'output')
  assert.equal(env.event, 'result')
  assert.equal(env.repr, '7')
})

ok('a finished run marks the entry done, not still running', () => {
  let feed = applyRemoteMessage({}, chunk('hello\n'), 1)
  assert.equal(feed.u1.state, 'running')
  feed = applyRemoteMessage(feed, { ...result(), repr: '7' }, 2)
  assert.equal(feed.u1.state, 'done')
  assert.equal(feed.u1.repr, '7')
})

/* ---- what the cell draws ---- */

const mine = (over = {}) => ({ state: 'done', stdout: '2', durationMs: 4, startedAt: 200, ...over })
const other = (over = {}) => ({
  userId: 'u1', runId: 'r1', cellId: 'c1', name: 'swift otter', color: '#f00',
  state: 'done', stdout: '4', durationMs: 12, startedAt: 100, ...over,
})

ok('your own run is shown untagged when it is the latest', () => {
  const entry = latestRun({ mine: mine({ startedAt: 300 }), remotes: [other({ startedAt: 100 })] })
  assert.equal(entry.output.stdout, '2')
  assert.equal(entry.remote, null, 'yours carries no name tag')
})

ok('a classmate who ran after you takes the block, tagged with their name', () => {
  const entry = latestRun({ mine: mine({ startedAt: 100 }), remotes: [other({ startedAt: 300 })] })
  assert.equal(entry.output.stdout, '4')
  assert.equal(entry.remote.name, 'swift otter')
  assert.equal(entry.remote.color, '#f00')
})

ok('the block holds exactly one result, never a stack', () => {
  const entry = latestRun({
    mine: mine({ startedAt: 100 }),
    remotes: [other({ userId: 'u1', startedAt: 200 }), other({ userId: 'u2', startedAt: 300 })],
  })
  assert.equal(entry.output.userId, 'u2', 'the most recent of the three')
})

ok('a run still streaming holds the block, not the one that finished earlier', () => {
  const entry = latestRun({
    mine: mine({ startedAt: 100 }),
    remotes: [other({ state: 'running', stdout: '', startedAt: 400 })],
  })
  assert.equal(entry.output.state, 'running', 'started last wins, even unfinished')
})

ok('an untouched cell draws nothing at all — no empty output box', () => {
  assert.equal(latestRun({ mine: undefined, remotes: [] }), null)
  assert.equal(latestRun({ mine: { state: 'done' }, remotes: [] }), null)
})

ok('your own run shows up before it has printed anything', () => {
  const entry = latestRun({ mine: mine({ state: 'running', stdout: '' }), remotes: [] })
  assert.equal(entry.output.state, 'running')
})

ok('a classmate whose cell printed nothing does not take the block from you', () => {
  const quiet = other({ stdout: '', repr: null, error: null, html: null, images: [], startedAt: 400 })
  const entry = latestRun({ mine: mine({ startedAt: 100 }), remotes: [quiet] })
  assert.equal(entry.output.stdout, '2', 'yours is still the last thing that actually ran')
})

ok('an exact tie stays with your own run', () => {
  const entry = latestRun({ mine: mine({ startedAt: 100 }), remotes: [other({ startedAt: 100 })] })
  assert.equal(entry.remote, null)
})

ok('a repr, a traceback, html and a plot all count as something to show', () => {
  assert.equal(isVisible({ state: 'done', repr: '4' }), true)
  assert.equal(isVisible({ state: 'done', error: 'Traceback…' }), true)
  assert.equal(isVisible({ state: 'done', html: '<b>x</b>' }), true)
  assert.equal(isVisible({ state: 'done', images: ['data:image/png;base64,AA'] }), true)
})

console.log(`\nall ${checks} output-feed checks passed`)
