import fs from 'node:fs'
import path from 'node:path'

const DATA_DIR = process.env.NBCOLLAB_DATA || path.join(process.cwd(), 'data')
const ROOM_DIR = path.join(DATA_DIR, 'rooms')
const META_FILE = path.join(DATA_DIR, 'rooms.json')

fs.mkdirSync(ROOM_DIR, { recursive: true })

function readMeta() {
  try {
    return JSON.parse(fs.readFileSync(META_FILE, 'utf8'))
  } catch {
    return {}
  }
}

function writeMeta(meta) {
  const tmp = META_FILE + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(meta, null, 2))
  fs.renameSync(tmp, META_FILE)
}

export const meta = readMeta()

export function setRoomMeta(id, patch) {
  meta[id] = { ...(meta[id] || {}), ...patch, updated: Date.now() }
  writeMeta(meta)
  return meta[id]
}

export function getRoomMeta(id) {
  return meta[id] || null
}

export function listRooms() {
  return Object.entries(meta)
    .map(([id, m]) => ({ id, ...m }))
    .sort((a, b) => (b.updated || 0) - (a.updated || 0))
}

export function deleteRoomMeta(id) {
  delete meta[id]
  writeMeta(meta)
}

/**
 * Whether a room id is real. Rooms are no longer conjured into existence by a
 * connection (that would let a deleted room come back to life when someone
 * reloaded an old link), so the websocket upgrade asks this first. A `.ydoc`
 * with no metadata still counts — that is a room whose metadata was lost, and
 * refusing it would strand the students' work.
 */
export function roomExists(id) {
  return Boolean(meta[id]) || fs.existsSync(docPath(id))
}

const docPath = (id) => path.join(ROOM_DIR, `${id}.ydoc`)

export function loadDocState(id) {
  try {
    const buf = fs.readFileSync(docPath(id))
    return new Uint8Array(buf)
  } catch {
    return null
  }
}

export function saveDocState(id, state) {
  const tmp = docPath(id) + '.tmp'
  fs.writeFileSync(tmp, Buffer.from(state))
  fs.renameSync(tmp, docPath(id))
}

export function removeDocState(id) {
  try {
    fs.unlinkSync(docPath(id))
  } catch {}
}

/**
 * Delete every room's metadata and every saved notebook on this server.
 *
 * Enumerating files rather than ids on purpose: a `.ydoc` that lost its
 * metadata would otherwise survive a "delete everything" and reappear later.
 */
export function wipeAllRooms() {
  const registered = new Set(Object.keys(meta))
  for (const id of registered) delete meta[id]
  writeMeta(meta)

  let orphans = 0
  try {
    for (const name of fs.readdirSync(ROOM_DIR)) {
      if (!name.endsWith('.ydoc')) continue
      // A saved notebook with no metadata still counts as one deleted notebook.
      if (!registered.has(name.slice(0, -'.ydoc'.length))) orphans++
      try {
        fs.unlinkSync(path.join(ROOM_DIR, name))
      } catch {}
    }
  } catch {}

  return { deleted: registered.size + orphans, orphans }
}

export { DATA_DIR }
