/**
 * The Cloudflare Worker: static app, lobby API, and the door to a room.
 *
 * This is the cloud twin of `server/index.js`. It serves the same built app, the
 * same `/api/rooms` surface and the same `/ws/rooms/:id` socket, so the browser
 * cannot tell the two apart — the only difference is that a socket is handed to
 * the Durable Object for that room instead of to an object in a Node process.
 *
 * Two Durable Objects do the stateful work:
 *   - RoomsIndex (one, by a fixed name) owns the lobby list.
 *   - RoomServer (one per notebook) owns the document and the sockets.
 * There is deliberately no KV: see the note at the top of rooms-index.js.
 */
import { newRoomId } from '../shared/room.js'
import { indexCall, indexStub } from './rooms-index.js'

export { RoomServer } from './room.js'
export { RoomsIndex } from './rooms-index.js'

export default {
  async fetch(request, env) {
    const url = new URL(request.url)

    if (url.pathname.startsWith('/api/')) return api(request, env, url)

    const room = url.pathname.match(/^\/ws\/rooms\/([\w-]+)\/?$/)
    if (room) return socket(request, env, room[1])

    // The Node server can hand out its vendored copy of Pyodide; the Worker has
    // no such directory, and saying so plainly is what lets the kernel fall
    // through to the CDN instead of downloading the app's index.html and
    // failing to parse it.
    if (url.pathname.startsWith('/pyodide/')) {
      return new Response('python runtime is not vendored on this deployment — the kernel uses the CDN', {
        status: 404,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      })
    }

    return env.ASSETS.fetch(request)
  },
}

/* ------------------------------------------------------------------ *
 * Lobby API — the same routes the Node server answers.
 * ------------------------------------------------------------------ */

async function api(request, env, url) {
  const allowReset = env.NBCOLLAB_ALLOW_RESET !== '0'
  const id = url.pathname.match(/^\/api\/rooms\/([\w-]+)$/)?.[1] || null

  if (url.pathname === '/api/rooms') {
    if (request.method === 'GET') {
      const listed = await (await indexCall(env, '/rooms')).json()
      return json({ rooms: listed.rooms || [], canReset: allowReset })
    }

    if (request.method === 'POST') {
      const body = await readJson(request)
      const name = String(body.name || 'Untitled notebook').trim().slice(0, 120) || 'Untitled notebook'
      const roomId = newRoomId(name)
      await indexCall(env, '/rooms', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: roomId, name }),
      })
      return json({ id: roomId, name }, 201)
    }

    if (request.method === 'DELETE') {
      if (!allowReset) {
        return json(
          { error: 'resetting is disabled on this deployment (NBCOLLAB_ALLOW_RESET=0)' },
          403,
        )
      }
      // Live rooms first, exactly as the Node server does it: closing their
      // sockets must not race a pending save back into storage.
      const listed = await (await indexCall(env, '/rooms')).json()
      const ids = (listed.rooms || []).map((room) => room.id)
      await Promise.all(ids.map((roomId) => wipeRoom(env, roomId)))
      const wiped = await (await indexCall(env, '/rooms', { method: 'DELETE' })).json()
      return json({ deleted: wiped.deleted || 0 })
    }
  }

  if (id) {
    if (request.method === 'GET') {
      const found = await indexCall(env, `/rooms/${id}`)
      return found.status === 404 ? json({ error: 'no such room' }, 404) : json(await found.json())
    }
    if (request.method === 'PATCH') {
      const name = String((await readJson(request)).name || '').trim().slice(0, 120)
      if (!name) return json({ error: 'name required' }, 400)
      const patched = await indexCall(env, `/rooms/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      return patched.status === 404 ? json({ error: 'no such room' }, 404) : json(await patched.json())
    }
  }

  return json({ error: 'not found' }, 404)
}

/* ------------------------------------------------------------------ *
 * Sockets
 * ------------------------------------------------------------------ */

async function socket(request, env, roomId) {
  // Refusing an unknown id is what makes "delete all notebooks" stick: without
  // this, anyone opening an old link would recreate a blank room.
  const found = await indexCall(env, `/rooms/${roomId}`)
  if (found.status === 404) return json({ error: 'no such room' }, 404)
  return roomStub(env, roomId).fetch(request)
}

export function roomStub(env, roomId) {
  return env.ROOMS.get(env.ROOMS.idFromName(roomId))
}

function wipeRoom(env, roomId) {
  return roomStub(env, roomId).fetch(new Request('https://room.internal/wipe', { method: 'POST' }))
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

async function readJson(request) {
  try {
    return (await request.json()) || {}
  } catch {
    return {}
  }
}
