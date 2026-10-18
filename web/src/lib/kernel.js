import WorkerCtor from './kernel.worker.js?worker'
import { ATTRS_PATH } from './attrs.js'

/**
 * Promise-based wrapper around the Pyodide worker. Cells are queued so two
 * Shift+Enters never race inside the single-threaded interpreter, and each run
 * reports busy/idle so the cell can show a spinner.
 *
 * The worker is spawned lazily, on the first run or pip install. Booting it
 * eagerly meant every page load started a ~10 MB Python download nobody might
 * need, and React's StrictMode double-mount tore down and recreated a
 * half-booted interpreter for nobody.
 */
export function createKernel({ onLog, onStatus, onRestart, onStream, onBootFailed } = {}) {
  const pending = new Map()
  const queue = []
  let worker = null
  let draining = false
  let readyDeferred = null
  let isReady = false

  // Members of things students have defined, for `np.` style completions. Keyed
  // by name, dropped whenever a run could have changed what those names are.
  const attrs = new Map()
  const attrsInFlight = new Map()

  const handleMessage = (ev) => {
    const msg = ev.data
    switch (msg.type) {
      case 'ready':
        isReady = true
        readyDeferred?.resolve()
        break
      case 'log':
        onLog?.(msg)
        break
      case 'stream':
        // A piece of output produced while the cell is still executing.
        onStream?.(msg)
        break
      case 'status':
        onStatus?.(msg)
        break
      case 'attrs':
      case 'result':
      case 'pip-result': {
        // Resolve with the payload only. The routing fields are not part of the
        // result, and a stray `type` here used to ride along into the relay
        // envelope and get every finished run dropped by the server.
        const { type, id, ...payload } = msg
        pending.get(id)?.resolve(payload)
        pending.delete(id)
        break
      }
      case 'restarted':
        attrs.clear()
        onRestart?.()
        break
      case 'boot-failed':
        // Every mirror was tried; the UI offers a retry rather than freezing.
        isReady = false
        readyDeferred = null
        onBootFailed?.(msg.problems || [])
        break
      case 'fatal':
        pending.get(msg.id)?.reject(new Error(msg.message))
        pending.delete(msg.id)
        break
    }
  }

  const handleError = (e) => {
    const err = new Error(e.message || 'kernel crashed')
    for (const { reject } of pending.values()) reject(err)
    pending.clear()
  }

  function ensureWorker() {
    if (worker) return worker
    worker = new WorkerCtor()
    worker.onmessage = handleMessage
    worker.onerror = handleError
    return worker
  }

  function request(msg) {
    const w = ensureWorker()
    return new Promise((resolve, reject) => {
      pending.set(msg.id, { resolve, reject })
      w.postMessage(msg)
    })
  }

  async function drain() {
    if (draining) return
    draining = true
    while (queue.length) {
      const task = queue.shift()
      try {
        task.resolve(await request(task.msg))
      } catch (err) {
        task.reject(err)
      }
    }
    draining = false
  }

  return {
    /** Booting on demand: this starts the interpreter if it isn't up yet. */
    whenReady: () => {
      ensureWorker()
      if (isReady) return Promise.resolve()
      if (!readyDeferred) {
        let resolve
        const promise = new Promise((r) => (resolve = r))
        readyDeferred = { promise, resolve }
      }
      return readyDeferred.promise
    },

    run(source, id) {
      return new Promise((resolve, reject) => {
        // A run can rebind anything, so the cached member lists are stale the
        // moment it finishes.
        queue.push({ msg: { type: 'run', source, id }, resolve: (v) => (attrs.clear(), resolve(v)), reject })
        drain()
      })
    },

    pip(packages, id) {
      return new Promise((resolve, reject) => {
        queue.push({ msg: { type: 'pip', packages, id }, resolve: (v) => (attrs.clear(), resolve(v)), reject })
        drain()
      })
    },

    /**
     * The members of `path`, or null if there is nothing to ask. Async, and
     * deliberately lazy: it returns null rather than booting the interpreter,
     * because a keystroke that starts a 10 MB download is not a completion.
     */
    attrs(path) {
        if (!isReady) return null
      if (!ATTRS_PATH.test(path)) return null
      if (attrs.has(path)) return Promise.resolve(attrs.get(path))
      const inFlight = attrsInFlight.get(path)
      if (inFlight) return inFlight

      const query = request({ type: 'attrs', id: nextQueryId(), path })
        .then(({ names }) => {
          const list = Array.isArray(names) ? names : []
          attrs.set(path, list)
          return list
        })
        .catch(() => [])
        .finally(() => attrsInFlight.delete(path))
      attrsInFlight.set(path, query)
      return query
    },

    restart() {
      attrs.clear()
      ensureWorker().postMessage({ type: 'restart' })
    },

    /**
     * Throw the worker away and start over. Worth a button when the network is
     * the problem: the next attempt may well pick a different mirror, or find
     * the local one, and none of that needs the student to reopen the tab.
     */
    retry() {
      worker?.terminate()
      worker = null
      isReady = false
      readyDeferred = null
      attrs.clear()
      return ensureWorker()
    },

    destroy() {
      worker?.terminate()
      worker = null
      isReady = false
      readyDeferred = null
      attrs.clear()
    },
  }
}

let counter = 0
export const nextRunId = () => `run-${++counter}`

let query = 0
const nextQueryId = () => `q-${++query}`
