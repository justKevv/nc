import { notebookUrl } from '../lib/identity.js'

/**
 * Shown for a link to a notebook that isn't on the server — usually because the
 * teacher cleared the server between classes, which makes old links stop
 * working by design.
 */
export function NotFound({ roomId }) {
  return (
    <div className="lobby">
      <div className="lobby-card">
        <h1>
          <span className="logo">📓</span> Notebook not found
        </h1>
        <p className="tagline">
          There is no notebook <code>{roomId}</code> on this server. It may have been
          deleted, or the link may have a typo.
        </p>
        <p>
          <a className="button primary" href="/">
            Start or open a notebook
          </a>
        </p>
        <p className="muted small">
          If your teacher just cleared the server, this is expected: create a new notebook
          and share its link.
        </p>
      </div>
    </div>
  )
}
