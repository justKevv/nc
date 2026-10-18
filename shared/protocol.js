/**
 * The wire contract, in one place.
 *
 * Two relays speak it: the Node server in `server/` (what a teacher runs on
 * their own laptop) and the Durable Object in `worker/` (what runs on
 * Cloudflare). They must agree to the byte, or a class split across the two
 * would silently stop seeing each other — so the envelope, the size caps and
 * the output sanitising live here and nowhere else.
 *
 * Convention: `type` goes last in every envelope. A kernel result carries a
 * `type` field of its own, and when that won the merge the relay saw
 * `{"type":"result"}`, matched no case, and dropped every finished run.
 */

/**
 * Limits on what one browser may push through a relay. Generous for a real
 * classroom — a cell that prints a novel is truncated, not the whole session.
 */
export const OUTPUT_CAPS = {
  text: 32 * 1024, // one streamed chunk
  field: 128 * 1024, // stdout / stderr / traceback in a final result
  repr: 16 * 1024,
  html: 128 * 1024,
  image: 4 * 1024 * 1024,
  images: 4,
  chunksPerSecond: 250,
  // How much of a flooded stream is held while waiting for budget. Comfortably
  // more than a cell can legitimately produce (the runner itself stops at
  // 200 kB), so a burst is delayed rather than discarded.
  held: 256 * 1024,
}

export const OUTPUT_EVENTS = ['start', 'chunk', 'result', 'end']

export const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '')

/* ------------------------------------------------------------------ *
 * Base64 for Yjs binary updates.
 *
 * `btoa`/`atob` are available in the browser, in Node and in workerd, so one
 * implementation covers all three. Chunked because `String.fromCharCode` takes
 * an argument list, and a Yjs update can be a few hundred kB.
 * ------------------------------------------------------------------ */

const CHUNK = 0x8000

export function toBase64(u8) {
  let s = ''
  for (let i = 0; i < u8.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK))
  }
  return btoa(s)
}

/**
 * Strict on purpose: a frame whose update is not base64 is dropped rather than
 * turned into plausible-looking bytes that Yjs would then choke on. That choke
 * used to be an uncaught throw inside the socket handler, which takes the room
 * down with it.
 */
export function fromBase64(s) {
  if (typeof s !== 'string') return null
  try {
    const bin = atob(s)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ *
 * Envelopes
 * ------------------------------------------------------------------ */

export const syncMessage = (updateB64) => ({ type: 'sync', update_b64: updateB64 })
export const updateMessage = (updateB64) => ({ type: 'update', update_b64: updateB64 })
export const awarenessMessage = (updateB64) => ({ type: 'awareness', update_b64: updateB64 })
export const connectionMessage = ({ peers, docName }) => ({ type: 'connection', peers, docName })
export const pingMessage = (timestamp) => ({ type: 'ping', timestamp })
export const pongMessage = (timestamp) => ({ type: 'pong', timestamp })

/**
 * The envelope for a relayed output message. `type` goes last — see the note at
 * the top of this file.
 */
export const outputEnvelope = (msg) => ({ ...msg, type: 'output' })

/**
 * Rendering peer output means putting strings from another browser into the
 * DOM, so the one thing worth refusing is a script tag or an inline handler
 * hiding in a cell's HTML representation.
 */
export function stripHtml(html) {
  return html
    .replace(/<\s*(script|style|iframe|object|embed|link|meta)[\s\S]*?>/gi, '')
    .replace(/<\s*\/(?:script|style|iframe|object|embed|link|meta)\s*>/gi, '')
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src)\s*=\s*("|')?\s*javascript:[^"'\s>]*/gi, '$1="#"')
}

/**
 * Output is relayed, never interpreted — but it does come from a browser, so it
 * is trimmed, capped and stripped before it reaches the rest of the class. The
 * sender's identity comes from the connection, never from the payload: a client
 * that names itself is a classroom problem, not a security one, and stamping it
 * here means a peer can never impersonate another.
 *
 * Returns `null` for anything that is not a recognisable output event.
 */
export function sanitizeOutput(msg, who) {
  const event = OUTPUT_EVENTS.includes(msg.event) ? msg.event : null
  if (!event) return null

  const out = {
    type: 'output',
    event,
    cellId: str(msg.cellId, 64),
    runId: str(msg.runId, 64),
    userId: who.userId,
    name: who.name,
    color: who.color,
  }

  if (event === 'chunk') {
    out.stream = msg.stream === 'stderr' ? 'stderr' : 'stdout'
    out.text = str(msg.text, OUTPUT_CAPS.text)
    return out
  }

  if (event === 'result') {
    out.stdout = str(msg.stdout, OUTPUT_CAPS.field)
    out.stderr = str(msg.stderr, OUTPUT_CAPS.field)
    out.error = str(msg.error, OUTPUT_CAPS.field)
    out.repr = str(msg.repr, OUTPUT_CAPS.repr)
    out.durationMs = Number.isFinite(msg.durationMs) ? Math.min(msg.durationMs, 1e7) : null
    out.images = Array.isArray(msg.images)
      ? msg.images
          .slice(0, OUTPUT_CAPS.images)
          .filter(
            (src) =>
              typeof src === 'string' &&
              src.startsWith('data:image/') &&
              src.length <= OUTPUT_CAPS.image,
          )
      : []
    out.html = stripHtml(str(msg.html, OUTPUT_CAPS.html))
    return out
  }

  return out
}
