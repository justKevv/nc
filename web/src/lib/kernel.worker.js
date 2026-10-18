/**
 * Pyodide kernel. Runs Python entirely in the browser, so a class of 30 needs
 * no CPU on the host. State persists between cells in the global namespace,
 * the same way a Jupyter kernel does.
 */

const PYODIDE_VERSION = '0.26.4'
const CDN_VERSION = `v${PYODIDE_VERSION}`

/**
 * Where Python can come from, best first:
 *
 *   1. /pyodide/ — the copy vendored by `npm run fetch:pyodide` and served by
 *      this app's own server. Same origin, so it survives a blocked or slow CDN
 *      and never competes with the app download for bandwidth.
 *   2. jsDelivr — the usual home of the Pyodide runtime.
 *   3. unpkg — the same npm package, for when jsDelivr specifically is down.
 *
 * Each attempt is time-boxed. A browser waiting forever on a dead CDN looks
 * exactly like a slow download, and the student has no way to tell the
 * difference or do anything about it.
 */
const MIRRORS = [
  { name: 'this server', url: `${self.location.origin}/pyodide/`, versioned: false },
  { name: 'jsDelivr', url: `https://cdn.jsdelivr.net/pyodide/${CDN_VERSION}/full/`, versioned: true },
  { name: 'unpkg', url: `https://unpkg.com/pyodide@${PYODIDE_VERSION}/`, versioned: false },
]

// A cheap reachability check per mirror: fetch the 13 kB loader first. The
// runtime itself then gets no deadline at all — over a classroom tunnel 10 MB of
// WebAssembly legitimately takes a while, and cutting it off would push the
// student back onto the very CDN that was too slow in the first place.
const PROBE_TIMEOUT_MS = 8000
const INSTALL_TIMEOUT_MS = 300000

/**
 * Installing a wheel can mean a 25 MB download, so it gets a long leash — but a
 * progress line every few seconds, because "stuck" and "slow" look identical
 * from the student's chair.
 */
let micropipModule = null

async function installPackages(py, packages) {
  // Two separate steps, and both matter: loadPackage is async, and it resolves
  // to nothing useful — the module itself comes from pyimport. Skipping either
  // one leaves `.install` undefined and every install fails.
  await py.loadPackage('micropip')
  if (!micropipModule) micropipModule = py.pyimport('micropip')
  const micropip = micropipModule
  let last = 0
  return withTimeout(
    micropip.install(packages, (msg) => {
      const now = Date.now()
      if (now - last < 1500) return
      last = now
      post({ type: 'log', text: `installing: ${msg}` })
    }),
    INSTALL_TIMEOUT_MS,
    `installing ${packages.join(', ')}`,
  )
}

let pyodide = null
let loading = null
// The run currently executing, so its output is streamed to the cell rather
// than dumped in the kernel log.
let activeRunId = null
const runOut = new Map()

// One frame per print() is the whole cost of a chatty cell. It makes a relay
// that is not localhost — a tunnel, a teacher's laptop on school wifi — do
// thousands of round trips, and every frame is another React update for every
// classmate watching. Writes are held briefly and posted together instead.
const FLUSH_MS = 50
let pending = null
let flushTimer = null
let lastFlush = 0

function flushStream() {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  lastFlush = Date.now()
  if (!pending) return
  const { id, stream, text } = pending
  pending = null
  post({ type: 'stream', id, stream, text })
}

const STREAM_CAP = 200000

function emit(stream, text) {
  if (!activeRunId) {
    post({ type: 'log', text, stream })
    return
  }

  const acc = runOut.get(activeRunId) || { stdout: '', stderr: '' }

  // Cap what we hold: a runaway loop printing forever must not eat the tab —
  // and must not keep streaming at the rest of the class either. They get told
  // once that what they can see is the start of something longer.
  if (acc[stream].length >= STREAM_CAP) {
    if (!acc[stream + 'Cut']) {
      acc[stream + 'Cut'] = true
      runOut.set(activeRunId, acc)
      emitNow(stream, '\n… output truncated: more than ' + STREAM_CAP / 1000 + ' kB\n')
    }
    return
  }

  acc[stream] += text
  runOut.set(activeRunId, acc)
  emitNow(stream, text)
}

function emitNow(stream, text) {
  // stderr must not be reordered behind stdout, so a switch of stream flushes
  // what is held before starting the new run of text.
  if (pending && (pending.id !== activeRunId || pending.stream !== stream)) flushStream()
  if (pending) pending.text += text
  else pending = { id: activeRunId, stream, text }

  // The decision to hold or send is made here, at write time, rather than by a
  // timer: a cell sitting in time.sleep() or a long computation has the worker's
  // event loop blocked, so a timer would never fire and nothing would appear
  // until the cell finished. The timer below is only a backstop for text that
  // arrives after the last write.
  if (Date.now() - lastFlush >= FLUSH_MS) flushStream()
  else if (!flushTimer) flushTimer = setTimeout(flushStream, FLUSH_MS)
}

/**
 * Executes one cell. Mirrors Jupyter semantics: statements run in order and a
 * trailing bare expression is displayed as the cell's result. stdout/stderr and
 * matplotlib figures are captured so the UI can render them faithfully.
 */
const RUNNER = `
import sys, io, ast, json, base64, os, traceback

# The matplotlib wheel that Pyodide ships defaults to
# "module://matplotlib_pyodide.wasm_backend", a backend that paints onto an
# HTML5 canvas, by way of "from js import document". There is no DOM in a
# worker, so the very first plt.subplots() dies with ImportError: cannot import
# name 'document'. Agg renders to an in-memory buffer instead, which is what
# _nb_capture_figures() needs. Set before any user code so it also applies to a
# matplotlib installed later with %pip.
os.environ["MPLBACKEND"] = "agg"

def _nb_capture_figures():
    plt = sys.modules.get("matplotlib.pyplot")
    if plt is None:
        return []
    images = []
    for num in plt.get_fignums():
        fig = plt.figure(num)
        buf = io.BytesIO()
        fig.savefig(buf, format="png", dpi=110, bbox_inches="tight")
        images.append("data:image/png;base64," + base64.b64encode(buf.getvalue()).decode())
    plt.close("all")
    return images

def _nb_run(src):
    # sys.stdout / sys.stderr are deliberately left alone: Pyodide's callbacks
    # fire on every write while the cell is still executing, which is what lets
    # the rest of the class watch output appear line by line. The strings here
    # are only used when a cell writes nothing at all.
    res = {"stdout": "", "stderr": "", "repr": None, "html": None,
           "images": [], "error": None}
    try:
        tree = ast.parse(src, "<cell>", "exec")
        body, last = tree.body, None
        if body and isinstance(body[-1], ast.Expr):
            last = ast.Expression(body[-1].value)
            body = body[:-1]
        if body:
            exec(compile(ast.Module(body=body, type_ignores=[]), "<cell>", "exec"),
                 globals(), globals())
        if last is not None:
            value = eval(compile(last, "<cell>", "eval"), globals(), globals())
            if value is not None:
                res["repr"] = repr(value)
                html = getattr(value, "_repr_html_", None)
                if callable(html):
                    try:
                        res["html"] = html()
                    except Exception:
                        pass
        res["images"] = _nb_capture_figures()
    except BaseException:
        res["error"] = traceback.format_exc()
        try:
            res["images"] = _nb_capture_figures()
        except Exception:
            pass
    return json.dumps(res)

def _nb_attrs(path):
    """The members of a name the student has already defined, for np.-style
    completion. Only a plain dotted name is resolved -- never a call, an index or
    an operator -- so asking for the members of something cannot run it."""
    import json
    parts = path.split(".")
    if not parts or not parts[0].isidentifier():
        return json.dumps([])
    ns = globals()
    if parts[0] not in ns:
        return json.dumps([])
    obj = ns[parts[0]]
    for part in parts[1:]:
        if not part.isidentifier():
            return json.dumps([])
        try:
            obj = getattr(obj, part)
        except Exception:
            return json.dumps([])
    try:
        return json.dumps([n for n in dir(obj) if isinstance(n, str)])
    except Exception:
        return json.dumps([])

def _nb_restart():
    """Clear user variables the way restarting a Jupyter kernel would."""
    import gc
    ns = sys.modules["__main__"].__dict__
    for name in [n for n in list(ns) if n not in _NB_BASELINE]:
        ns.pop(name, None)
    gc.collect()

# Names that existed when the kernel booted. Anything a student defines after
# this point is fair game for _nb_restart() to remove.
_NB_BASELINE = set(sys.modules["__main__"].__dict__) | {
    "_nb_run", "_nb_restart", "_nb_capture_figures", "_nb_attrs",
    "_NB_BASELINE", "In", "Out",
}
`

const withTimeout = (promise, ms, what) =>
  Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${what} took longer than ${ms / 1000}s`)), ms),
    ),
  ])

async function probe(mirror) {
  const res = await withTimeout(
    fetch(`${mirror.url}pyodide.mjs`, { method: 'GET' }),
    PROBE_TIMEOUT_MS,
    `${mirror.name} did not answer`,
  )
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  // A host that answers every path with the app's index.html — a static host
  // with a single-page fallback, or a deployment that simply has no vendored
  // runtime — replies 200 here. Taking that for the runtime means importing HTML
  // as a module and failing with a syntax error instead of moving on to the next
  // mirror, so the reply has to actually look like JavaScript.
  const type = res.headers.get('content-type') || ''
  if (!/javascript|ecmascript/i.test(type)) {
    throw new Error(`not the runtime (${type || 'no content-type'})`)
  }
  if (mirror.versioned === false) {
    // Cheap sanity check that this is a loader and not a stub: Pyodide's is tens
    // of kB, and a single-page fallback is not.
    const body = await res.text()
    if (body.length < 1000) throw new Error(`not the runtime (${body.length} bytes)`)
  }
}

async function loadFrom(mirror) {
  const { loadPyodide } = await import(/* @vite-ignore */ `${mirror.url}pyodide.mjs`)
  return loadPyodide({
    indexURL: mirror.url,
    stdout: (t) => emit('stdout', t),
    stderr: (t) => emit('stderr', t),
  })
}

async function boot() {
  if (pyodide) return pyodide
  if (loading) return loading
  loading = (async () => {
    const problems = []
    for (const mirror of MIRRORS) {
      try {
        await probe(mirror)
        post({ type: 'log', text: `Loading Python from ${mirror.name}…` })
        pyodide = await loadFrom(mirror)
        await pyodide.runPythonAsync(RUNNER)
        await pyodide.loadPackage('micropip')
        post({ type: 'ready', version: pyodide.version, source: mirror.name })
        return pyodide
      } catch (err) {
        const why = String(err?.message || err)
        problems.push(`${mirror.name}: ${why}`)
        pyodide = null
        post({ type: 'log', text: `${mirror.name} failed — ${why}`, stream: 'stderr' })
      }
    }
    // Nothing left to try: say so, instead of leaving the message frozen.
    post({ type: 'boot-failed', problems })
    throw new Error('Could not load Python from any source')
  })().catch((err) => {
    loading = null // allow a retry
    throw err
  })
  return loading
}

const post = (msg) => self.postMessage(msg)

self.onmessage = async (ev) => {
  const msg = ev.data
  try {
    // Answered before boot() on purpose. Completion has to be free of side
    // effects: typing a dot on a page where nobody has run anything must not
    // start a 10 MB interpreter download, so with no interpreter there is
    // simply nothing to suggest.
    if (msg.type === 'attrs') {
      if (!pyodide) {
        post({ type: 'attrs', id: msg.id, names: null })
        return
      }
      post({ type: 'attrs', id: msg.id, names: JSON.parse(pyodide.runPython(`_nb_attrs(${JSON.stringify(msg.path)})`)) })
      return
    }

    const py = await boot()

    if (msg.type === 'run') {
      const started = Date.now()
      post({ type: 'status', id: msg.id, state: 'busy' })
      activeRunId = msg.id
      runOut.set(msg.id, { stdout: '', stderr: '' })

      // `%pip install foo bar` as a cell line is Jupyter muscle memory, so we
      // honour it instead of making students click through the toolbar.
      const magic = /^\s*%pip\s+install\s+([^\n]+)\n?/.exec(msg.source)
      let prefix = ''
      let source = msg.source

      if (magic) {
        const packages = magic[1].trim().split(/\s+/)
        source = msg.source.slice(magic[0].length)
        try {
          await installPackages(py, packages)
          prefix = `Installed: ${packages.join(', ')}\n`
        } catch (err) {
          flushStream()
          post({
            type: 'result',
            id: msg.id,
            stdout: '',
            stderr: '',
            error: `Could not install ${packages.join(', ')}\n\n${err.message || err}`,
            repr: null,
            html: null,
            images: [],
            durationMs: Date.now() - started,
          })
          post({ type: 'status', id: msg.id, state: 'idle' })
          activeRunId = null
          runOut.delete(msg.id)
          return
        }
      }

      const raw = py.globals.get('_nb_run')(source)
      flushStream()
      const result = JSON.parse(raw)
      // Whatever the streaming callbacks collected is the authoritative stdout.
      const streamed = runOut.get(msg.id) || { stdout: '', stderr: '' }
      result.stdout = prefix + streamed.stdout + result.stdout
      result.stderr = streamed.stderr + result.stderr
      post({
        type: 'result',
        id: msg.id,
        ...result,
        durationMs: Date.now() - started,
      })
      post({ type: 'status', id: msg.id, state: 'idle' })
      activeRunId = null
      runOut.delete(msg.id)
      return
    }

    if (msg.type === 'pip') {
      post({ type: 'status', id: msg.id, state: 'busy' })
      activeRunId = msg.id
      runOut.set(msg.id, { stdout: '', stderr: '' })
      const log = []
      await installPackages(py, msg.packages).then(
        () => log.push('installed'),
        (e) => log.push(String(e.message || e)),
      )
      flushStream()
      post({ type: 'pip-result', id: msg.id, log, packages: msg.packages })
      post({ type: 'status', id: msg.id, state: 'idle' })
      activeRunId = null
      runOut.delete(msg.id)
      return
    }

    if (msg.type === 'restart') {
      py.globals.get('_nb_restart')()
      post({ type: 'restarted' })
      return
    }
  } catch (err) {
    post({ type: 'fatal', message: String(err?.message || err) })
  }
}
