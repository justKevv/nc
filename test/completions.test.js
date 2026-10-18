/**
 * Member completion after a dot: which text counts as a lookup (`np.`), which
 * does not (`1.5`, `foo().`), and what of the answer is worth showing.
 *
 * The lookup itself happens in the interpreter, but these two decisions are
 * plain functions and they are the ones with sharp edges — a wrong `path` here
 * means asking Python about something nobody wrote.
 */
import assert from 'node:assert/strict'

let checks = 0
const ok = (label, fn) => {
  fn()
  checks++
  console.log(`  ok  ${label}`)
}

const { parseMember, visibleAttrs } = await import('../web/src/lib/completions.js')
const { ATTRS_PATH } = await import('../web/src/lib/attrs.js')

ok('a bare name and a dot is a lookup, with nothing typed yet', () => {
  assert.deepEqual(parseMember('np.'), { path: 'np', partial: '' })
})

ok('what is typed after the dot is the partial', () => {
  assert.deepEqual(parseMember('np.li'), { path: 'np', partial: 'li' })
})

ok('a chain is followed, so np.random. completes members of that', () => {
  assert.deepEqual(parseMember('np.random.'), { path: 'np.random', partial: '' })
})

ok('an attribute of a name from the notebook works the same way', () => {
  assert.deepEqual(parseMember('self.data.'), { path: 'self.data', partial: '' })
})

ok('only the part before the cursor on that line counts', () => {
  assert.deepEqual(parseMember('x = np.ar'), { path: 'np', partial: 'ar' })
})

ok('a number is not a name', () => {
  assert.equal(parseMember('1.5'), null)
  assert.equal(parseMember('3.'), null)
})

ok('a call or an index is not a name, so it is never looked up', () => {
  assert.equal(parseMember('foo().'), null)
  assert.equal(parseMember('items[0].'), null)
  assert.equal(parseMember('"text".'), null)
})

ok('a dot with nothing before it is not a name', () => {
  assert.equal(parseMember('.'), null)
  assert.equal(parseMember(''), null)
})

ok('a space before the dot breaks the chain', () => {
  assert.equal(parseMember('np .'), null)
})

ok('an assignment is not confused with an attribute', () => {
  assert.equal(parseMember('np ='), null)
})

ok('the same chain the kernel will accept, and nothing else', () => {
  assert.equal(ATTRS_PATH.test('np'), true)
  assert.equal(ATTRS_PATH.test('np.random'), true)
  assert.equal(ATTRS_PATH.test('np.'), false)
  assert.equal(ATTRS_PATH.test('foo()'), false)
  assert.equal(ATTRS_PATH.test('1np'), false)
  assert.equal(ATTRS_PATH.test('np; import os'), false)
  assert.equal(ATTRS_PATH.test("np.__class__.__init__"), true)
})

ok('dunders are held back until asked for', () => {
  const names = ['__init__', '__version__', '_private', 'array', 'zeros']
  assert.deepEqual(visibleAttrs(names, ''), ['array', 'zeros'])
  assert.deepEqual(visibleAttrs(names, '_'), ['__init__', '__version__', '_private'])
})

ok('matching the partial is CodeMirror\'s job, not ours — it can be fuzzy', () => {
  // `ar` here would filter to `array` in the popup; we hand over both and let
  // CodeMirror rank them, which is what makes `zrs` find `zeros` too.
  assert.deepEqual(visibleAttrs(['array', 'zeros'], 'ar'), ['array', 'zeros'])
})

ok('a member list that is not a list of names is ignored, not rendered', () => {
  assert.deepEqual(visibleAttrs(null), [])
  assert.deepEqual(visibleAttrs([1, 'ok', null, '__x__']), ['ok'])
})

console.log(`\nall ${checks} completion checks passed`)
