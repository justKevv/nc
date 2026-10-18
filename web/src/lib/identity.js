export const COLORS = [
  '#e05252', '#e08b2f', '#c9a227', '#3fa65c',
  '#2f8f83', '#2f7fe0', '#6b5ce0', '#c2418f',
]

/** Stable per-user colour so a student's cursor keeps the same hue all session. */
export function colorFor(id) {
  let h = 0
  for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return COLORS[h % COLORS.length]
}

const ADJECTIVES = ['swift', 'quiet', 'brave', 'clever', 'calm', 'bright', 'keen', 'lucky']
const ANIMALS = ['otter', 'falcon', 'lynx', 'heron', 'tapir', 'marten', 'ibis', 'shrike']

export function randomName() {
  const a = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)]
  const b = ANIMALS[Math.floor(Math.random() * ANIMALS.length)]
  return `${a} ${b}`
}

/** Identity persists across reloads so cursors stay recognisable. */
export function identity() {
  let saved
  try {
    saved = JSON.parse(localStorage.getItem('nbcollab:me') || 'null')
  } catch {}
  if (!saved?.id) {
    saved = { id: Math.random().toString(36).slice(2, 10), name: randomName() }
    localStorage.setItem('nbcollab:me', JSON.stringify(saved))
  }
  saved.color = colorFor(saved.id)
  return saved
}

export function setDisplayName(name) {
  const me = identity()
  me.name = name
  localStorage.setItem('nbcollab:me', JSON.stringify(me))
  return me
}

export function roomIdFromPath() {
  const m = location.pathname.match(/^\/r\/([\w-]+)/)
  return m ? m[1] : null
}

export function notebookUrl(roomId) {
  return `${location.origin}/r/${roomId}`
}
