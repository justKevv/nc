/**
 * The lobby's "Your notebooks" list: what this browser remembers, and how it
 * ages. Both are pure functions over localStorage and a timestamp, so they run
 * here under node with a stub storage rather than needing a browser.
 */
import assert from 'node:assert/strict'

let checks = 0
const ok = (label, fn) => {
  fn()
  checks++
  console.log(`  ok  ${label}`)
}

const store = new Map()
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
}

const { clearMyRooms, forgetRoom, listMyRooms, rememberRoom } = await import(
  '../web/src/lib/myRooms.js'
)
const { timeAgo } = await import('../web/src/lib/format.js')

ok('a fresh browser has no notebooks of its own', () => {
  assert.deepEqual(listMyRooms(), [])
})

ok('creating a notebook remembers it with its name', () => {
  rememberRoom('week-3-lists-a1b2c', 'week-3 lists')
  const rooms = listMyRooms()
  assert.equal(rooms.length, 1)
  assert.equal(rooms[0].id, 'week-3-lists-a1b2c')
  assert.equal(rooms[0].name, 'week-3 lists')
})

ok('the newest notebook is first', () => {
  rememberRoom('warm-up-zzzzz', 'warm-up')
  assert.equal(listMyRooms()[0].id, 'warm-up-zzzzz')
  assert.equal(listMyRooms()[1].id, 'week-3-lists-a1b2c')
})

ok('re-creating the same id moves it up instead of duplicating it', () => {
  rememberRoom('week-3-lists-a1b2c', 'week-3 lists')
  const rooms = listMyRooms()
  assert.equal(rooms.length, 2)
  assert.equal(rooms[0].id, 'week-3-lists-a1b2c')
})

ok('forgetting one leaves the others alone', () => {
  forgetRoom('week-3-lists-a1b2c')
  assert.deepEqual(
    listMyRooms().map((r) => r.id),
    ['warm-up-zzzzz'],
  )
})

ok('a wiped server clears the list', () => {
  clearMyRooms()
  assert.deepEqual(listMyRooms(), [])
})

ok('corrupt storage does not break the lobby', () => {
  store.set('nbcollab:mine', '{not json')
  assert.deepEqual(listMyRooms(), [])
  store.set('nbcollab:mine', JSON.stringify([{ name: 'no id' }, null, { id: 'real-1' }]))
  assert.deepEqual(
    listMyRooms().map((r) => r.id),
    ['real-1'],
  )
  clearMyRooms()
})

const NOW = 1_700_000_000_000
ok('recent edits read as "just now"', () => {
  assert.equal(timeAgo(NOW - 5_000, NOW), 'just now')
})
ok('minutes, hours and days are rounded coarsely', () => {
  assert.equal(timeAgo(NOW - 4 * 60_000, NOW), '4 min ago')
  assert.equal(timeAgo(NOW - 3 * 3600_000, NOW), '3 h ago')
  assert.equal(timeAgo(NOW - 26 * 3600_000, NOW), 'yesterday')
  assert.equal(timeAgo(NOW - 5 * 24 * 3600_000, NOW), '5 days ago')
})
ok('a missing timestamp yields no text rather than "NaN"', () => {
  assert.equal(timeAgo(null, NOW), '')
  assert.equal(timeAgo(undefined, NOW), '')
})

console.log(`\nall ${checks} lobby checks passed`)
