import * as Y from 'yjs'
import * as awarenessProtocol from 'y-protocols/awareness'
import { loadDocState, saveDocState, setRoomMeta, getRoomMeta } from './store.js'

const SAVE_DEBOUNCE_MS = 1500

/** Matches the on-disk shape Jupyter uses, so notebooks round-trip with .ipynb. */
function defaultCells() {
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

function seedDoc(doc, title) {
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

class Room {
  constructor(id, title) {
    this.id = id
    this.doc = new Y.Doc()
    this.awareness = new awarenessProtocol.Awareness(this.doc)
    this.awareness.setLocalState(null)
    this.conns = new Set()
    this.saveTimer = null
    // Set when the room is wiped out from under its clients; see resetAllRooms.
    this.disposed = false

    const state = loadDocState(id)
    if (state) {
      Y.applyUpdate(this.doc, state, 'disk')
    } else {
      // A new room's title starts as the name it was created with, so the lobby
      // list and the notebook header agree from the first second.
      seedDoc(this.doc, title)
    }

    this.doc.on('update', () => this.scheduleSave())
  }

  scheduleSave() {
    if (this.disposed || this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      if (this.disposed) return
      try {
        saveDocState(this.id, Y.encodeStateAsUpdate(this.doc))
      } catch (err) {
        console.error(`[room ${this.id}] save failed:`, err.message)
      }
    }, SAVE_DEBOUNCE_MS)
  }

  save() {
    if (this.disposed) return
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    try {
      saveDocState(this.id, Y.encodeStateAsUpdate(this.doc))
    } catch (err) {
      console.error(`[room ${this.id}] save failed:`, err.message)
    }
  }

  /** Live collaborator list, derived from awareness so it needs no extra bookkeeping. */
  peers() {
    const out = []
    for (const [clientId, state] of this.awareness.getStates()) {
      if (!state?.user) continue
      out.push({ clientId, ...state.user, cursor: state.cursor ?? null })
    }
    return out.sort((a, b) => a.clientId - b.clientId)
  }

  /** Drop the document and disconnect everyone still editing it. */
  dispose() {
    if (this.disposed) return
    this.disposed = true
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    for (const conn of this.conns) {
      try {
        // 4004 so the browser can tell "this notebook is gone" apart from a
        // dropped connection, and stop its reconnect loop.
        conn.ws.close(4004, 'notebook deleted')
      } catch {}
    }
    this.conns.clear()
    this.awareness.destroy()
    this.doc.destroy()
  }
}

const rooms = new Map()

export function getRoom(id, title) {
  let room = rooms.get(id)
  if (!room) {
    room = new Room(id, title)
    rooms.set(id, room)
    if (!getRoomMeta(id)?.created) setRoomMeta(id, { created: Date.now() })
    console.log(`[room] created ${id}`)
  }
  room.conns.size === 0 && (room.lastActive = Date.now())
  return room
}

export function touchRoom(id) {
  setRoomMeta(id, {})
  const room = rooms.get(id)
  if (room) room.lastActive = Date.now()
}

/** Flush every room to disk — called on SIGINT so nothing is lost. */
export function saveAll() {
  for (const room of rooms.values()) room.save()
  console.log(`[room] flushed ${rooms.size} room(s) to disk`)
}

/**
 * Forget every in-memory room and kick everyone out of it. Files and metadata
 * are the caller's job (see store.wipeAllRooms) — this only handles the live
 * side, which has to happen first so a closing socket can't save a room back
 * onto disk after it has been deleted.
 */
export function resetAllRooms() {
  const ids = [...rooms.keys()]
  for (const room of rooms.values()) room.dispose()
  rooms.clear()
  return ids
}

export function roomCount() {
  return rooms.size
}
