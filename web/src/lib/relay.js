/**
 * Where the relay lives.
 *
 * Normally the app and the relay are the same origin — your laptop running
 * `npm run dev`, or a Cloudflare Worker serving the built app and answering the
 * socket itself — so this is empty and every URL is exactly the relative path it
 * has always been.
 *
 * `VITE_RELAY_BASE` is the escape hatch for when they are not: pointing a local
 * `vite` at a deployed Worker, or serving the bundle from somewhere that cannot
 * hold a socket. Set it to an origin such as `https://nbcollab.example.workers.dev`
 * and the API and socket follow it, while the app stays where it is.
 */
const BASE = (import.meta.env?.VITE_RELAY_BASE || '').replace(/\/+$/, '')

/** An HTTP path on the relay, e.g. relayUrl('/api/rooms'). */
export function relayUrl(path) {
  return `${BASE}${path}`
}

/** The same path as a WebSocket URL, e.g. relaySocketUrl('/ws/rooms/abc?x=1'). */
export function relaySocketUrl(path) {
  const base = BASE || `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`
  // `http(s)://` → `ws(s)://`, keeping any path prefix and the query string.
  return base.replace(/^http/, 'ws') + path
}
