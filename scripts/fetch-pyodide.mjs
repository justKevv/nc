/**
 * Vendors the Pyodide runtime (and the wheels the toolbar offers) into
 * vendor/pyodide/, so the browser can load Python from the same origin as the
 * app instead of a third-party CDN.
 *
 * Why bother: the CDN is the single most fragile part of a classroom tool.
 * When jsDelivr is slow or blocked, every student stares at "Downloading
 * Python runtime…" forever and nothing in the UI says why. A local copy is
 * fetched once, by you, and then every student gets it from your own server —
 * over the same tunnel they already loaded the app through.
 *
 *   npm run fetch:pyodide
 *
 * Add `--packages requests,scipy` to vendor more wheels.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DEST = path.join(__dirname, '..', 'vendor', 'pyodide')

const VERSION = process.env.PYODIDE_VERSION || '0.26.4'
const CDN = process.env.PYODIDE_CDN || `https://cdn.jsdelivr.net/pyodide/v${VERSION}/full/`

// The runtime itself. Everything loadPyodide touches before the interpreter is
// alive, so a partial copy is worse than none.
const CORE = [
  'pyodide.mjs',
  'pyodide.asm.js',
  'pyodide.asm.wasm',
  'python_stdlib.zip',
  'pyodide-lock.json',
]

// micropip is not optional: it is what `%pip install` and the + Package button
// go through, so a vendored runtime without it cannot install anything at all.
const DEFAULT_PACKAGES = ['micropip', 'numpy', 'pandas', 'matplotlib']

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]
}

const wanted = arg('packages', DEFAULT_PACKAGES.join(',')).split(',').map((s) => s.trim()).filter(Boolean)

async function download(name, { optional = false } = {}) {
  const url = `${CDN}${name}`
  const target = path.join(DEST, name)
  if (fs.existsSync(target) && fs.statSync(target).size > 0) {
    console.log(`  = ${name} (already here)`)
    return true
  }
  process.stdout.write(`  ↓ ${name} … `)
  try {
    const res = await fetch(url, { redirect: 'follow' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    if (!buf.length) throw new Error('empty response')
    fs.writeFileSync(target, buf)
    console.log(buf.length < 1e6 ? `${(buf.length / 1e3).toFixed(0)} kB` : `${(buf.length / 1e6).toFixed(1)} MB`)
    return true
  } catch (err) {
    console.log(optional ? `skipped (${err.message})` : `FAILED (${err.message})`)
    if (!optional) process.exitCode = 1
    return false
  }
}

/** Pull `names` plus everything they depend on, using the lock file. */
function resolveWheels(lock, names) {
  const files = new Set()
  const missing = []
  const seen = new Set()
  const queue = [...names]

  while (queue.length) {
    const name = queue.shift()
    if (seen.has(name)) continue
    seen.add(name)
    const pkg = lock.packages?.[name]
    if (!pkg) {
      missing.push(name)
      continue
    }
    files.add(pkg.file_name)
    for (const dep of pkg.depends || []) queue.push(dep)
  }
  return { files: [...files], missing }
}

async function main() {
  fs.mkdirSync(DEST, { recursive: true })
  console.log(`\n  pyodide ${VERSION}  →  ${path.relative(process.cwd(), DEST)}`)
  console.log(`  source ${CDN}\n`)

  for (const file of CORE) await download(file)

  const lockFile = path.join(DEST, 'pyodide-lock.json')
  if (fs.existsSync(lockFile)) {
    const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'))
    const { files, missing } = resolveWheels(lock, wanted)
    if (missing.length) {
      console.log(`\n  not in the lock file (they would come from PyPI at runtime): ${missing.join(', ')}`)
    }
    console.log(`\n  ${files.length} wheels for: ${wanted.join(', ')}`)
    for (const file of files) await download(file, { optional: true })
  }

  const total = fs
    .readdirSync(DEST)
    .reduce((sum, f) => sum + fs.statSync(path.join(DEST, f)).size, 0)
  console.log(`\n  done — ${(total / 1e6).toFixed(1)} MB in ${DEST}`)
  console.log('  the app serves this at /pyodide/ and prefers it over the CDN\n')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
