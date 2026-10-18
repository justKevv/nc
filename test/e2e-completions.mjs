/**
 * Browser-level check of `np.` completion, which only exists in a real browser:
 * it asks the interpreter in the worker what the members of a name are.
 *
 * Two things must hold, and the second is the one that could quietly cost every
 * student 10 MB of download:
 *
 *   1. After a name has been defined in the notebook, typing `name.` offers that
 *      name's real members.
 *   2. Typing a dot must NEVER start the interpreter. Completion is answered
 *      from the interpreter if one is already running, and otherwise not at all.
 *
 *   npm start &            # or npm run dev
 *   npx playwright install chromium
 *   BASE=http://127.0.0.1:8787 node test/e2e-completions.mjs
 *
 * Playwright is not a dependency of this project; install it on demand.
 */
import { chromium } from 'playwright'

const BASE = process.env.BASE || 'http://127.0.0.1:8787'

let failures = 0
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `  ${detail}` : ''}`)
  if (!ok) failures++
}

const browser = await chromium.launch()
const room = await fetch(`${BASE}/api/rooms`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'completion check' }),
})
  .then((r) => r.json())
  .then((r) => r.id)

const requests = []
const ctx = await browser.newContext()
await ctx.addInitScript(() =>
  localStorage.setItem('nbcollab:me', JSON.stringify({ id: 'complete', name: 'teacher' })),
)
const page = await ctx.newPage()
page.on('request', (r) => requests.push(r.url()))
await page.goto(`${BASE}/r/${room}`)
await page.waitForSelector('.cm-content', { timeout: 30000 })
await page.waitForTimeout(500)

const CELL = '.cell .cm-content >> nth=1'
const pyodideHits = () => requests.filter((u) => /pyodide/i.test(u)).length

const popupItems = () =>
  page.$$eval('.cm-tooltip-autocomplete .cm-completionLabel', (els) => els.map((e) => e.textContent))

// Typing, so the completion popup can trigger on it.
const typeInCell = async (text) => {
  await clearCell()
  await page.keyboard.type(text, { delay: 30 })
}

// Writing code: insertText bypasses key handling entirely, so a newline cannot
// be swallowed by an open completion popup (typing `%pip` offers `%pip install`,
// and Enter accepts it).
const writeCell = async (text) => {
  await clearCell()
  await page.keyboard.insertText(text)
}

const clearCell = async () => {
  await page.click(CELL)
  await page.keyboard.press('Meta+A')
  await page.keyboard.press('Backspace')
  await page.keyboard.press('Escape')
}

/* ---- 1. a dot on a page where Python has not started ---- */
console.log('before the kernel is up')
await typeInCell('np.')
await page.waitForTimeout(1500)
check('typing a dot offers nothing when there is no interpreter', (await popupItems()).length === 0)
check('and does not start the interpreter', pyodideHits() === 0, `${pyodideHits()} pyodide requests`)

/* ---- 2. once the name exists in the running interpreter ---- */
console.log('after the kernel is up')
// numpy is not preloaded (only micropip is), so a cell has to install it first —
// which is what the README tells students to do anyway.
await writeCell('%pip install numpy\nimport numpy as np\nprint("ready")')
await page.click('.cell button.run')
// Wait for the *output* rather than the page text: `print("ready")` is visible
// in the editor as source, so matching the whole page would race the kernel and
// ask for completions while Python is still booting.
await page.waitForFunction(
  () => document.querySelector('.output')?.innerText.includes('ready'),
  null,
  { timeout: 120000 },
)
await page.waitForTimeout(500)

await typeInCell('np.zero')
await page.waitForTimeout(1200)
const items = await popupItems()
check('the members of a live object are offered', items.includes('zeros'), items.slice(0, 6).join(','))

await typeInCell('np.')
await page.waitForTimeout(1200)
const all = await popupItems()
check(
  'a bare dot lists the module, and no dunders',
  all.length > 0 && !all.some((n) => n.startsWith('__')),
  `${all.length} items`,
)

/* ---- 3. a name the interpreter has never heard of ---- */
await typeInCell('never_defined.')
await page.waitForTimeout(1200)
check('an unknown name offers nothing', (await popupItems()).length === 0)

await browser.close()
console.log(failures ? `\n${failures} failed` : '\nall completion checks passed')
process.exit(failures ? 1 : 0)
