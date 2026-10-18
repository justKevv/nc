/**
 * Completions for the notebook: Python keywords, the builtins students actually
 * reach for, the cell magics the kernel honours, every name defined anywhere
 * else in the notebook — and, after a dot, the members of whatever that name
 * actually is.
 *
 * That last one is the useful one in a class where cell 1 is `import pandas as
 * pd`: no word list can know that `pd.read_` means `read_csv`, but the
 * interpreter in the student's own browser can, because it is the same
 * interpreter that ran the import. See `getAttrs` below for the rules it plays
 * by — chiefly that it never starts an interpreter to answer a keystroke.
 */

import { ATTRS_PATH } from './attrs.js'

const KEYWORDS = [
  ['and', 'keyword'], ['as', 'keyword'], ['assert', 'keyword'], ['async', 'keyword'],
  ['await', 'keyword'], ['break', 'keyword'], ['class', 'keyword'], ['continue', 'keyword'],
  ['def', 'keyword'], ['del', 'keyword'], ['elif', 'keyword'], ['else', 'keyword'],
  ['except', 'keyword'], ['finally', 'keyword'], ['for', 'keyword'], ['from', 'keyword'],
  ['global', 'keyword'], ['if', 'keyword'], ['import', 'keyword'], ['in', 'keyword'],
  ['is', 'keyword'], ['lambda', 'keyword'], ['nonlocal', 'keyword'], ['not', 'keyword'],
  ['or', 'keyword'], ['pass', 'keyword'], ['raise', 'keyword'], ['return', 'keyword'],
  ['try', 'keyword'], ['while', 'keyword'], ['with', 'keyword'], ['yield', 'keyword'],
  ['match', 'keyword'], ['case', 'keyword'],
]

const BUILTINS = [
  ['abs', 'function'], ['all', 'function'], ['any', 'function'], ['bool', 'type'],
  ['dict', 'type'], ['divmod', 'function'], ['enumerate', 'function'],
  ['filter', 'function'], ['float', 'type'], ['format', 'value'], ['frozenset', 'type'],
  ['getattr', 'function'], ['hasattr', 'function'], ['hash', 'function'],
  ['hex', 'function'], ['id', 'function'], ['input', 'function'], ['int', 'type'],
  ['isinstance', 'function'], ['issubclass', 'function'], ['iter', 'function'],
  ['len', 'function'], ['list', 'type'], ['map', 'function'], ['max', 'function'],
  ['min', 'function'], ['next', 'function'], ['object', 'type'], ['oct', 'function'],
  ['open', 'function'], ['ord', 'function'], ['pow', 'function'], ['print', 'function'],
  ['range', 'function'], ['repr', 'function'], ['reversed', 'function'],
  ['round', 'function'], ['set', 'type'], ['setattr', 'function'], ['slice', 'type'],
  ['sorted', 'function'], ['str', 'type'], ['sum', 'function'], ['tuple', 'type'],
  ['type', 'type'], ['zip', 'function'],
  ['Exception', 'class'], ['ValueError', 'class'], ['TypeError', 'class'],
  ['KeyError', 'class'], ['IndexError', 'class'], ['ZeroDivisionError', 'class'],
  ['NameError', 'class'], ['AttributeError', 'class'], ['RuntimeError', 'class'],
  ['StopIteration', 'class'], ['AssertionError', 'class'],
  ['True', 'constant'], ['False', 'constant'], ['None', 'constant'], ['NotImplemented', 'constant'],
  ['__name__', 'dunder'], ['__file__', 'dunder'],
]

const MAGICS = [
  ['%pip install', 'install packages into your own browser'],
  ['%pip', 'install packages, e.g. %pip install pandas'],
]

/** Assignment, def, class, for and import targets — the names a cell defines. */
const DEFINES =
  /(?:^|\n)\s*(?:def|class)\s+([A-Za-z_]\w*)|(?:^|\n)\s*([A-Za-z_]\w*)\s*(?:=[^=]|\+=|-=|\*=|\/=)|(?:^|\n)\s*for\s+([A-Za-z_]\w*)\s+in\b|\bimport\s+([\w.]+)|\bfrom\s+[\w.]+\s+import\s+([\w,* ]+)/g
const CACHE_MS = 400

/**
 * The chain of names just before the cursor, and whatever has been typed since
 * the last dot: `np.ra` -> `{ path: 'np', partial: 'ra' }`.
 *
 * Strict on purpose. Anything that isn't a plain dotted name — a call, an index,
 * a number, a string — returns null, because the only thing it is used for is
 * asking the interpreter to look up a name.
 */
const TAIL = /([A-Za-z_]\w*(?:\.\w+)*)\.(\w*)$/

export function parseMember(text) {
  const match = TAIL.exec(text)
  if (!match) return null
  const [, path, partial] = match
  if (!ATTRS_PATH.test(path)) return null
  return { path, partial }
}

/**
 * Dunders are noise on the end of `np.`, so they are held back — unless you
 * typed an underscore yourself, which is how you ask for them.
 */
export function visibleAttrs(names, partial = '') {
  if (!Array.isArray(names)) return []
  const asked = partial.startsWith('_')
  return names.filter((n) => {
    if (typeof n !== 'string') return false
    return asked ? n.startsWith('_') : !n.startsWith('_')
  })
}

export function pythonCompletions(context, getSources, getAttrs) {
  // After a dot: ask the interpreter that is already running. `getAttrs` returns
  // null when there isn't one, which is the whole point — a keystroke must never
  // pull down a 10 MB interpreter just to offer a list.
  const typed = context.matchBefore(/[\w.$]*/)
  const parsed = typed ? parseMember(typed.text) : null
  if (parsed) {
    const lookup = getAttrs?.(parsed.path)
    if (!lookup) return null
    // CodeMirror accepts a promise here, so the rest of the editor stays live
    // while the worker answers.
    return Promise.resolve(lookup).then((names) => {
      const options = visibleAttrs(names, parsed.partial).map((label) => ({
        label,
        type: 'property',
      }))
      if (!options.length) return null
      return { from: typed.to - parsed.partial.length, options, validFor: /^\w*$/ }
    })
  }

  // Otherwise only a bare word in the middle of typing: not at the start of an
  // empty line, not inside a call that is already closed, and never after a dot
  // we could not resolve.
  const word = context.matchBefore(/[\w$]*/)
  if (!word || word.from === word.to) return null
  if (context.state.sliceDoc(word.to, word.to + 1) === '(') return null
  if (word.from > 0 && context.state.sliceDoc(word.from - 1, word.from) === '.') return null

  const options = [
    // Names from the rest of the notebook float to the top: in a shared
    // notebook, `prices` almost always means the variable a classmate defined.
    ...notebookNames(getSources).map((n) => ({ label: n.label, type: 'variable', detail: n.detail, boost: 40 })),
    ...BUILTINS.map(([label, type]) => ({ label, type })),
    ...KEYWORDS.map(([label, type]) => ({ label, type, boost: 0 })),
    ...MAGICS.map(([label, detail]) => ({ label, type: 'keyword', detail, boost: 20 })),
  ]

  // A plain result object is the completion-source contract; CodeMirror handles
  // ranking, filtering and rendering from here.
  return { from: word.from, options, validFor: /^[\w$]*$/ }
}

/**
 * Names defined elsewhere in the notebook. Recomputed at most a few times a
 * second: this runs on every keystroke, and a big notebook is a lot of regex.
 */
let cache = { at: 0, key: null, names: [] }

function notebookNames(getSources) {
  if (typeof getSources !== 'function') return []
  const sources = getSources()
  const key = sources.length + ':' + sources.map((s) => s.length).join(',')
  const now = Date.now()
  if (cache.key === key && now - cache.at < CACHE_MS) return cache.names

  const names = new Map()
  for (const source of sources) {
    DEFINES.lastIndex = 0
    let match
    while ((match = DEFINES.exec(source))) {
      const [, def, assign, forName, module, fromList] = match
      if (def) names.set(def, 'def/class')
      if (assign) names.set(assign, 'variable')
      if (forName) names.set(forName, 'loop variable')
      if (module) {
        names.set(module.split('.')[0], 'module')
        const as = new RegExp(`\\bimport\\s+${module}\\s+as\\s+([A-Za-z_]\\w*)`).exec(source)
        if (as) names.set(as[1], `import ${module}`)
      }
      if (fromList) {
        for (const part of fromList.split(',')) {
          const name = part.trim().split(/\s+as\s+/).pop()?.replace('*', '')
          if (name && /^[A-Za-z_]\w*$/.test(name)) names.set(name, 'import')
        }
      }
    }
  }

  cache = { at: now, key, names: [...names].map(([label, detail]) => ({ label, detail })) }
  return cache.names
}
