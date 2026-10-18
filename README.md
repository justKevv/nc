# nc

*nc* is short for **notebook colab** — two words pushed together, which is about
as much naming as this needed.

It's a shared notebook for a class. Real-time, Jupyter-style cells, running
entirely in the browser: students open a link and they're in the same document as
everyone else, with no installs, no accounts, nothing to sign up for.

I built it to teach with. A notebook per lesson, and — because everyone's in the
same document while they work — a way to hand out a test and watch it being worked
on live, in the same place the lesson happened, instead of collecting files at the
end. Each student's Python runs in their own browser, so a class of thirty puts no
load on the machine you're teaching from.

It started as a local reimplementation of [PyTogether](https://pytogether.org),
with cells instead of a file tree.

> The repo, the folders and some config still say `nbcollab`. That was the longer
> name before I shortened it to `nc` for the URL.

---

## Quick start

Nobody in your class needs any of this — they just get sent a link. It's all for
whoever's running the server.

```bash
npm install
npm run fetch:pyodide   # vendor Python (~75 MB); without it the browser uses a CDN
npm run dev             # hot reload on http://localhost:5173
```

When it's time for an actual lesson, and you want a link to put on the board:

```bash
npm run share   # builds, serves, opens a Cloudflare tunnel, prints the URL
```

`Ctrl+C` shuts it down, and everything's saved to disk.

> The free tunnel gets a new hostname every restart and doesn't promise uptime.
> Fine for a Tuesday lecture, not for anything permanent.

---

## Two ways to run it

| | Relay and notebooks live | What to run |
| --- | --- | --- |
| **Your laptop** | `server/index.js`, files in `data/` | `npm run dev`, `npm start`, `npm run share` |
| **Cloudflare** | A Worker plus a Durable Object per notebook | `npm run cloud`, `npm run deploy` |

Both speak the same protocol (`shared/protocol.js`), so a class can move between
them.

```bash
npx wrangler login   # once
npm run cloud        # run the real thing locally on :8787
npm run deploy       # publish to https://nc.<you>.workers.dev
```

You don't have to set anything up in Cloudflare first — the notebook list is
itself a Durable Object rather than a KV namespace, so wiping everything takes
effect immediately.

A few things are different in the cloud: **Python comes from a CDN** (the
vendored copy doesn't get uploaded, so run it locally if your classroom is
offline), a classmate's **cursor hangs around for up to 30 seconds** after they
leave instead of going at once, and you'll want to set `NBCOLLAB_ALLOW_RESET =
"0"` in `wrangler.toml` if the URL is public — otherwise anyone who finds it can
wipe the lot.

---

## How a lesson runs

1. `npm run share`, then copy the printed link.
2. A student opens it, types a name and starts a notebook. You hand out the **room
   code** — the id at the end of the URL, like `week-3-lists-a7k2p` — and everyone
   pastes that into the lobby to join in.
3. Everyone edits together. Names and colours up in the toolbar, cursors in the
   text.
4. `⇧↵` runs a cell. Python runs in that student's own browser, and while it runs
   everyone watches the output show up under their name.
5. Arm the pen in the bottom bar to sketch over the code; everyone sees it live.

### Shortcuts

| | |
| --- | --- |
| `⇧↵` | Run the cell, and open a new one below |
| `⌘↵` / `Ctrl↵` | Run without adding a cell |
| `Tab` | Indent |
| `⌘Z` / `CtrlZ` | Undo — the last stroke if a pen tool is armed, otherwise the last edit |

---

## The shared pen

A freehand layer you can scribble over the notebook with: pen, highlighter, eraser
and a colour in the bottom bar, one tool at a time. An eyeball hides ink for you
only; the bin clears it for everyone, after a confirm.

It's stored the same way as everything else — just another shared type in the same
document. The strokes live in the page's scroll space, so they stay glued to the
cells they were drawn over, and they're there for whoever joins later. No extra
protocol, no server state.

---

## Watching each other run code

Every browser has its own Python, so results belong to whoever ran them — but the
moment a kernel prints, the text is relayed to the room. Each cell shows **one
output block: the last person to run it**, tagged with their name and colour, or
untagged when it's you. Run it again and the block gets replaced rather than
stacked up.

A few things about it:

- **It streams.** Pyodide's own write callbacks, gathered up and sent every 50 ms,
  so you see `line 1` while `line 2` is still running. 3000 lines leave in about 4
  frames.
- **That 50 ms comes from the writes, not a timer.** A cell stuck in `sleep()` has
  the worker's event loop blocked, so a timer would never fire and the whole run
  would look like a hang.
- **It's relayed, not stored.** Nothing goes into the notebook, so exports stay
  clean and a late joiner doesn't see ghosts of runs that already happened.
- **The relay tidies it up.** Script tags, `on*` handlers and `javascript:` URLs
  come out, images have to be `data:image/…`, and there's a rate limit. Going over
  budget delays output instead of dropping it, and a runaway print stops being
  shared past 200 kB — so `while True: print(...)` can't stream at the class all
  afternoon.
- **`Restart` clears the block**, yours and theirs.

---

## The editor

- **Auto-closing pairs** for quotes, brackets and braces, the way students expect.
- **Completions** from Python keywords, builtins, cell magics, and — pushed to the
  top — every name defined anywhere in the notebook, `import … as` aliases
  included. That last one is usually the answer in a shared notebook: a classmate
  defined `prices` in cell 2, and you want it in cell 7.
- **After a dot, it asks the interpreter.** `np.` lists numpy's real members, `df.`
  lists the columns of the DataFrame you actually built. Nothing's guessed, and it
  never starts Python just to answer a keystroke — no interpreter running, no
  suggestions.

---

## Where Python comes from

Pyodide is about 10 MB of WebAssembly, and getting it into the browser is the part
that breaks in a classroom, so it gets three tries: the copy this server vendors at
`/pyodide/`, then jsDelivr, then unpkg. Each one is probed with an 8-second
request first; the download itself has no deadline, because 10 MB over a school
connection legitimately takes a while.

The vendored copy isn't committed (75 MB). `npm run fetch:pyodide` grabs it, and
`--packages scipy,requests` grabs more.

## Installing packages

**+ Package** in the toolbar, or a cell starting with `%pip install pandas numpy`.
Packages install per student, on first use, and are cached after that. Put it at
the top of a notebook if you can, rather than in the middle of an exercise.

---

## Notebooks on disk

Saved as Yjs documents under `data/rooms/`, so they survive a restart. Students can
**download .ipynb** — it opens in JupyterLab, Colab, VS Code — or **import** one.
Outputs aren't in the export, since everyone computes their own.

### The lobby

**Your notebooks** lists what this browser started, newest first, so you can get
back into Monday's six notebooks without digging through a chat log. It's
per-browser rather than per-person — there are no accounts — so it doesn't follow
you to another computer, and clearing your browser data forgets the list (the
notebooks themselves stay put on the server).

### Reset

**Reset** deletes every notebook on the server. Old links stop working and land on
"not found", anyone still editing gets disconnected, and your list clears. Two
clicks, no undo. Start the server with `NBCOLLAB_ALLOW_RESET=0` if you'd rather
students couldn't: the card disappears and the endpoint refuses.

Only **Start a notebook** creates a room. A socket to an unknown id gets refused
rather than quietly opening an empty notebook, which is what makes the reset
stick.

---

## Under the hood

| | |
| --- | --- |
| **Pyodide** in a Web Worker | CPython in WebAssembly, in the browser. Nothing runs on the server, so there's no scaling problem. |
| **Yjs** | The notebook is an array of cells with shared text bodies. Concurrent edits merge instead of clobbering each other. |
| **CodeMirror 6** | Bound straight to that shared text, which is where the live cursors come from. |
| **Node + `ws`**, or **Durable Objects** | Relays updates, answers the lobby, refuses sockets to notebooks that no longer exist. It only moves bytes — it never runs anyone's code. |

Messages are JSON, shaped like PyTogether's:

```jsonc
{ "type": "sync" | "update" | "awareness", "update_b64": "..." }
{ "type": "output", "event": "start" | "chunk" | "result", ... }
{ "type": "ping" | "pong", "timestamp": 0 }
```

Beyond that: `POST /api/rooms` creates, `GET /api/rooms` lists, `PATCH
/api/rooms/:id` renames, `DELETE /api/rooms` wipes. A socket closing with `4004`
means the notebook was deleted while you were in it. Ink rides along inside
`update`, because it's just another shared type.

---

## Tests

```bash
npm test                                        # everything but the browser ones
npm start &                                     # in another shell, for these two
BASE=http://127.0.0.1:8787 node test/e2e-cells.mjs
```

`npm test` starts a real server and drives it with fake clients: seeding, sync,
concurrent edits, ink, output relay and its sanitising, presence, persistence
across a restart, the room API and the websocket gate — plus the Worker and both
Durable Objects, with the three runtime pieces they need faked.

The `e2e-*.mjs` scripts drive real browsers instead, and they're how the cell
chrome and the streaming finally got verified. Playwright isn't a dependency;
install it when you want them (`npx playwright install chromium`).

---

## Things to know

- **A link is the only key.** Anyone who has it can join and edit, so keep it off
  the public internet.
- **Anyone at the lobby can clear the server**, on purpose. Stopping a teacher at
  the bell to type a passphrase is worse. Copy `data/` first if the work matters.
- **Output is per-student and isn't saved.** Two students can run different code in
  the same cell and see different results: the source is shared, the output is
  theirs, and neither ends up in the export.
- **Python boots on demand**, when the first cell runs, so opening a notebook to
  read it costs nothing.
- **Moving a cell rebuilds its editor**, and that cell loses its undo history —
  Yjs can't re-insert a shared type that's already live.
- **No interrupt yet.** A runaway loop blocks that student's tab until they
  reload.
- **No accounts, no roster, no chat.** Questions get asked out loud, or drawn on
  the page, which is usually faster anyway.

---

## Maybe later

No promises and no roadmap — these are just things I've wanted while teaching, or
that I might get round to one day. If one of them looks fun, it's all in here.

- **A stop button.** Right now a runaway loop just sits there until the student
  reloads. Genuinely annoying, and probably the first thing I'd fix.
- **Read-only links.** Sometimes I want to hand out a worked example, not a
  document to scribble on.
- **Pushing a cell to everyone.** Starting the next exercise in everyone's
  notebook at once, instead of "open cell 4, paste this…".
- **Keeping the outputs.** Exports are source-only at the moment, which is right
  for a class but wrong for a "here's what you did" archive.
- **A code for the room**, if link-only ever feels too open. Honestly not sure I
  want this one — it's more ceremony than a classroom usually needs.
