# nbcollab

Real-time collaborative **Jupyter-style notebooks** that run in the browser.
Students open one link, everyone edits the same document at the same time, and
they see each other's live cursors and can draw on the page together — no
installs, no accounts, no per-student CPU on your machine.

Built as a local reimplementation of [PyTogether](https://pytogether.org) with a
cell-based notebook model instead of a file tree.

---

## Quick start

```bash
npm install
npm run fetch:pyodide   # vendor the Python runtime (~75 MB), see below
npm run dev             # local dev, hot reload on http://localhost:5173
```

`fetch:pyodide` is the one step worth doing up front. Without it the browser
pulls Python from a public CDN, which is fine on a good connection and hopeless
on a filtered one — see [Where Python comes from](#where-python-comes-from).

To run it for real and get a link you can hand to students:

```bash
npm run share
```

This builds the app, starts the server, and opens a Cloudflare quick tunnel. It
prints a public `https://….trycloudflare.com` URL. Students open it, create or
join a notebook, and you're in business.

Press `Ctrl+C` to shut down — the tunnel closes and everything is saved to disk.

> The quick tunnel is free and needs no account, but the hostname is random and
> changes every restart, and Cloudflare makes no uptime guarantee. Perfect for a
> Tuesday lecture, not for a permanent deployment.

---

## Two ways to run it

The same app runs two ways, and everything above is the first one:

| | Where the relay runs | What you get | What to run |
| --- | --- | --- | --- |
| **Your laptop** | `server/index.js`, notebooks in `data/` | Instant, offline-capable, your files on your disk | `npm run dev`, `npm start`, `npm run share` |
| **Cloudflare** | A Worker plus a Durable Object per notebook | A permanent URL, no laptop left running, nothing to keep up | `npm run cloud`, `npm run deploy` |

Both speak the same protocol — the envelopes, the size caps and the output
sanitising live once, in `shared/protocol.js`, and both relays import them — so a
class on one keeps working if you move it to the other.

### Deploying to Cloudflare

```bash
npx wrangler login   # once
npm run cloud        # local workerd: builds the app, serves it on :8787
npm run deploy       # publishes to https://nbcollab.<you>.workers.dev
```

No KV namespace, bucket or database to create first: the notebook index is itself
a Durable Object, addressed by a fixed name, so "delete all notebooks" is applied
immediately rather than after a cache expires. `wrangler.toml` holds the whole
configuration — one Worker, `RoomsIndex` for the lobby list, `RoomServer` per
notebook, and `web/dist` uploaded as static assets.

Two differences worth knowing about, both deliberate:

- **Python comes from the CDN.** The Worker has no `vendor/pyodide` to serve, so
  `/pyodide/` answers 404 and the kernel falls through to jsDelivr, then unpkg.
  Vendoring it in the cloud would mean uploading 75 MB of assets. If your
  classroom is offline, run it locally instead.
- **A cursor lingers for up to 30 seconds after its author leaves.** The Node
  relay can drop a peer's presence the moment its socket closes, because it holds
  the awareness state itself; the Durable Object relays presence without decoding
  it, so the browsers expire a silent peer on their own timer instead. Everything
  else about a disconnecting student is instant.
- **Set `NBCOLLAB_ALLOW_RESET = "0"` in `wrangler.toml` for a public
  deployment**, or anyone who finds the URL can wipe every notebook.

---

## How a lesson actually runs

1. You run `npm run share` and copy the printed link.
2. A student opens it, types a name (or picks a random one), and creates a
   notebook. You hand out the **room code** — the short id at the end of the
   URL, e.g. `week-3-lists-a7k2p`. Students paste that into the lobby to join
   the same notebook.
3. Everyone edits together. Names and colours in the toolbar show who's here;
   you can see each person's cursor in the text.
4. Each student presses `⇧↵` to run a cell. Python executes **in their own
   browser**, so thirty students cost you nothing — and while their cell is
   still running, everyone else watches its output appear line by line under
   their name.
5. Anyone can arm the pen in the bottom bar and sketch over the code — arrows,
   circles, a highlighted line — and everyone sees it appear live.

### Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `⇧↵` | Run the cell and open a new one below (Jupyter behaviour) |
| `⌘↵` / `Ctrl↵` | Run the cell without adding another |
| `Tab` | Indent (works in code cells) |
| `⌘Z` / `CtrlZ` | Undo — the drawing you last made while a pen tool is armed, otherwise the code |

The lobby is also where you get back to your own notebooks, and where the server
is cleared between classes — see [The main page](#the-main-page).

---

## The shared pen

A freehand ink layer sits on top of the notebook, the way PyTogether's does:

- **✏️ Pen / 🖍 Highlighter / ⌫ Eraser** in the bottom bar, plus a colour swatch.
  One tool is armed at a time; pressing it again puts the pointer back.
- **Eyeball** hides ink for you only — useful when you're the one typing.
- **Bin** clears everyone's ink (with a confirm, since it's destructive for the room).
- `⌘Z` / `⌘⇧Z` undo and redo your strokes while a tool is armed.

Mechanics worth knowing if you plan to change it:

- Strokes live in the shared Yjs document as `Y.Array('drawings')` — no special
  wire protocol, no server state. They persist with the notebook and arrive for
  free to anyone who joins later.
- Points are stored in the notebook's **content space** (scroll offset added),
  so ink stays glued to the cells it was drawn over while the view scrolls. The
  canvas is just an overlay in the scroll container that repaints on scroll and
  resize.
- A stroke in progress is flushed to the document every 300 ms so the class
  watches it being drawn. The preview carries a `_liveId` and is written *and
  removed* under a custom Yjs transaction origin, so the `Y.UndoManager` ignores
  it and one undo always removes exactly one finished stroke. (Sharing a
  transaction between the preview's removal and the final stroke is the trap:
  undo then restores the preview instead of dropping the stroke, and undo looks
  like it does nothing until the page is cleared.) `captureTimeout: 0` keeps
  strokes drawn in quick succession as separate undo steps.
- The eraser is not a delete. It's a stroke painted with
  `globalCompositeOperation = 'destination-out'`, which keeps erasing and
  drawing commutative in one shared list — there is no "who erased what" race.
- While a tool is armed the overlay takes pointer events, so the editors under
  it are temporarily unclickable. That matches the original.

---

## Seeing other people run code

Each browser owns its own Python, so results are per-student by nature. But the
moment a kernel writes to stdout, that text is relayed to the room and takes over
the output region under that cell — so the class works on one cell together
instead of leaving twenty private answers stacked up.

There is **one output block per cell, and it shows whoever ran the cell last**:

```
▎ swift otter         2 ms     <- labelled: this is who ran it last
hello from the browser!
[0, 1, 4, ...]
```

- When someone else runs the cell, their result takes the block and is tagged
  with their name and a colour rail down its left edge. When you run it, the
  block becomes yours and the name comes off — an unlabelled block is you.
- It replaces rather than stacks. Run the cell again yourself and there is still
  one block, not two, and the text of the run being replaced can't leak into the
  new one.
- The block goes to the last person to *start* a run, not the last to finish, so
  a long run that is still streaming doesn't hold it against someone who pressed
  run after it.
- It stays until the page is reloaded, and follows a classmate if they run the
  same cell from a different row.

How it works, and where the edges are:

- **It streams, in batches.** The cell runner no longer redirects `sys.stdout`
  into a `StringIO`; Pyodide's own callbacks fire on every write. You see
  `line 1` while `line 2` is still executing — but the writes are gathered and
  posted at most every 50 ms. One frame per `print()` means a relay that isn't
  localhost (a tunnel, a laptop on school wifi) does thousands of round trips,
  and every frame is another render for every classmate watching. 3000 lines now
  leave in **4 frames** and land in about a second.
- **The 50 ms is decided when the text is written, not by a timer.** A cell
  sitting in `time.sleep()` or a long computation has the worker's event loop
  blocked, so a timer would never fire and nothing would appear until the cell
  finished — which looks exactly like a hang. The timer is only a backstop for
  text that arrives after the last write.
- **It is relayed, not shared state.** Chunks travel as
  `{ type: 'output', event: 'start' | 'chunk' | 'result', … }` and the server
  only stamps the sender's name and colour onto them. Nothing is written into
  the Yjs document, so a notebook file never grows with other people's output
  and a late joiner sees no ghosts of runs that already happened.
- **The envelope's `type` is written last** (`outputEnvelope` in
  `web/src/lib/outputFeed.js`). A kernel result carries a `type` of its own, and
  when that won the merge the server saw `{"type":"result"}`, matched no case and
  silently dropped every finished run — peers watched the text stream in and then
  sat on "is running…" forever. The server now warns on unknown message types
  instead of swallowing them.
- **The server trims and sanitises it.** Because the payload comes from a
  browser and peers render `_repr_html_` straight into the DOM, relayed HTML is
  stripped of script/style/iframe tags, `on*` handlers and `javascript:` URLs,
  images must be `data:image/…`, chunks are capped, and each socket gets a
  token bucket so a chatty cell can't flood the room.
- **Exceeding the budget delays output, it does not delete it.** A cell that
  prints a few thousand lines in a second outruns the relay. The excess used to
  be thrown away — the class watched a few hundred lines and then nothing, which
  reads as "it's so slow" rather than "your output was discarded". Overflow is
  now held (up to 256 kB per stream), merged into one frame, and released as
  budget returns; a run's `result` is never dropped and never overtakes the text
  still queued behind it.
- **A runaway print stops being shared.** Past 200 kB per stream the runner
  stops relaying and appends `… output truncated` once, so an accidental
  `while True: print(...)` can't stream at the class all afternoon.
- **Capped on screen too.** Each person's buffer is trimmed to 200 kB, and
  `outputFeed.js` decides whose run occupies the block — that's where the awkward
  cases live (a peer re-running mid-stream, a peer moving cells) and where
  they're tested.
- **Watching is cheap.** Incoming frames are folded into the feed on a 100 ms
  tick rather than per frame, and neither the scroll position nor the other
  cells are disturbed by someone else's output: a classmate's run never scrolls
  the page out from under you, and it never re-renders a cell you're editing.
- **You can see it end to end.** `test/e2e-stream.mjs` runs a real runner and a
  real watcher in two browsers and checks that a burst arrives whole and in
  order, that it leaves in a handful of frames, and that output appears while
  the cell is still running.
- **`Restart` clears it**, yours and theirs.

---

## Editing like a code editor

The editor behaves the way a terminal editor does, because students expect it to:

- **Auto-closing pairs.** Typing `"` `'` `(` `[` `{` inserts the closing half, and
  typing the closer yourself steps over it instead of doubling it. Backspace
  between a freshly typed pair removes both.
- **Completions.** Start typing and CodeMirror offers Python keywords, the
  builtins worth knowing, the cell magics the kernel honours, and — boosted to
  the top — **every name defined anywhere in this notebook**, including
  `import … as …` aliases and `for` loop variables. That last part is the one a
  static word list can't do, and in a shared notebook it's usually the answer:
  a classmate defined `prices` in cell 2 and you want it in cell 7.
- **After a dot, it asks Python.** Type `np.` and you get numpy's real members,
  `np.zero` narrowing to `zeros`, `zeros_like`, `nonzero`… because the question
  goes to the interpreter that already ran your `import` — the same one holding
  your variables. That means `df.` lists the columns of the DataFrame you
  actually built, which no static word list or type stub could tell you. Nothing
  is guessed: a name the interpreter has never seen offers nothing, and a dunder
  only appears if you ask for one by typing an underscore.
- **It never starts Python to answer a keystroke.** Completion comes from the
  interpreter if one is already running and otherwise not at all. Typing `np.` on
  a notebook nobody has run yet offers nothing, rather than quietly beginning a
  ~10 MB download. Member lists are cached per name and dropped whenever a run
  could have changed what those names are.
- **Only names get looked up.** `np.` and `self.data.` are names; `foo().`,
  `items[0].` and `1.5` are not, so they are never handed to the interpreter.
  The rule is one shared definition (`web/src/lib/attrs.js`) used by both the
  editor and the worker, so the two can't drift apart.
- Completions stay out of the way inside an already-closed call and in markdown
  cells.

---

## Where Python comes from

Pyodide is ~10 MB of WebAssembly plus a standard library archive, and the whole
kernel depends on the browser getting all of it. That download is the most
fragile part of a classroom tool, so this app gives it three chances and never
leaves a student guessing:

1. **`/pyodide/`, served by this app.** `npm run fetch:pyodide` copies the
   runtime — and the wheels for numpy, pandas and matplotlib, since those are the
   ones the toolbar offers — into `vendor/pyodide/`. The server serves them from
   its own origin, so students load Python over the same tunnel they already
   loaded the page through. Nothing third-party is involved, which is what makes
   this work on a school network that blocks CDNs. `--packages requests,scipy`
   vendors more, dependencies included.
2. **jsDelivr**, the usual home of the runtime.
3. **unpkg**, the same npm package, for when jsDelivr specifically is down.

Each mirror is *probed* with an 8-second request for the 13 kB loader. The first
one that answers gets the job — and then there is no deadline on the actual
download, because 10 MB over a slow link legitimately takes a while and cutting
it off would just push the student back to the mirror that didn't answer. If
every mirror fails, the kernel log says so and offers a **Retry** button instead
of leaving "Downloading Python runtime…" on screen forever.

The vendored runtime is not committed (see `.gitignore`): it's 75 MB, and a
checkout that has to pull it over a school VPN is worse than no copy at all.

---

## Installing packages

NumPy, pandas, matplotlib etc. aren't bundled, but they're one click away:

- **+ Package** in the toolbar, or
- a code cell starting with a magic, which the kernel also understands:

```python
%pip install pandas numpy
```

Packages install per student, in that student's browser, on first use — which
takes a few seconds and is cached afterwards. Warn students to install at the
top of the notebook rather than mid-exercise. If `fetch:pyodide` vendored the
wheel, the install comes off your own server and takes under a second; otherwise
micropip fetches it from PyPI. Either way the kernel log prints progress lines,
so a slow install looks like a slow install rather than a freeze.

---

## Notebooks on disk

Every notebook is saved as a Yjs document under `data/rooms/`, so it survives
restarts and you can keep a course archive. Students can also:

- **Download .ipynb** — standard Jupyter format, opens in JupyterLab, Colab, VS Code
- **Import .ipynb** — bring your own slides or exercises in

Outputs are **not** written into the `.ipynb` export, because each student
computes results in their own browser.

### The main page

The lobby keeps a **Your notebooks** list: every notebook *you* started from this
browser, newest first, with its code and when it was last touched. That is the
point of it — a teacher who started six notebooks on Monday can get back into
any of them without digging a link out of a chat log. Renaming the notebook in
the toolbar updates the name in the list too.

It is deliberately *your* list, not a directory. There are no accounts here, so
"yours" means "started from this browser", remembered in `localStorage`. Nobody
sees anyone else's notebooks; a student joins by link or code, as before. The
corollary is worth saying out loud: the list lives on the machine that made it,
so it does not follow you to another computer, and clearing your browser data
forgets it (the notebooks themselves stay on the server).

### Clearing the server between classes

The lobby's **Reset** card deletes every notebook on the server — all of them,
everyone's work, no undo. It takes two clicks (the second one says what it is
about to do), and afterwards:

- the notebook files and their metadata are gone, so **old links stop working**
  and land on a "notebook not found" page — that is the feature, not a bug
- anyone still editing is disconnected instead of silently carrying on against a
  deleted document
- your **Your notebooks** list is cleared, and the server is ready for the next
  class

If you would rather students couldn't do that, start the server with
`NBCOLLAB_ALLOW_RESET=0`: the card disappears and the endpoint answers `403`
even if someone calls it directly. Leaving it on is the default, because a
teacher resetting at the bell shouldn't need a shell.

Rooms are only created deliberately (via **Start a notebook**) for the same
reason: a websocket to an unknown id is refused rather than quietly
materialising an empty notebook, which is what makes the wipe stick.

---

## How it works

| Piece | What it does |
| --- | --- |
| **Pyodide** (Web Worker) | CPython compiled to WebAssembly. Runs in the browser, so there's no server-side execution and no scaling problem. |
| **Yjs** (CRDT) | The notebook is a `Y.Array` of `Y.Map` cells, each with a `Y.Text` body. Concurrent edits merge automatically instead of clobbering each other. |
| **CodeMirror 6** + `y-codemirror.next` | The editor, bound straight to the shared `Y.Text`, which gives live remote cursors and selections. |
| **Node + `ws`** | Relays CRDT updates, serves the lobby's room list, and refuses sockets to rooms that no longer exist. It only forwards bytes and never interprets code. |
| **Durable Objects** | The same job in the cloud: `RoomServer` per notebook, `RoomsIndex` for the lobby. Sockets hibernate, so an idle class costs nothing. |
| **Cloudflare tunnel** | Makes your localhost reachable over HTTPS, so browsers accept the WebSocket. Not needed when you deploy. |

The wire protocol deliberately mirrors PyTogether's shape, since that is what the
original uses:

```jsonc
{ "type": "sync",      "update_b64": "..." }   // server → client, full doc
{ "type": "update",    "update_b64": "..." }   // both ways, incremental edits
{ "type": "awareness", "update_b64": "..." }   // cursors, names, colours
{ "type": "output",      "event": "chunk", … }   // both ways, live cell output
{ "type": "ping" | "pong", "timestamp": 0 }
```

Room lifecycle is plain HTTP next to it: `POST /api/rooms` creates one,
`GET /api/rooms` lists them (for your own notebook list), `PATCH
/api/rooms/:id` renames one, and `DELETE /api/rooms` wipes the lot. A websocket
close with code `4004` means the notebook was deleted while you were in it.

Drawing rides along inside the `update` messages, because ink is just another
shared type in the same document.

---

## Project layout

```
scripts/
  fetch-pyodide.mjs Vendors the Python runtime and common wheels into vendor/
shared/
  protocol.js       The wire contract both relays speak: envelopes, caps, sanitising
  room.js           Room ids and the seed notebook, so both relays seed identically
server/
  index.js          HTTP + WebSocket server, static hosting, /pyodide/, REST API
  rooms.js          In-memory Yjs docs, presence, debounced saves
  store.js          Disk persistence (data/rooms/*.ydoc), room metadata, wipe
  tunnel.js         Cloudflare quick-tunnel wrapper
worker/
  index.js          Worker: static assets, the lobby API, routing a socket to a room
  room.js           RoomServer: one Durable Object per notebook, hibernating sockets
  rooms-index.js    RoomsIndex: the lobby list, in one strongly consistent object
wrangler.toml       The whole Cloudflare deployment: bindings, migrations, assets
web/src/
  components/
    Notebook.jsx    Main container: doc, provider, kernel, cell list
    Cell.jsx        Collaborative CodeMirror editor + controls
    Output.jsx      stdout / stderr / traceback / rich results / plots
    Toolbar.jsx     Title, presence, share link, packages, import/export
    InkBar.jsx      Pen, highlighter, eraser, colour, hide, clear
    Lobby.jsx       Start/join a notebook, your own notebook list, server reset
    NotFound.jsx    Shown for a link to a notebook that no longer exists
  lib/
    collab.js       WebSocket provider (sync, awareness, reconnect)
    relay.js        Where the relay is: same origin, or VITE_RELAY_BASE
    ink.js          Shared ink layer: strokes in Yjs, canvas overlay, tools
    completions.js  Python keywords, builtins, magics, notebook names, members
    attrs.js        What may be looked up: a plain dotted name, nothing else
    kernel.js       Promise API over the Pyodide worker
    kernel.worker.js  Cell execution, stdout capture, matplotlib figures
    notebook.js     Cell operations and .ipynb import/export
    outputFeed.js   The output feed: one entry per person, latest run wins
    identity.js     Display name and stable per-user colour
    myRooms.js      Notebooks this browser started (the lobby's list)
    format.js       "4 min ago" for that list
test/
  kernel.test.js    Pyodide execution, output capture, restart
  notebook.test.js  Cell list: insert, delete, and the reorder path
  ink.test.js       Stroke commit/preview, undo-redo, late-joiner sync
  e2e-stream.mjs    Output sharing between a runner and a watcher (on demand)
  e2e-completions.mjs  `np.` in a real browser (on demand)
  completions.test.js  What counts as a member lookup, and dunder filtering
  output-feed.test.js  One block, handed to whoever ran last
  lobby.test.js     The browser's own notebook list, and how it ages
  protocol.test.js  End-to-end sync/ink/output-relay/persistence tests
  rooms-api.test.js Room creation, rename, reset, and the websocket gate
  worker-cloud.test.js  The Worker and both Durable Objects, driven in Node
```

---

## Tests

```bash
npm test
```

Spins up a real server and drives it with two fake browser clients to check room
creation, seeding, cross-client sync, concurrent-edit merging, ink sync and
clearing, live output relay and its sanitising, presence cleanup on disconnect,
and persistence across a restart.

`rooms-api.test.js` runs the server for real, in a throwaway data directory, over
HTTP and WebSocket: creating, renaming, listing and wiping notebooks, that an
unknown code is refused rather than conjured into an empty room, that a wipe
deletes the files, 404s the links, disconnects live editors with code `4004` and
does not let the closing socket save the room back, and that
`NBCOLLAB_ALLOW_RESET=0` takes the button and the endpoint away.

`worker-cloud.test.js` runs the Cloudflare side the same way, with the three
runtime pieces it needs faked (a socket pair, a `Response` that may carry
`status: 101`, and `ctx.storage`): creating and renaming notebooks, refusing a
socket to a notebook that does not exist, relaying edits, output and presence,
answering a ping, delaying a flood instead of dropping it, surviving an eviction
with the document — and its numbered chunks — intact, and wiping a room out from
under its clients.

`npm run cloud` puts that code under real `workerd` on `:8787` when you want to
see it work outside a fake.

There is also a browser-level check of the cell chrome, which is the only place
the reorder path can really be verified — it was a Yjs crash, not a layout bug:

```bash
npm start &
npx playwright install chromium
BASE=http://127.0.0.1:8787 node test/e2e-cells.mjs
```

Playwright is deliberately not a dependency; install it when you want this.

---

## Things worth knowing

- **Access is link-only.** Anyone with the link can join and edit. That's
  deliberate for classroom speed — don't post the link anywhere public.
- **Anyone at the lobby can clear the server.** The reset is deliberate and
  reversible only by hand (copy `data/` first if the work matters), because
  stopping a teacher at the bell to type a passphrase is worse. Harden it with
  `NBCOLLAB_ALLOW_RESET=0` if the lobby link is public.
- **"Your notebooks" is per-browser, not per-person.** No accounts exist, so the
  list is stored in `localStorage`; another computer starts with an empty list
  even though every notebook is still on the server and reachable by link.
- **Outputs are per-student.** Each browser has its own Python kernel, so two
  students can run different code on the same cell and see different results.
  The *source* is shared; the *output* is yours. Everyone else's latest run
  appears under the same cell as it happens — one entry per person, kept until
  the page reloads — but none of it is persisted and none of it is part of the
  `.ipynb` export.
- **Python boots on demand.** The Pyodide worker is created when the first cell
  runs, not on page load, so opening the notebook to read or edit costs nothing.
  The kernel log line about the runtime appears once per interpreter boot — the
  files come from the browser's cache after the first visit.
- **Moving a cell rebuilds its editor.** Yjs can't re-insert a shared type that
  has already been integrated, so a move copies the cell into a fresh `Y.Map`
  under the same id. The editor re-binds to the new text; content, id, outputs
  and remote cursors are unaffected, but the moved cell loses its undo history
  and scroll position.
- **The notebook's scrollbars are hidden.** The pane still scrolls with the
  wheel or trackpad, it just doesn't draw a bar down the edge.
- **No interrupt yet.** A runaway loop blocks that student's tab until they
  reload. A real interrupt button needs a worker terminate, which is the natural
  next step.
- **No auth or per-user ownership.** Rooms are anonymous; there's no roster.
- **No chat.** Deliberately removed: ask questions out loud or by drawing on the
  page, which is usually faster anyway. The relay code is gone from the server
  and the provider.
- **Ink isn't in the `.ipynb` export.** Drawings are presentation, not document
  content, so they stay in the room's Yjs file and nowhere else.

---

## Possible next steps

- Terminate the worker to get a working interrupt/stop button
- Persist outputs and execution counts so exports include results
- Read-only share links, so you can hand out a view-only copy
- Teacher broadcast mode: push a cell to every connected notebook
- Class access code on the room, if link-only is too open
