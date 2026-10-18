/**
 * The ink layer's undo semantics, checked against real Yjs rather than a mock.
 *
 * The subtle part: an in-progress stroke is flushed to the shared document as a
 * preview with a custom transaction origin, and removed again when the stroke
 * ends. If that removal shares a transaction with the final stroke, Yjs undoes
 * the stroke by restoring the preview copy and nothing appears to happen.
 *
 * Run with: npm test
 */
import * as Y from 'yjs'

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

/** Mirrors the transaction pattern in web/src/lib/ink.js. */
function makeInk() {
  const doc = new Y.Doc()
  const drawings = doc.getArray('drawings')
  const undoManager = new Y.UndoManager(drawings, { captureTimeout: 0 })
  let liveId = null

  const dropPreview = () =>
    doc.transact(() => {
      for (let i = drawings.length - 1; i >= 0; i--) {
        if (drawings.get(i)?._liveId === liveId) {
          drawings.delete(i, 1)
          break
        }
      }
    }, 'live-stroke')

  return {
    doc,
    drawings,
    undoManager,
    begin: (id) => {
      liveId = id
    },
    preview: (type) => {
      dropPreview()
      doc.transact(() => drawings.push([{ type, width: 2.5, points: [{ x: 0, y: 0 }, { x: 1, y: 1 }], _liveId: liveId }]), 'live-stroke')
    },
    commit: (type) => {
      dropPreview()
      doc.transact(() => drawings.push([{ type, width: 2.5, points: [{ x: 0, y: 0 }, { x: 5, y: 5 }] }]), null)
      liveId = null
    },
  }
}

console.log('\nink undo')
{
  const ink = makeInk()

  ink.begin('live_1')
  ink.preview('pen')
  ink.preview('pen')
  check('a preview is visible to the room while drawing', () => eq(ink.drawings.length, 1))
  ink.commit('pen')
  check('committing replaces the preview instead of adding to it', () => eq(ink.drawings.length, 1))
  check('no preview markers survive the commit', () =>
    eq(ink.drawings.toArray().filter((s) => s._liveId).length, 0),
  )

  ink.begin('live_2')
  ink.commit('highlight')
  ink.begin('live_3')
  ink.commit('erase')
  check('three strokes are stored in draw order', () =>
    eq(ink.drawings.toArray().map((s) => s.type).join(','), 'pen,highlight,erase'),
  )

  ink.undoManager.undo()
  check('one undo removes exactly one stroke', () => eq(ink.drawings.length, 2))
  ink.undoManager.undo()
  check('a second undo removes the next stroke', () => eq(ink.drawings.length, 1))
  check('undo leaves no preview copies behind', () =>
    eq(ink.drawings.toArray().filter((s) => s._liveId).length, 0),
  )

  ink.undoManager.redo()
  check('redo puts the stroke back', () => eq(ink.drawings.length, 2))
  ink.undoManager.undo()
  ink.undoManager.undo()
  check('undoing past the first stroke is a no-op', () => eq(ink.drawings.length, 0))

  ink.begin('live_4')
  ink.commit('pen')
  ink.drawings.delete(0, ink.drawings.length)
  check('clearing leaves an empty list', () => eq(ink.drawings.length, 0))
  ink.undoManager.undo()
  check('clear is undoable', () => eq(ink.drawings.length, 1))
}

console.log('\nink sync')
{
  const ink = makeInk()
  ink.begin('live_1')
  ink.commit('pen')
  ink.begin('live_2')
  ink.commit('erase')

  // A second browser's document, updated the way the provider relays them.
  const peer = new Y.Doc()
  Y.applyUpdate(peer, Y.encodeStateAsUpdate(ink.doc), 'remote')

  check('a late peer receives every stroke', () => eq(peer.getArray('drawings').length, 2))
  check('a late peer receives the eraser stroke too', () =>
    eq(peer.getArray('drawings').get(1).type, 'erase'),
  )
}

console.log(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed ? 1 : 0)
