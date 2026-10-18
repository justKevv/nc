/**
 * Browser-level check of the cell chrome: move up/down must actually reorder
 * cells and keep their text, and the pen overlay must not swallow clicks on the
 * buttons underneath it.
 *
 * The reorder bug this guards against was a Yjs crash, not a layout problem, so
 * it can only be seen in a real browser:
 *
 *   npm start &            # or npm run dev
 *   npx playwright install chromium
 *   BASE=http://127.0.0.1:8787 node test/e2e-cells.mjs
 *
 * Playwright is not a dependency of this project; install it on demand.
 */
import { chromium } from 'playwright'

const BASE = process.env.BASE || 'http://127.0.0.1:8787'

const browser = await chromium.launch()
const page = await browser.newPage()
const failures = []
const check = (label, cond, detail) => {
  if (cond) {
    console.log(`  ok  ${label}`)
  } else {
    failures.push(label)
    console.log(`FAIL  ${label}${detail ? `\n      ${detail}` : ''}`)
  }
}

page.on('pageerror', (err) => check('no uncaught page errors', false, String(err)))

await page.goto(BASE)
await page.fill('#nbname', 'e2e cells')
await page.click('button:has-text("Create notebook")')
await page.waitForSelector('.cell', { timeout: 30000 })
await page.waitForTimeout(2500)

const order = () =>
  page.$$eval('.cell .cm-content', (els) => els.map((e) => e.innerText.split('\n')[0].slice(0, 24)))
const press = async (title, i = 0) => {
  const buttons = await page.$$(`.cell button[title="${title}"]`)
  await buttons[i].click()
  await page.waitForTimeout(700)
}

const start = await order()
check('the seeded notebook has two cells', start.length === 2, JSON.stringify(start))

await press('Move down', 0)
const afterDown = await order()
check('move down swaps the cell with the one below', afterDown[0] === start[1], JSON.stringify(afterDown))
check('move down keeps the text of both cells', afterDown.join('|') === start.slice().reverse().join('|'))

await press('Move up', 1)
const afterUp = await order()
check('move up puts the cell back', afterUp.join('|') === start.join('|'), JSON.stringify(afterUp))

const disabled = await page.$$eval('.cell button[title="Move down"]', (els) => els.map((e) => e.disabled))
check('move down is only disabled on the last cell', disabled.join(',') === 'false,true', disabled.join(','))

check('the notebook still has two cells after moving', (await page.$$('.cell')).length === 2)

console.log(`\n${failures.length ? `${failures.length} failed` : 'all browser checks passed'}\n`)
await browser.close()
process.exit(failures.length ? 1 : 0)
