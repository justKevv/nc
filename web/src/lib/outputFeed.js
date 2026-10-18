/**
 * The output under a cell: one block, showing whoever ran the cell last, tagged
 * with their name when that isn't you.
 *
 * Keeping that logic here (rather than inside the components, where it would run
 * during a render) is deliberate: it is the part with the awkward cases — a peer
 * re-running while chunks of their previous run are still arriving, a peer
 * running the same source in a different cell — and it is testable as a result.
 * Per-person runs are still tracked (keyed by user) because that is what lets a
 * second run replace the first instead of mixing the two.
 */

const MAX_TEXT = 200000

/**
 * The wire envelope for a relayed output message now lives with the rest of the
 * contract in `shared/protocol.js`; re-exported here so this module stays the
 * one place the UI imports output handling from.
 */
export { outputEnvelope } from '../../../shared/protocol.js'

/** Does this entry have anything worth showing? */
export function isVisible(output) {
  if (!output) return false
  // "swift otter is running…" is information even before the text arrives.
  if (output.state === 'running') return true
  return Boolean(
    output.stdout ||
      output.stderr ||
      output.error ||
      output.repr ||
      output.html ||
      output.images?.length,
  )
}

/**
 * Fold one relayed output message into the map of peers' runs, keyed by user.
 *
 * A message from a run we haven't seen before clears that person's previous
 * result rather than appending to it: pressing run twice should leave one entry,
 * not two, and a stale chunk must never land in the new run's text.
 */
export function applyRemoteMessage(prev, msg, now = Date.now()) {
  if (!msg?.userId || !msg.runId) return prev

  const existing = prev[msg.userId]
  const sameRun = existing && existing.runId === msg.runId
  const current = sameRun
    ? existing
    : {
        userId: msg.userId,
        runId: msg.runId,
        cellId: msg.cellId,
        name: msg.name,
        color: msg.color,
        stdout: '',
        stderr: '',
        repr: null,
        html: null,
        images: [],
        error: null,
        state: 'running',
        startedAt: now,
      }

  const next = {
    ...current,
    at: now,
    // Follow the person if they run the cell elsewhere, so an entry is never
    // stranded under a cell they have moved on from.
    cellId: msg.cellId || current.cellId,
    name: msg.name || current.name,
    color: msg.color || current.color,
  }

  if (msg.event === 'chunk') {
    const field = msg.stream === 'stderr' ? 'stderr' : 'stdout'
    next[field] = ((next[field] || '') + msg.text).slice(-MAX_TEXT)
    next.state = 'running'
  } else if (msg.event === 'result' || msg.event === 'end') {
    Object.assign(next, {
      state: 'done',
      stdout: msg.stdout || '',
      stderr: msg.stderr || '',
      repr: msg.repr ?? null,
      html: msg.html ?? null,
      images: msg.images || [],
      error: msg.error ?? null,
      durationMs: msg.durationMs,
    })
  } else if (msg.event === 'start') {
    next.state = 'running'
  }

  return { ...prev, [msg.userId]: next }
}

/**
 * The one result a cell shows: whoever ran it last.
 *
 * The class shares a single output block rather than a stack of them. When
 * someone else runs, their result takes the block and is tagged with their name;
 * when you run, it becomes yours and the tag comes off. That is what makes it
 * read like one cell being worked on together instead of twenty answers piled
 * up.
 *
 * `startedAt` decides it, not the last update — otherwise a slow run that is
 * still streaming would hold the block against someone who pressed run after it.
 */
export function latestRun({ mine, remotes = [] }) {
  const candidates = []
  // Yours first, so an exact tie stays with your own run.
  if (mine) candidates.push({ output: mine, remote: null, startedAt: mine.startedAt || 0 })
  for (const entry of remotes) {
    candidates.push({
      output: entry,
      remote: entry.name ? { name: entry.name, color: entry.color } : null,
      startedAt: entry.startedAt || 0,
    })
  }

  let best = null
  for (const candidate of candidates) {
    if (!isVisible(candidate.output)) continue
    if (!best || candidate.startedAt > best.startedAt) best = candidate
  }
  return best
}
