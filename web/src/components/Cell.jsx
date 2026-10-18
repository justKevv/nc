import { useEffect, useMemo, useRef, useState } from 'react'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap, lineNumbers, highlightActiveLine } from '@codemirror/view'
import { defaultKeymap, history, indentWithTab } from '@codemirror/commands'
import { python } from '@codemirror/lang-python'
import { syntaxHighlighting, defaultHighlightStyle, indentUnit } from '@codemirror/language'
import { autocompletion, closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete'
import { yCollab } from 'y-codemirror.next'
import { marked } from 'marked'
import { pythonCompletions } from '../lib/completions.js'
import { Output } from './Output.jsx'

const theme = EditorView.theme({
  '&': { fontSize: '13.5px' },
  '.cm-scroller': {
    fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
    lineHeight: '1.55',
  },
  '&.cm-focused': { outline: 'none' },
})

const highlight = syntaxHighlighting(
  defaultHighlightStyle,
  { fallback: true },
)

export function Cell({
  index,
  cell,
  ymap,
  doc,
  total,
  awareness,
  output,
  remoteOutputs = [],
  getAttrs,
  busy,
  onRun,
  onInsert,
  onDelete,
  onMove,
  onToggleType,
  onType,
}) {
  const host = useRef(null)
  const view = useRef(null)
  const yText = useRef(null)
  const [focused, setFocused] = useState(false)

  // Keep the latest handlers in a ref so the editor is built exactly once —
  // rebuilding it would fight the shared Y.Text binding.
  const handlers = useRef({ onRun, onInsert, onToggleType })
  handlers.current = { onRun, onInsert, onToggleType }

  // Python completions in code cells only — offering them inside a markdown
  // cell is just noise. `getAttrs` is what answers `np.`; it returns null until
  // the kernel is up, so nothing is offered rather than a boot being started.
  const completionSource = useMemo(
    () => (context) =>
      ymap?.get('type') === 'code'
        ? pythonCompletions(
            context,
            () => doc.getArray('cells').toArray().map((m) => m.get('source')?.toString() ?? ''),
            getAttrs,
          )
        : null,
    [doc, ymap, getAttrs],
  )

  useEffect(() => {
    // Bound to this cell's own Y.Map, never to its position: reordering moves
    // the component in the DOM but must not tear down and rebuild the editor,
    // which used to blank the notebook when a cell was dragged past another.
    const shared = ymap?.get('source')
    if (!shared || !host.current) return
    yText.current = shared

    const state = EditorState.create({
      doc: shared.toString(),
      extensions: [
        lineNumbers(),
        highlightActiveLine(),
        history(),
        keymap.of([
          {
            key: 'Shift-Enter',
            preventDefault: true,
            run: () => {
              handlers.current.onRun()
              handlers.current.onInsert({ type: 'code' })
              return true
            },
          },
          {
            key: 'Mod-Enter',
            preventDefault: true,
            run: () => (handlers.current.onRun(), true),
          },
          // Ahead of indentWithTab so a bracket pairs before the tab is eaten.
          ...closeBracketsKeymap,
          indentWithTab,
        ]),
        python(),
        highlight,
        theme,
        indentUnit.of('    '),
        // Typing an opening quote, bracket or paren types the closing one too,
        // and Backspace between a fresh pair removes both.
        closeBrackets(),
        autocompletion({ override: [completionSource] }),
        ...(awareness ? [yCollab(shared, awareness)] : []),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return
          // Yjs binding pushes this into the shared doc; nothing else to do.
        }),
        EditorView.lineWrapping,
        EditorView.domEventHandlers({
          focus: () => setFocused(true),
          blur: () => setFocused(false),
        }),
        // Standard editing shortcuts, listed last so they lose to our bindings.
        keymap.of(defaultKeymap),
      ],
    })

    host.current.replaceChildren()
    view.current = new EditorView({ state, parent: host.current })
    return () => {
      view.current?.destroy()
      view.current = null
      host.current?.replaceChildren()
    }
  }, [ymap, awareness, completionSource])

  // Read the type off the shared map so a flip by another student repaints this
  // cell even when React reuses the instance.
  const isCode = (ymap?.get('type') ?? cell.type) === 'code'

  return (
    <div className={`cell ${isCode ? 'code' : 'markdown'} ${busy ? 'busy' : ''}`} data-cell-index={index}>
      <div className="gutter">
        <span className="prompt">{isCode ? `In [${index + 1}]:` : 'md'}</span>
        {isCode && (
          <button className="run" onClick={onRun} title="Run cell (⌘↵)" disabled={busy}>
            {busy ? '⏳' : '▶'}
          </button>
        )}
      </div>

      <div className="cell-main">
        <div className="cell-toolbar">
          <select value={cell.type} onChange={(e) => onType(e.target.value)} title="Cell type">
            <option value="code">code</option>
            <option value="markdown">markdown</option>
          </select>
          <button onClick={() => onMove(-1)} disabled={index === 0} title="Move up">
            ↑
          </button>
          <button onClick={() => onMove(1)} disabled={index === total - 1} title="Move down">
            ↓
          </button>
          <button onClick={() => onInsert({ type: 'code' })} title="Insert cell below">
            +
          </button>
          <button onClick={onDelete} disabled={total <= 1} title="Delete cell">
            ✕
          </button>
        </div>

        <div className="editor" ref={host} />

        {!isCode && !focused && (
          <div
            className="md-preview"
            dangerouslySetInnerHTML={{ __html: marked.parse(cell.source || '*empty cell*') }}
          />
        )}

        {isCode && <Output output={output} remotes={remoteOutputs} />}
      </div>
    </div>
  )
}
