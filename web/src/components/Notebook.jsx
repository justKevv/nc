import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as Y from 'yjs'
import { createProvider } from '../lib/collab.js'
import { createKernel, nextRunId } from '../lib/kernel.js'
import { useInkCanvas } from '../lib/ink.js'
import { applyRemoteMessage } from '../lib/outputFeed.js'
import { relayUrl } from '../lib/relay.js'

// How long incoming peer output is held before being folded into the feed.
// ~10 updates a second still reads as live, and it is the difference between a
// watcher doing thousands of renders and doing dozens.
const REMOTE_FLUSH_MS = 100
import {
  cellList,
  deleteCell,
  downloadIpynb,
  insertCell,
  ipynbToCells,
  moveCell,
  parseIpynb,
  readCell,
  setCellType,
} from '../lib/notebook.js'
import { Cell } from './Cell.jsx'
import { InkBar } from './InkBar.jsx'
import { Toolbar } from './Toolbar.jsx'

export function Notebook({ roomId, me, onGone }) {
  const doc = useMemo(() => new Y.Doc(), [roomId])

  // The raw Y.Maps are the state: they are stable identities, so a cell keeps
  // its editor (and its scroll position, and its live cursors) when reordered.
  const [cellMaps, setCellMaps] = useState([])
  const cells = useMemo(() => cellMaps.map(readCell), [cellMaps])
  const [peers, setPeers] = useState([])
  const [status, setStatus] = useState('connecting')
  const [outputs, setOutputs] = useState({})
  // What other students' kernels are printing, keyed `${userId}::${runId}`.
  const [remoteOutputs, setRemoteOutputs] = useState({})
  const [running, setRunning] = useState(() => new Set())
  const [kernelLog, setKernelLog] = useState([])
  const [bootError, setBootError] = useState(null)
  const [title, setTitle] = useState('Untitled notebook')

  const providerRef = useRef(null)
  const kernelRef = useRef(null)
  // The scroll container the ink overlay is pinned to and measured against.
  const notebookRef = useRef(null)
  // runId → cellId, so a streamed chunk can be attributed and forwarded.
  const runCells = useRef(new Map())
  // Pending "rename this room on the server" timer, see onTitle below.
  const titleSave = useRef(null)
  // Incoming peer output is buffered and applied on a timer: see applyRemoteOutput.
  const pendingRemote = useRef([])
  const remoteTimer = useRef(null)
  // Held in state so the editors get a real awareness object on first mount,
  // which is what wires up the other students' live cursors.
  const [awareness, setAwareness] = useState(null)

  /* ---- observe the shared document ---- */
  useEffect(() => {
    const refresh = () => {
      setCellMaps(cellList(doc).toArray())
      const t = doc.getMap('meta').get('title')
      if (t) setTitle(t)
    }
    cellList(doc).observeDeep(refresh)
    doc.getMap('meta').observe(refresh)
    refresh()
    return () => {
      cellList(doc).unobserveDeep(refresh)
      doc.getMap('meta').unobserve(refresh)
    }
  }, [doc])

  /* ---- connect ---- */
  useEffect(() => {
    const provider = createProvider({
      roomId,
      doc,
      user: me,
      onPeers: setPeers,
      onStatus: setStatus,
      onOutput: applyRemoteOutput,
      onGone,
    })
    providerRef.current = provider
    setAwareness(provider.awareness)
    return () => {
      provider.destroy()
      providerRef.current = null
      setAwareness(null)
    }
  }, [roomId, doc, me.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const ink = useInkCanvas(doc, notebookRef)

  useEffect(() => () => clearTimeout(titleSave.current), [])

  /* With a drawing tool armed, ⌘Z belongs to the ink, not to the editor. */
  useEffect(() => {
    if (!ink.armed) return
    const onKey = (e) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'z') return
      e.preventDefault()
      e.stopPropagation()
      if (e.shiftKey) ink.redo()
      else ink.undo()
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [ink.armed, ink.undo, ink.redo])

  /* ---- other students' output ---- */

  /**
   * Output is relayed, not shared state: each browser keeps its own kernel, so
   * a peer's result is only a picture of what their interpreter did.
   *
   * Keyed by *person*, not by run: someone pressing run five times during a
   * lesson leaves one entry behind, not five (outputFeed decides how a new run
   * replaces the old one). Entries are transient — nothing lands in the Yjs
   * document — and they stay until the page reloads.
   */
  const applyRemoteOutput = useCallback((msg) => {
    if (!msg?.runId || msg.userId === me.id) return
    // A whole class running chatty cells is a lot of frames landing on one
    // main thread. They are applied in order, but on a timer, so twenty
    // classmates streaming becomes one update per tick instead of one each.
    pendingRemote.current.push(msg)
    if (remoteTimer.current) return
    remoteTimer.current = setTimeout(() => {
      remoteTimer.current = null
      const batch = pendingRemote.current
      pendingRemote.current = []
      setRemoteOutputs((prev) =>
        // The arrow matters: passing applyRemoteMessage to reduce directly would
        // hand it the array index as its third argument, which is the "now" the
        // entry is dated with -- an index instead of a timestamp, so a peer's
        // run never looked newer than your own.
        batch.reduce((acc, msg) => applyRemoteMessage(acc, msg), prev),
      )
    }, REMOTE_FLUSH_MS)
  }, [me.id])

  /* ---- kernel ---- */
  useEffect(() => {
    const kernel = createKernel({
      onLog: (m) => setKernelLog((prev) => [...prev.slice(-40), m]),
      onRestart: () => {
        setOutputs({})
        setRemoteOutputs({})
      },
      // Chunks arrive while the cell is still executing: show them locally and
      // pass them on, so the rest of the class watches the output arrive too.
      onBootFailed: (problems) => setBootError(problems),
      onStream: ({ id, stream, text }) => {
        const cellId = runCells.current.get(id)
        setOutputs((prev) => {
          const out = prev[cellId] || { state: 'running' }
          const next = { ...out, [stream === 'stderr' ? 'stderr' : 'stdout']: (out[stream] || '') + text }
          return { ...prev, [cellId]: next }
        })
        if (cellId) {
          providerRef.current?.sendOutput({ event: 'chunk', runId: id, cellId, stream, text })
        }
      },
    })
    kernelRef.current = kernel
    return () => kernel.destroy?.()
  }, [])

  /**
   * What the editor asks when someone types a dot: "what are the members of
   * this name?" The kernel answers from the interpreter that has already run
   * their code, and returns null when there isn't one — a dot must never start
   * the interpreter, or typing `np.` would download Python.
   */
  const getAttrs = useCallback((path) => kernelRef.current?.attrs(path) ?? null, [])

  const runCell = useCallback(async (index) => {
    const cell = cells[index]
    const kernel = kernelRef.current
    if (!cell || !kernel || cell.type !== 'code') return
    const id = nextRunId()
    runCells.current.set(id, cell.id)
    setRunning((prev) => new Set(prev).add(cell.id))
    // Dated like a peer's run, so the output block can tell whose turn it is:
    // last one to press run owns it, whether that is you or a classmate.
    setOutputs((prev) => ({ ...prev, [cell.id]: { state: 'running', startedAt: Date.now() } }))
    const share = (msg) => providerRef.current?.sendOutput({ runId: id, cellId: cell.id, ...msg })
    share({ event: 'start' })
    try {
      const result = await kernel.run(cell.source, id)
      setOutputs((prev) => ({
        ...prev,
        [cell.id]: { ...prev[cell.id], ...result, state: 'done' },
      }))
      share({ event: 'result', ...result })
    } catch (err) {
      const error = String(err.message || err)
      setOutputs((prev) => ({
        ...prev,
        [cell.id]: { ...prev[cell.id], state: 'done', error },
      }))
      share({ event: 'result', stdout: '', stderr: '', error })
    } finally {
      runCells.current.delete(id)
      setRunning((prev) => {
        const next = new Set(prev)
        next.delete(cell.id)
        return next
      })
    }
  }, [cells])

  const runAll = useCallback(async () => {
    for (let i = 0; i < cells.length; i++) {
      if (cells[i].type === 'code') await runCell(i)
    }
  }, [cells, runCell])

  const insertAt = useCallback(
    (index, spec) => {
      insertCell(doc, index, spec)
      setTimeout(() => {
        document.querySelector(`[data-cell-index="${index + 1}"] .cm-content`)?.focus()
      }, 40)
    },
    [doc],
  )

  const handleImport = useCallback(async () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.ipynb,application/json'
    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file) return
      try {
        const specs = ipynbToCells(parseIpynb(await file.text()))
        doc.transact(() => {
          const list = cellList(doc)
          list.delete(0, list.length)
          for (const spec of specs) {
            const map = new Y.Map()
            map.set('id', Math.random().toString(36).slice(2, 10))
            map.set('type', spec.type)
            const text = new Y.Text()
            text.insert(0, spec.source)
            map.set('source', text)
            list.push([map])
          }
        })
      } catch (err) {
        window.alert(err.message)
      }
    }
    input.click()
  }, [doc])

  return (
    <div className="app">
      <Toolbar
        roomId={roomId}
        title={title}
        onTitle={(t) => {
          setTitle(t)
          doc.transact(() => doc.getMap('meta').set('title', t))
          // The lobby lists notebooks by the name the server holds, so a rename
          // here should follow you back to the main page. Debounced: the title
          // input fires per keystroke.
          clearTimeout(titleSave.current)
          titleSave.current = setTimeout(() => {
            fetch(relayUrl(`/api/rooms/${roomId}`), {
              method: 'PATCH',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ name: t }),
            }).catch(() => {})
          }, 800)
        }}
        peers={peers}
        status={status}
        onImport={handleImport}
        onExport={() => downloadIpynb(cells, title)}
        onRunAll={runAll}
        kernel={kernelRef}
        onRestart={() => {
          kernelRef.current?.restart()
          setOutputs({})
          setRemoteOutputs({})
        }}
      />

      <div className="body">
        <main className="notebook" ref={notebookRef}>
          <canvas
            ref={ink.canvasRef}
            className={ink.armed ? 'ink armed' : 'ink'}
            {...ink.handlers}
          />
          {cellMaps.map((ymap, index) => (
            <Cell
              key={ymap.get('id')}
              index={index}
              cell={cells[index]}
              ymap={ymap}
              doc={doc}
              total={cellMaps.length}
              awareness={awareness}
              output={outputs[ymap.get('id')]}
              remoteOutputs={Object.values(remoteOutputs).filter(
                (o) => o.cellId === ymap.get('id'),
              )}
              getAttrs={getAttrs}
              busy={running.has(ymap.get('id'))}
              onRun={() => runCell(index)}
              onInsert={(spec) => insertAt(index, spec)}
              onDelete={() => deleteCell(doc, index)}
              onMove={(dir) => moveCell(doc, index, index + dir)}
              onToggleType={() =>
                setCellType(doc, index, ymap.get('type') === 'code' ? 'markdown' : 'code')
              }
              onType={(t) => setCellType(doc, index, t)}
            />
          ))}
          <button className="add-cell" onClick={() => insertAt(cells.length - 1, { type: 'code' })}>
            + code cell
          </button>
          <button className="add-cell ghost" onClick={() => insertAt(cells.length - 1, { type: 'markdown' })}>
            + markdown cell
          </button>
        </main>

      </div>

      <InkBar ink={ink} />

      {(kernelLog.length > 0 || bootError) && (
        <footer className="kernel-log">
          {kernelLog.map((l, i) => (
            <div key={i} className={l.stream === 'stderr' ? 'err' : ''}>
              {l.text}
            </div>
          ))}
          {bootError && (
            <div className="boot-error">
              <div>
                Python could not be loaded{bootError.length ? `: ${bootError.join('; ')}` : '.'}
                {' '}If this room is on a slow or filtered network, run{' '}
                <code>npm run fetch:pyodide</code> on the host so the runtime is served locally.
              </div>
              <button onClick={() => kernelRef.current?.retry()}>Retry</button>
            </div>
          )}
        </footer>
      )}
    </div>
  )
}
