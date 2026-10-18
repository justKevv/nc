import * as Y from 'yjs'

export const cellList = (doc) => doc.getArray('cells')

export function readCell(map) {
  return {
    id: map.get('id'),
    type: map.get('type'),
    source: map.get('source')?.toString() ?? '',
  }
}

export function makeCell({ id, type = 'code', source = '' } = {}) {
  const map = new Y.Map()
  map.set('id', id || Math.random().toString(36).slice(2, 10))
  map.set('type', type)
  const text = new Y.Text()
  text.insert(0, source)
  map.set('source', text)
  return map
}

/** Insert after `index`, or append when index is -1. Returns the new position. */
export function insertCell(doc, index, spec) {
  const cells = cellList(doc)
  const at = index < 0 || index >= cells.length ? cells.length : index + 1
  doc.transact(() => cells.insert(at, [makeCell(spec)]))
  return at
}

export function deleteCell(doc, index) {
  const cells = cellList(doc)
  if (cells.length <= 1) return // never leave the notebook empty
  doc.transact(() => cells.delete(index, 1))
}

/**
 * Reorder by rebuilding the cell with its existing id. `to` is the position the
 * cell should end up at in the new list, which is what the ↑/↓ buttons mean by
 * "one step that way".
 *
 * The obvious version — slice the Y.Map out and insert the same instance back —
 * throws inside Yjs: a type that has been integrated once cannot be integrated
 * again, so re-inserting it dies in `YMap._integrate` and takes the whole
 * notebook render with it. Copying the text into a fresh map keeps the cell's
 * id, so React keys, per-cell outputs and the running-run bookkeeping all still
 * line up after the move.
 */
export function moveCell(doc, from, to) {
  const cells = cellList(doc)
  if (from === to || from < 0 || from >= cells.length) return

  const current = cells.get(from)
  if (!current) return
  // Out of range in either direction is not a move at all — this is what the
  // disabled ↑/↓ buttons on the first and last cell rely on.
  if (to < 0 || to >= cells.length) return
  const moved = {
    id: current.get('id'),
    type: current.get('type'),
    source: current.get('source')?.toString() ?? '',
  }

  doc.transact(() => {
    cells.delete(from, 1)
    cells.insert(to, [makeCell(moved)])
  })
}

export function setCellType(doc, index, type) {
  const cells = cellList(doc)
  const cell = cells.get(index)
  if (cell) doc.transact(() => cell.set('type', type))
}

export function setSource(doc, index, source) {
  const cells = cellList(doc)
  const cell = cells.get(index)
  const text = cell?.get('source')
  if (!text) return
  doc.transact(() => {
    text.delete(0, text.length)
    text.insert(0, source)
  })
}

export function setTitle(doc, title) {
  const meta = doc.getMap('meta')
  doc.transact(() => meta.set('title', title))
}

/* ----------------------------- .ipynb I/O ----------------------------- */

const asLines = (s) => `${s}${s.endsWith('\n') || s === '' ? '' : '\n'}`.split('\n')

export function cellsToIpynb(cells, title) {
  return {
    cells: cells.map((c) => ({
      cell_type: c.type === 'markdown' ? 'markdown' : 'code',
      metadata: {},
      source: asLines(c.source),
      ...(c.type === 'markdown' ? {} : { outputs: [], execution_count: null }),
    })),
    metadata: {
      kernelspec: { display_name: 'Python (Pyodide)', language: 'python', name: 'python' },
      language_info: { name: 'python', version: '3.12' },
      ...(title ? {} : {}),
    },
    nbformat: 4,
    nbformat_minor: 5,
  }
}

export function ipynbToCells(nb) {
  const cells = (nb?.cells || []).map((c) => ({
    type: c.cell_type === 'markdown' ? 'markdown' : 'code',
    source: Array.isArray(c.source) ? c.source.join('') : String(c.source ?? ''),
  }))
  return cells.length ? cells : [{ type: 'code', source: '' }]
}

export function downloadIpynb(cells, title) {
  const blob = new Blob([JSON.stringify(cellsToIpynb(cells, title), null, 1)], {
    type: 'application/x-ipynb+json',
  })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `${(title || 'notebook').replace(/[^\w-]+/g, '_')}.ipynb`
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}

export function parseIpynb(text) {
  try {
    const nb = JSON.parse(text)
    if (!Array.isArray(nb.cells)) throw new Error('not a notebook')
    return nb
  } catch (err) {
    throw new Error(`Could not read notebook: ${err.message}`)
  }
}
