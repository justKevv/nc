import { useEffect, useState } from 'react'
import { notebookUrl, setDisplayName } from '../lib/identity.js'

const COMMON = ['numpy', 'pandas', 'matplotlib', 'scikit-learn', 'scipy', 'requests']

export function Toolbar({
  roomId,
  title,
  onTitle,
  peers,
  status,
  onImport,
  onExport,
  onRunAll,
  onRestart,
  kernel,
}) {
  const [pipOpen, setPipOpen] = useState(false)
  const [pkgs, setPkgs] = useState('')
  const [pipMsg, setPipMsg] = useState('')
  const [copied, setCopied] = useState('')
  const [editingName, setEditingName] = useState(false)
  const [nameDraft, setNameDraft] = useState('')

  const shareUrl = notebookUrl(roomId)

  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(''), 1600)
    return () => clearTimeout(t)
  }, [copied])

  async function copy(text, label) {
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      // Clipboard API needs a secure context; fall back to a prompt.
      window.prompt('Copy this:', text)
    }
    setCopied(label)
  }

  async function install() {
    const list = [...new Set(pkgs.split(/[\s,]+/).filter(Boolean))]
    if (!list.length) return
    setPipMsg(`Installing ${list.join(', ')}…`)
    try {
      const res = await kernel.current.pip(list, `pip-${Date.now()}`)
      setPipMsg(res.log.join(' ') === 'installed' ? `Installed ${list.join(', ')}` : res.log.join(' '))
      setPkgs('')
    } catch (err) {
      setPipMsg(err.message)
    }
  }

  return (
    <header className="toolbar">
      <div className="left">
        <span className="logo">📓</span>
        <input
          className="title"
          value={title}
          onChange={(e) => onTitle(e.target.value)}
          aria-label="Notebook title"
        />
      </div>

      <div className="right">
        <div className="peers" title={`${peers.length} connected`}>
          {peers.slice(0, 8).map((p) => (
            <span key={p.clientId} className="peer" style={{ background: p.color }} title={p.name}>
              {p.name.slice(0, 1).toUpperCase()}
            </span>
          ))}
          {peers.length > 8 && <span className="peer more">+{peers.length - 8}</span>}
        </div>

        <span className={`status ${status}`} title={`WebSocket ${status}`}>
          <i />
          {status}
        </span>

        <button onClick={onRunAll} title="Run every code cell top to bottom">
          ▶ Run all
        </button>

        <div className="menu-wrap">
          <button onClick={() => setPipOpen((v) => !v)}>+ Package</button>
          {pipOpen && (
            <div className="menu pip-menu">
              <label htmlFor="pkgs">Install with micropip</label>
              <input
                id="pkgs"
                value={pkgs}
                onChange={(e) => setPkgs(e.target.value)}
                placeholder="numpy pandas"
                autoFocus
              />
              <div className="chips">
                {COMMON.map((p) => (
                  <button key={p} className="chip" onClick={() => setPkgs((v) => `${v} ${p}`.trim())}>
                    {p}
                  </button>
                ))}
              </div>
              <div className="row">
                <button className="primary" onClick={install}>
                  Install
                </button>
                <button className="secondary" onClick={() => setPipOpen(false)}>
                  Close
                </button>
              </div>
              {pipMsg && <p className="small muted">{pipMsg}</p>}
            </div>
          )}
        </div>

        <button onClick={onRestart} title="Clear all variables, like restarting a kernel">
          ⟳ Restart
        </button>

        <button onClick={() => copy(shareUrl, 'link')} className="primary">
          {copied === 'link' ? 'Copied!' : 'Copy share link'}
        </button>

        <details className="menu-wrap">
          <summary>More</summary>
          <div className="menu">
            <button onClick={onImport}>Import .ipynb…</button>
            <button onClick={onExport}>Download .ipynb</button>
            <button
              onClick={() => copy(shareUrl.replace(/^https?:\/\//, ''), 'code')}
              title="Just the room code, for students to paste"
            >
              Copy room code
            </button>
            <button
              onClick={() => {
                const name = window.prompt('Your display name', nameDraft)
                if (name?.trim()) {
                  const me = setDisplayName(name.trim())
                  setNameDraft(me.name)
                  window.dispatchEvent(new CustomEvent('nbcollab:identity', { detail: me }))
                }
              }}
            >
              Change my name
            </button>
          </div>
        </details>
      </div>
    </header>
  )
}
