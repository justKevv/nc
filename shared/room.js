/**
 * How a room comes into being, shared by both relays.
 *
 * A notebook that looks different depending on which relay served it would be
 * worse than either one alone, so the id shape, the first two cells and the
 * seed transaction live here.
 *
 * `yjs` is a dependency of both the server and the Worker bundle, and the
 * Worker's esbuild step inlines it, so the same document code runs in both.
 */
import * as Y from 'yjs'

/** `my-lesson-4f2a1` — readable in a URL, and unique enough for a classroom. */
export function newRoomId(name) {
  const slug = String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 24)
  return `${slug || 'room'}-${Math.random().toString(36).slice(2, 7)}`
}

/** Matches the on-disk shape Jupyter uses, so notebooks round-trip with .ipynb. */
export function defaultCells() {
  return [
    {
      type: 'markdown',
      source:
        '# Welcome\n\nThis notebook is shared with your class. Edit anything — everyone sees changes and live cursors in real time.\n\nUse **Shift+Enter** to run a cell, or press the play button.',
    },
    {
      type: 'code',
      source: 'print("hello from the browser!")\n\n# Python runs locally via Pyodide — no server needed.\n[n**2 for n in range(10)]',
    },
  ]
}

export function seedDoc(doc, title) {
  doc.transact(() => {
    const cells = doc.getArray('cells')
    for (const spec of defaultCells()) {
      const cell = new Y.Map()
      cell.set('id', Math.random().toString(36).slice(2, 10))
      cell.set('type', spec.type)
      const text = new Y.Text()
      text.insert(0, spec.source)
      cell.set('source', text)
      cells.push([cell])
    }
    doc.getMap('meta').set('title', title || 'Untitled notebook')
  })
}
