import { useCallback, useEffect, useMemo, useState } from 'react'
import { notebookUrl } from '../lib/identity.js'
import { clearMyRooms, forgetRoom, listMyRooms, rememberRoom } from '../lib/myRooms.js'
import { timeAgo } from '../lib/format.js'

export function Lobby() {
  const [name, setName] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [server, setServer] = useState({ status: 'loading', rooms: [], canReset: true })
  const [confirming, setConfirming] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/rooms')
      if (!res.ok) throw new Error(`server said ${res.status}`)
      const data = await res.json()
      setServer({ status: 'ready', rooms: data.rooms || [], canReset: data.canReset !== false })
    } catch (err) {
      setServer({ status: 'error', rooms: [], canReset: false, error: err.message })
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  /**
   * Ours, decorated with what the server knows. A room that is in our list but
   * no longer on the server was deleted — say so rather than offering a link
   * that leads nowhere.
   */
  const mine = useMemo(() => {
    const byId = new Map(server.rooms.map((r) => [r.id, r]))
    return listMyRooms()
      .map((local) => {
        const remote = byId.get(local.id)
        return {
          id: local.id,
          name: remote?.name || local.name,
          updated: remote?.updated || local.createdAt || null,
          gone: !remote,
        }
      })
      .sort((a, b) => (a.gone === b.gone ? (b.updated || 0) - (a.updated || 0) : a.gone ? 1 : -1))
  }, [server.rooms])

  async function create(e) {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      const clean = name.trim() || 'Untitled notebook'
      const res = await fetch('/api/rooms', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: clean }),
      })
      if (!res.ok) throw new Error(`server said ${res.status}`)
      const { id } = await res.json()
      // Remembered before navigating, so it is on this list when you come back.
      rememberRoom(id, clean)
      location.href = notebookUrl(id)
    } catch (err) {
      setError(err.message)
      setBusy(false)
    }
  }

  function join(e) {
    e.preventDefault()
    const clean = code.trim().replace(/^.*\/(?:r\/)?/, '').split(/[/?#]/)[0]
    if (clean) location.href = notebookUrl(clean)
  }

  async function deleteAll() {
    setBusy(true)
    setError('')
    try {
      const res = await fetch('/api/rooms', { method: 'DELETE' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `server said ${res.status}`)
      clearMyRooms()
      setConfirming(false)
      setNotice(`Deleted ${data.deleted} notebook${data.deleted === 1 ? '' : 's'}.`)
      await refresh()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="lobby">
      <div className="lobby-card">
        <h1>
          <span className="logo">📓</span> nbcollab
        </h1>
        <p className="tagline">
          Shared Jupyter notebooks that run Python in the browser. Everyone edits the same
          document, with live cursors and a shared pen.
        </p>

        <form onSubmit={create} className="lobby-form">
          <label htmlFor="nbname">Start a notebook</label>
          <input
            id="nbname"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. week-3 lists"
            autoFocus
          />
          <button type="submit" disabled={busy}>
            {busy ? 'Creating…' : 'Create notebook'}
          </button>
        </form>

        <div className="divider">or</div>

        <form onSubmit={join} className="lobby-form">
          <label htmlFor="code">Join with a code</label>
          <div className="row">
            <input
              id="code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="paste the code or link"
            />
            <button type="submit" className="secondary">
              Join
            </button>
          </div>
        </form>

        {error && <p className="error">{error}</p>}
        {notice && <p className="notice">{notice}</p>}
      </div>

      {mine.length > 0 && (
        <div className="lobby-card rooms">
          <h2>Your notebooks</h2>
          <p className="muted small">
            Notebooks started from this browser. They live on the server — anyone with the
            link can open them.
          </p>
          <ul className="room-list">
            {mine.map((room) => (
              <li key={room.id} className={room.gone ? 'gone' : ''}>
                <div className="room-main">
                  {room.gone ? (
                    <span className="room-name">{room.name}</span>
                  ) : (
                    <a className="room-name" href={notebookUrl(room.id)}>
                      {room.name}
                    </a>
                  )}
                  <span className="muted small">
                    {room.id}
                    {room.updated ? ` · ${room.gone ? 'deleted' : timeAgo(room.updated)}` : ''}
                  </span>
                </div>
                <div className="room-actions">
                  {!room.gone && (
                    <a className="button secondary" href={notebookUrl(room.id)}>
                      Open
                    </a>
                  )}
                  <button
                    className="link"
                    onClick={() => {
                      forgetRoom(room.id)
                      setNotice('')
                      refresh()
                    }}
                    title="Remove from this list. The notebook itself stays on the server."
                  >
                    {room.gone ? 'Remove' : 'Forget'}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {server.canReset && (
        <div className="lobby-card danger">
          {confirming ? (
            <>
              <h2>Delete every notebook?</h2>
              <p className="muted small">
                This deletes all {server.rooms.length} notebook
                {server.rooms.length === 1 ? '' : 's'} on this server, including everyone's
                saved work. Old links stop working. It cannot be undone.
              </p>
              <div className="row">
                <button className="danger-button" onClick={deleteAll} disabled={busy}>
                  {busy ? 'Deleting…' : 'Yes, delete everything'}
                </button>
                <button className="secondary" onClick={() => setConfirming(false)} disabled={busy}>
                  Cancel
                </button>
              </div>
            </>
          ) : (
            <>
              <h2>Reset</h2>
              <p className="muted small">Clear the server before the next class starts.</p>
              <button className="secondary" onClick={() => setConfirming(true)}>
                Delete all notebooks…
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
