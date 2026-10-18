/**
 * Cell-list operations against a real Yjs document: the reorder path is the one
 * that touches every editor in the notebook, so it is worth pinning down.
 *
 * Run with: npm test
 */
import * as Y from 'yjs'
import {
  cellList,
  deleteCell,
  insertCell,
  makeCell,
  moveCell,
  readCell,
  setCellType,
} from '../web/src/lib/notebook.js'

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

const sources = (doc) => cellList(doc).toArray().map((m) => readCell(m).source)

function seeded() {
  const doc = new Y.Doc()
  const cells = cellList(doc)
  doc.transact(() => {
    for (const src of ['a', 'b', 'c', 'd']) {
      const map = makeCell({ type: 'code', source: src })
      cells.push([map])
    }
  })
  return doc
}

console.log('\ncell list')
{
  const doc = seeded()
  check('the seed reads back in order', () => eq(sources(doc).join(','), 'a,b,c,d'))

  // These are exactly what the ↑ and ↓ buttons ask for: one step that way.
  moveCell(doc, 0, 1)
  check('moving down one step swaps with the cell below', () =>
    eq(sources(doc).join(','), 'b,a,c,d'),
  )

  moveCell(doc, 3, 0)
  check('moving up to the top lands at the target position', () =>
    eq(sources(doc).join(','), 'd,b,a,c'),
  )

  // Reordering must keep every cell's id, so React keys, per-cell outputs and
  // the run bookkeeping all still point at the right cell afterwards.
  const idsBefore = cellList(doc).toArray().map((m) => m.get('id'))
  moveCell(doc, 2, 0)
  check('a move preserves every cell id', () =>
    eq(
      cellList(doc)
        .toArray()
        .map((m) => m.get('id'))
        .sort()
        .join(','),
      [...idsBefore].sort().join(','),
    ),
  )
  check('a move lands at the requested position', () => eq(sources(doc).join(','), 'a,d,b,c'))
  check('no duplicate ids appear', () =>
    eq(new Set(cellList(doc).toArray().map((m) => m.get('id'))).size, 4),
  )

  const before = sources(doc).join(',')
  moveCell(doc, 3, 4)
  check('moving the last cell down is a no-op', () => eq(sources(doc).join(','), before))
  moveCell(doc, 0, -1)
  check('moving the first cell up is a no-op', () => eq(sources(doc).join(','), before))
  moveCell(doc, 0, 0)
  check('moving a cell onto itself is a no-op', () => eq(sources(doc).join(','), before))

  insertCell(doc, 0, { type: 'code', source: 'new' })
  check('insert lands after the given index', () => eq(sources(doc)[1], 'new'))

  deleteCell(doc, 1)
  check('delete removes one cell', () => eq(sources(doc).join(','), 'a,d,b,c'))

  setCellType(doc, 0, 'markdown')
  check('a cell can be flipped to markdown', () =>
    eq(readCell(cellList(doc).get(0)).type, 'markdown'),
  )

  const single = new Y.Doc()
  cellList(single).push([makeCell({ source: 'only' })])
  deleteCell(single, 0)
  check('the notebook is never emptied', () => eq(cellList(single).length, 1))
}

console.log(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed ? 1 : 0)
