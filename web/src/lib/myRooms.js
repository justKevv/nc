/**
 * The notebooks this browser started.
 *
 * There are no accounts here — identity is a name and a colour in
 * localStorage — so "notebooks I made" is remembered the same way. That is the
 * honest trade: your list follows this browser, not you, and it is stored on
 * the server so a student who opens it from elsewhere still gets in via a link.
 */
const KEY = 'nbcollab:mine'
const MAX = 100

function save(rooms) {
  try {
    localStorage.setItem(KEY, JSON.stringify(rooms))
  } catch {}
}

export function listMyRooms() {
  let raw
  try {
    raw = JSON.parse(localStorage.getItem(KEY) || '[]')
  } catch {
    return []
  }
  if (!Array.isArray(raw)) return []
  return raw.filter((r) => r && typeof r.id === 'string' && r.id)
}

/** Record a room as ours, newest first. Re-creating an id just moves it to the top. */
export function rememberRoom(id, name) {
  if (!id) return
  const rooms = listMyRooms().filter((r) => r.id !== id)
  rooms.unshift({ id, name: String(name || 'Untitled notebook'), createdAt: Date.now() })
  save(rooms.slice(0, MAX))
}

export function forgetRoom(id) {
  save(listMyRooms().filter((r) => r.id !== id))
}

export function clearMyRooms() {
  save([])
}
