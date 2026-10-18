/**
 * Browser-level check of output sharing between a runner and a watcher.
 *
 * Two failures this guards against, both of which look like "it's so slow" from
 * the outside and neither of which is visible from a unit test:
 *
 *   1. A cell that prints thousands of lines in a second outran the relay's
 *      per-second budget. The excess was dropped, so the class saw a few hundred
 *      lines and then nothing, and the run never appeared to finish.
 *   2. Batching a cell's output on a timer made nothing appear until the cell
 *      was done, because a worker blocked in time.sleep() never runs its timers.
 *
 *   npm start &            # or npm run dev
 *   npx playwright install chromium
 *   BASE=http://127.0.0.1:8787 node test/e2e-stream.mjs
 *
 * Playwright is not a dependency of this project; install it on demand.
 */
import { chromium } from 'playwright'

const BASE = process.env.BASE || 'http://127.0.0.1:8787'
const BURST = Number(process.env.BURST || 3000)

let failures = 0
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `  ${detail}` : ''}`)
  if (!ok) failures++
}

const browser = await chromium.launch()
const seed = async (id, name) => {
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  await page.goto(BASE)
  await page.evaluate((me) => localStorage.setItem('nbcollab:me', JSON.stringify(me)), { id, name })
  return page
}

// Rooms are created through the API now (an unknown id is a 404 and the app
// shows "notebook not found"), so make one rather than inventing an id.
const room = await fetch(`${BASE}/api/rooms`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'stream check' }),
})
  .then((r) => r.json())
  .then((r) => r.id)

const runner = await seed('runner', 'teacher')
await runner.goto(`${BASE}/r/${room}`)
await runner.waitForSelector('.cm-content', { timeout: 30000 })
const watcher = await seed('watcher', 'swift otter')
await watcher.goto(`${BASE}/r/${room}`)
await watcher.waitForSelector('.cm-content', { timeout: 30000 })
await watcher.waitForTimeout(800)

// Count the frames the runner actually puts on the wire.
await runner.evaluate(() => {
  window.__sent = 0
  const send = WebSocket.prototype.send
  WebSocket.prototype.send = function (data) {
    try {
      if (JSON.parse(data).type === 'output') window.__sent++
    } catch {}
    return send.call(this, data)
  }
})

const writeCell = async (page, source) => {
  await page.click('.cell .cm-content >> nth=1')
  await page.keyboard.press('Meta+A')
  await page.keyboard.type(source)
  await page.waitForTimeout(150)
}

// The single output block under the cell, and who it says it belongs to.
const block = (page) =>
  page.evaluate(() => {
    const entries = [...document.querySelectorAll('.output .out-entry')]
    return {
      count: entries.length,
      tagged: entries.some((e) => e.classList.contains('remote')),
      names: [...document.querySelectorAll('.who-name')].map((e) => e.textContent),
    }
  })
const peerText = () =>
  watcher.$$eval('.out-entry', (els) => els.map((e) => e.innerText).join('\n')).catch(() => '')

/* ---- 1. a burst of output arrives whole, in a handful of frames ---- */
console.log(`burst of ${BURST} lines`)
await writeCell(runner, `for i in range(${BURST}):\n    print("line", i)`)
const burstStart = Date.now()
await runner.click('.cell button.run')
let burstMs = null
for (let i = 0; i < 300; i++) {
  if ((await peerText()).includes(`line ${BURST - 1}`)) {
    burstMs = Date.now() - burstStart
    break
  }
  await new Promise((r) => setTimeout(r, 200))
}
const text = await peerText()
const seen = [...text.matchAll(/line (\d+)/g)].map((m) => Number(m[1]))
const frames = await runner.evaluate(() => window.__sent)

check('the watcher receives the final line', burstMs !== null, burstMs === null ? '' : `${burstMs} ms`)
check(
  'no lines were dropped or reordered',
  seen.length === BURST && seen.every((n, i) => n === i),
  `${seen.length} of ${BURST}`,
)
check('the output is batched rather than one frame per line', frames > 0 && frames <= 60, `${frames} frames`)

/* ---- 2. output appears while the cell is still running ---- */
console.log('progressive output')
await runner.evaluate(() => {
  window.__sent = 0
})
await writeCell(runner, 'import time\nfor i in range(8):\n    print("tick", i, flush=True)\n    time.sleep(0.4)')
await runner.click('.cell button.run')
const counts = []
const tickStart = Date.now()
while (Date.now() - tickStart < 20000) {
  const n = ((await peerText()).match(/tick (\d+)/g) || []).length
  if (counts.at(-1) !== n) counts.push(n)
  if (n >= 8) break
  await new Promise((r) => setTimeout(r, 120))
}
const partway = counts.filter((n) => n > 0 && n < 8)
check('lines reach the watcher as they are printed, not all at the end', partway.length >= 3, `saw ${partway.join(',')}`)
check('the whole run still arrives', counts.at(-1) === 8, `ended at ${counts.at(-1)}`)

/* ---- 3. the block shows whoever ran the cell last ---- */
console.log('whose run is shown')
await writeCell(runner, 'print("hello")')
await runner.waitForTimeout(400)

await runner.click('.cell button.run')
await runner.waitForTimeout(2500)
let mine = await block(runner)
let theirs = await block(watcher)
check('one block only', mine.count === 1 && theirs.count === 1, `runner ${mine.count}, watcher ${theirs.count}`)
check('your own run is untagged on your screen', mine.tagged === false && mine.names.length === 0)
check("a classmate's run names them", theirs.tagged === true && theirs.names.join() === 'teacher', theirs.names.join())

// The watcher runs the same cell. Its kernel boots on first use, so this one is slow.
await watcher.click('.cell button.run')
for (let i = 0; i < 120; i++) {
  const seen = await block(runner)
  if (seen.names.join() === 'swift otter') break
  await new Promise((r) => setTimeout(r, 500))
}
mine = await block(watcher)
theirs = await block(runner)
check('the block changes hands, still one block', mine.count === 1 && theirs.count === 1)
check('the last person to run is named', theirs.tagged === true && theirs.names.join() === 'swift otter', theirs.names.join())
check('and on their own screen it is untagged', mine.tagged === false && mine.names.length === 0)

await browser.close()
console.log(failures ? `\n${failures} failed` : '\nall stream checks passed')
process.exit(failures ? 1 : 0)
