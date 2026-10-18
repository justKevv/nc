import { useEffect, useRef, useState } from 'react'
import { latestRun } from '../lib/outputFeed.js'

/** Folds a long traceback into a readable summary with a disclosure toggle. */
function Traceback({ text }) {
  const [open, setOpen] = useState(false)
  const lines = text.trimEnd().split('\n')
  const head = lines.slice(0, 2).join('\n')

  return (
    <div className="traceback">
      {open ? (
        <>
          <pre>{text}</pre>
          <button className="link" onClick={() => setOpen(false)}>
            hide traceback
          </button>
        </>
      ) : (
        <>
          <pre>{head}</pre>
          <button className="link" onClick={() => setOpen(true)}>
            show full traceback ({lines.length} lines)
          </button>
        </>
      )}
    </div>
  )
}

/**
 * The result on screen. Yours has no name on it — an unlabelled block is you,
 * which is the common case — while a classmate's is tagged and carries a colour
 * rail down its left edge.
 */
function Entry({ output, remote }) {
  const ref = useRef(null)

  useEffect(() => {
    // Only your own run gets to move the page, and only if you are already
    // looking at it. Following a classmate's stream would yank the viewport away
    // from whatever you were reading -- and every chunk paid for a forced layout.
    if (remote) return
    const el = ref.current
    if (!el) return
    const box = el.getBoundingClientRect()
    const view = window.innerHeight || document.documentElement.clientHeight
    if (box.top < view && box.bottom > 0) el.scrollIntoView({ block: 'nearest' })
  }, [output, remote])

  const running = output.state === 'running'

  return (
    <div
      ref={ref}
      className={remote ? 'out-entry remote' : 'out-entry'}
      style={remote ? { borderLeftColor: remote.color } : undefined}
    >
      {(remote || running || typeof output.durationMs === 'number') && (
        <div className="who">
          {remote ? (
            <span className="who-name" style={{ color: remote.color }}>
              {remote.name}
            </span>
          ) : null}
          {running ? (
            <span className="muted">
              {remote ? 'is running' : 'running'}
              <span className="dots">…</span>
            </span>
          ) : typeof output.durationMs === 'number' ? (
            <span className="timing">{output.durationMs} ms</span>
          ) : null}
        </div>
      )}
      {output.stdout ? <pre className="stdout">{output.stdout}</pre> : null}
      {output.stderr ? <pre className="stderr">{output.stderr}</pre> : null}
      {output.error ? <Traceback text={output.error} /> : null}
      {output.repr ? <pre className="repr">{output.repr}</pre> : null}
      {output.html ? <div className="html" dangerouslySetInnerHTML={{ __html: output.html }} /> : null}
      {output.images?.map((src, i) => (
        <img key={i} src={src} alt={`figure ${i + 1}`} />
      ))}
    </div>
  )
}

/**
 * The output under a cell: the most recent run of it, by anyone. Running the
 * cell again — by you or by a classmate — replaces it rather than adding below.
 */
export function Output({ output, remotes = [] }) {
  const entry = latestRun({ mine: output, remotes })
  if (!entry) return null

  return (
    <div className="output">
      <Entry output={entry.output} remote={entry.remote} />
    </div>
  )
}
