/**
 * The lobby list, as one Durable Object.
 *
 * A single instance, addressed by a fixed name, that owns the index of rooms:
 * which notebooks exist, what they are called and when they were last touched.
 * Everything the lobby does goes through it.
 *
 * Why a Durable Object rather than KV: KV reads are cached for up to a minute at
 * the edge, which means "delete every notebook, then start next lesson" can let
 * one of last lesson's links open a fresh, empty notebook for a while. A
 * classroom reset has to stick immediately, and a Durable Object is strongly
 * consistent. It also means deploying needs no namespace to be created first.
 *
 * Plain class with a `fetch` handler rather than JavaScript RPC, so the whole
 * thing can be driven from a test in Node with a stubbed storage.
 */

const PREFIX = 'room:'
const key = (id) => `${PREFIX}${id}`
const INDEX_NAME = 'index'

/**
 * The one index instance. `idFromName` is what pins it to a single, shared
 * object no matter which colo the request lands in.
 */
export function indexStub(env) {
  return env.ROOMS_INDEX.get(env.ROOMS_INDEX.idFromName(INDEX_NAME))
}

/** Ask the index something, from the Worker or from a room. */
export function indexCall(env, path, init) {
  return indexStub(env).fetch(new Request(`https://rooms.index${path}`, init))
}

export class RoomsIndex {
  constructor(ctx, env) {
    this.ctx = ctx
    this.env = env
  }

  async fetch(request) {
    const url = new URL(request.url)
    const path = url.pathname
    const id = path.match(/^\/rooms\/([\w-]+)$/)?.[1] || null

    if (path === '/rooms' && request.method === 'GET') {
      const entries = await this.ctx.storage.list({ prefix: PREFIX })
      const rooms = [...entries.values()].sort((a, b) => (b.updated || 0) - (a.updated || 0))
      return json({ rooms })
    }

    if (path === '/rooms' && request.method === 'POST') {
      const { id: newId, name } = await readJson(request)
      const meta = { id: newId, name, created: Date.now(), updated: Date.now() }
      await this.ctx.storage.put(key(newId), meta)
      return json(meta, 201)
    }

    if (path === '/rooms' && request.method === 'DELETE') {
      const entries = await this.ctx.storage.list({ prefix: PREFIX })
      const ids = [...entries.keys()].map((k) => k.slice(PREFIX.length))
      await this.ctx.storage.delete([...entries.keys()])
      return json({ deleted: ids.length, ids })
    }

    if (id) {
      const meta = await this.ctx.storage.get(key(id))
      if (request.method === 'GET') return meta ? json(meta) : json({ error: 'no such room' }, 404)
      if (request.method === 'PATCH') {
        const { name } = await readJson(request)
        if (!meta) return json({ error: 'no such room' }, 404)
        const next = { ...meta, name, updated: Date.now() }
        await this.ctx.storage.put(key(id), next)
        return json(next)
      }
    }

    return json({ error: 'not found' }, 404)
  }
}

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
