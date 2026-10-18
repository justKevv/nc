/**
 * Verifies the kernel's cell-execution semantics by running the *actual* runner
 * source out of kernel.worker.js under python3. This catches regressions in the
 * ast handling, stdout capture and traceback formatting without needing a
 * browser or a WebAssembly build of CPython.
 */
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const workerSrc = readFileSync(
  path.join(__dirname, '../web/src/lib/kernel.worker.js'),
  'utf8',
)

const match = /^const RUNNER = `\n([\s\S]*?)\n`$/m.exec(workerSrc)
if (!match) {
  console.error('could not locate the RUNNER template in kernel.worker.js')
  process.exit(1)
}
const RUNNER = match[1]

/**
 * The runner is Python living inside a JavaScript template literal, so a stray
 * backtick or `${` in a comment or docstring ends the string early and the build
 * fails somewhere far less obvious than the cause. It has happened twice; it
 * does not get to happen a third time.
 */
{
  const stray = [
    ['a backtick', /`/],
    ['a ${', /\$\{/],
  ].filter(([, re]) => re.test(RUNNER))
  if (stray.length) {
    console.error(
      `the Python runner contains ${stray.map(([what]) => what).join(' and ')}, ` +
        'which would close the JS template literal around it',
    )
    process.exit(1)
  }
}

const HARNESS = `
import json, io, sys, contextlib

def run(src):
    # _nb_run no longer buffers stdout: it streams to whatever sys.stdout is
    # while the cell executes, so the rest of the class can watch output arrive
    # live. This helper supplies a buffer for the cases below.
    out, err = io.StringIO(), io.StringIO()
    old_o, old_e = sys.stdout, sys.stderr
    sys.stdout, sys.stderr = out, err
    try:
        r = json.loads(_nb_run(src))
    finally:
        sys.stdout, sys.stderr = old_o, old_e
    r["stdout"] = out.getvalue() + r["stdout"]
    r["stderr"] = err.getvalue() + r["stderr"]
    return r

FAILS = []
def expect(label, cond, detail=""):
    FAILS.append(label) if not cond else None
    print(("  ok  " if cond else "FAIL  ") + label + (("  -> " + detail) if (not cond and detail) else ""))
def done():
    print("")
    raise SystemExit(1 if FAILS else 0)
`

const CELL_CASES = `
# Pyodide's matplotlib wheel defaults to a DOM-painting canvas backend, which
# cannot even be imported in a worker. The runner has to pin Agg in the
# environment, and it has to do so before a cell runs.
expect("the runner pins matplotlib to the non-DOM backend before any cell runs",
       os.environ.get("MPLBACKEND") == "agg", repr(os.environ.get("MPLBACKEND")))

buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    streamed = json.loads(_nb_run('print("hi")'))
expect("a running cell streams stdout instead of buffering it until the end",
       streamed["stdout"] == "" and buf.getvalue().strip() == "hi",
       repr(streamed["stdout"]) + repr(buf.getvalue()))

r = run('print("hi")')
expect("stdout is captured", r["stdout"].strip() == "hi", repr(r["stdout"]))
expect("no traceback on success", r["error"] is None, str(r["error"]))

r = run('1 + 1')
expect("a trailing bare expression is displayed", r["repr"] == "2", repr(r["repr"]))

r = run('x = 41\\nx + 1')
expect("the last expression of a multi-statement cell is displayed",
       r["repr"] == "42", repr(r["repr"]))

r = run('x = 41\\nx = x * 2')
expect("an assignment cell displays nothing", r["repr"] is None, repr(r["repr"]))

r = run('x')
expect("state persists between cells", r["repr"] == "82", repr(r["repr"]))

r = run('')
expect("an empty cell is a no-op", r["stdout"] == "" and r["error"] is None, json.dumps(r))

r = run('[n**2 for n in range(4)]')
expect("comprehensions display as a list", r["repr"] == "[0, 1, 4, 9]", repr(r["repr"]))

r = run('print(f"{x}")')
expect("f-strings work", r["stdout"].strip() == "82", repr(r["stdout"]))

r = run('print("out"); 1/0')
expect("stdout survives a later failure", r["stdout"].strip() == "out", repr(r["stdout"]))

r = run('1/0')
expect("errors become a traceback",
       r["error"] is not None and "ZeroDivisionError" in r["error"], str(r["error"])[:120])

r = run('raise ValueError("boom")')
expect("custom exceptions are reported",
       "ValueError: boom" in (r["error"] or ""), str(r["error"])[:120])

r = run('import sys; sys.stderr.write("warn\\\\n")')
expect("stderr is kept separate from stdout", r["stderr"].strip() == "warn", repr(r["stderr"]))
done()
`

/*
 * Restart is aggressive by design: it removes every user name from the kernel
 * namespace. Because this script's own top-level names live in that same
 * namespace, the helpers above get wiped too. So this phase avoids the harness
 * entirely and reports with bare `print` (a builtin, never in __main__) plus
 * names the RUNNER itself imports, which the baseline preserves.
 */
const RESTART_CASES = `
json.loads(_nb_run('leftover = 99'))
print("  ok  the variable exists before restart"
      if "leftover" in sys.modules["__main__"].__dict__ else "FAIL  leftover was never defined")

_nb_restart()

print("  ok  restart clears user variables"
      if "leftover" not in sys.modules["__main__"].__dict__ else "FAIL  leftover survived the restart")

print("  ok  the kernel still runs cells after a restart"
      if json.loads(_nb_run('2 ** 10'))["repr"] == "1024"
      else "FAIL  cell execution broke after restart")

print("  ok  imports work again after a restart"
      if json.loads(_nb_run('import math; math.floor(3.7)'))["repr"] == "3"
      else "FAIL  imports broke after restart")

print("  ok  the restart helper survives being called"
      if json.loads(_nb_run('_nb_restart(); 1 + 1'))["repr"] == "2"
      else "FAIL  restart removed its own helpers")
`

function runPhase(name, cases) {
  let output = ''
  let code = 0
  try {
    output = execFileSync('python3', ['-c', RUNNER + HARNESS + cases], {
      encoding: 'utf8',
      stdio: 'pipe',
    })
  } catch (err) {
    output = (err.stdout || '') + (err.stderr || '')
    code = err.status ?? 1
  }
  const failures = output.split('\n').filter((l) => l.startsWith('FAIL')).length
  process.stdout.write(`\n${name}\n${output}`)
  return code || failures ? failures || 1 : 0
}

const failed =
  runPhase('cell execution', CELL_CASES) + runPhase('kernel restart', RESTART_CASES)

console.log(failed ? `\n${failed} failed\n` : '\nall kernel checks passed\n')
process.exit(failed ? 1 : 0)
