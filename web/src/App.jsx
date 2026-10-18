import { useEffect, useMemo, useState } from 'react'
import { identity, roomIdFromPath } from './lib/identity.js'
import { ErrorBoundary } from './components/ErrorBoundary.jsx'
import { Lobby } from './components/Lobby.jsx'
import { NotFound } from './components/NotFound.jsx'
import { Notebook } from './components/Notebook.jsx'

export default function App() {
  const roomId = useMemo(roomIdFromPath, [])
  const [me, setMe] = useState(() => identity())
  // 'open' | 'checking' | 'missing'. Only a link gets checked; the lobby is the
  // lobby regardless of what the server says.
  const [room, setRoom] = useState(roomId ? 'checking' : 'open')

  useEffect(() => {
    const handler = (e) => setMe(e.detail)
    window.addEventListener('nbcollab:identity', handler)
    return () => window.removeEventListener('nbcollab:identity', handler)
  }, [])

  /**
   * Ask the server whether this notebook exists before opening a socket on it.
   * Rooms are only created deliberately now, so a stale link should say so
   * instead of spinning up an empty notebook that nobody can find again.
   */
  useEffect(() => {
    if (!roomId) return
    let cancelled = false
    fetch(`/api/rooms/${roomId}`)
      .then((res) => {
        if (!cancelled) setRoom(res.ok ? 'open' : 'missing')
      })
      // Server unreachable is a different problem, and the notebook's own
      // connection status is a better place to report it than this screen.
      .catch(() => {
        if (!cancelled) setRoom('open')
      })
    return () => {
      cancelled = true
    }
  }, [roomId])

  return (
    <ErrorBoundary>
      {!roomId ? (
        <Lobby />
      ) : room === 'checking' ? null : room === 'missing' ? (
        <NotFound roomId={roomId} />
      ) : (
        <Notebook roomId={roomId} me={me} onGone={() => setRoom('missing')} />
      )}
    </ErrorBoundary>
  )
}
