# Live refresh: build recipe

How to make the brain map follow the memory system as it changes: hooks
signal a change, the server rebuilds its graph in the background, and the
pages pick up the new version without a reload, keep their view, and flash
what changed.

This is a recipe to follow, not code to copy. It contains no source. Every
step says what to build, how it must behave, and how to check it. It assumes
the viewer already exists as described in `brainmap-spec.md`; section 4.6
(server) and 6.5 (pages) there are the contract, and this is the order of
work that meets it. Placeholders in angle brackets are yours to choose:

| Placeholder | Meaning | Reference choice |
|---|---|---|
| `<claude>` | the Claude Code config directory | `~/.claude` |
| `<marker>` | the signal file | `<claude>/memory.signal` |
| `<hook>` | the signal script | `<claude>/hooks/memory_signal.py` |
| `<python>` | absolute path of a Python 3 interpreter | the one your other hooks use |

---

## 0. The design in one paragraph

Three layers, each cheap, each covering what the one before it cannot see.
(1) Claude Code hooks rewrite one marker file whenever a tool call or the end
of a turn could have changed the memory; the server stats that file twice a
second. (2) Every 5 s the server takes a stat fingerprint (names, sizes,
mtimes, never contents) of every file its builder reads, which catches edits
no hook saw. (3) Every hour it rebuilds anyway, so ages follow the clock. A
rebuild whose content hash is unchanged is thrown away, so over-signalling
is free. Pages poll a tiny version route every 2 s while visible and fetch the
graph only when the version moves.

Why the hook matters even with the stat walk: the memory system restores a
file's mtime when it re-files one (mtime is its review clock). A same-size
edit with the mtime put back is invisible to any stat walk on Windows; only
the hook sees it.

---

## Part A. The signal hook (Claude Code side)

### A1. Choose the marker

- Put it **outside every memory store** (the viewer must never find it as a
  node) and **outside every directory a backup or snapshot job copies** (or
  every signal becomes a backup commit). A single file directly in
  `<claude>` is usually right; check your backup job's include list before
  choosing a subdirectory such as `hooks/` or `state/`.
- Nothing else about it matters. Its content is informational only; readers
  look at its size and modification time.

### A2. Write the script `<hook>`

Standard library only. It reads one JSON object from standard input (the hook
event), decides whether the event could have changed anything the graph
shows, and if so overwrites `<marker>`. Decision table:

| Event | Bump the marker when |
|---|---|
| `hook_event_name` is `Stop` | always (end of turn: catches whatever a script or subagent changed) |
| `tool_name` is `Write`, `Edit`, `MultiEdit` or `NotebookEdit` | the edited path (`tool_input.file_path`, or `notebook_path`), after expanding `~`, is named `CLAUDE.md` in any letter case, anywhere; or ends in `.md` or `.py` and lies under `<claude>` (compare case-insensitively on Windows, where paths arrive in any case) |
| `tool_name` is `Bash` or `PowerShell` | `tool_input.command` contains, case-insensitively, any of: `.claude`, `memtool` (or your memory tool's name), `memory`, `MEMORY.md`, `CLAUDE.md` |
| anything else | never |

Rules for the script:

1. The bump overwrites the marker with one line: a nanosecond timestamp, the
   event name and the tool name. No paths, no content.
2. It never reads or writes any memory store file.
3. It prints nothing on standard output or standard error.
4. It catches every exception, including invalid or empty input, and always
   exits 0. A signal must never block or fail a turn.
5. The filter is deliberately loose. A false signal costs the viewer one
   rebuild it then discards; a missed one leaves the view stale until the
   stat walk (5 s) or, for the invisible edit above, the hourly rebuild.

### A3. Register it

In the **user-level** Claude Code settings (`<claude>/settings.json`), so it
fires in every project:

- A `PostToolUse` entry with matcher
  `Write|Edit|MultiEdit|NotebookEdit|Bash|PowerShell` and one command hook:
  `"<python>" "<hook>"`, timeout 10 s, `async: true`.
- A `Stop` entry (no matcher) with the same command, timeout and `async`.
  If a Stop hook already exists (for example a backup job), add this one
  **alongside** it; never replace it.

How to edit the file safely:

- Merge with a JSON-aware script: load, append to the arrays, write back with
  the file's own indentation, then load it again to prove it still parses. A
  malformed settings file silently disables every setting in it.
- Make the merge idempotent (skip an entry whose command is already there).
- While doing so, print only structure (event names, matchers, script file
  names), never values: the settings file can carry secrets under `env`.
- Keep a copy of the original in a scratch directory until the checks pass.
- If the installed Claude Code rejects `async`, drop it. The hook then adds
  one interpreter start (about 60 ms on Windows) to each matching tool call.

### A4. Check it

1. **Pipe-test the raw script** before registering it. Write a small test
   script that builds each payload as a data structure, encodes it as JSON,
   runs `<python> <hook>` with it on standard input, and checks the exit code,
   the (empty) output and whether the marker appeared (delete the marker
   before each case). Do not hand-type JSON containing Windows paths into a
   shell: the shell layer can eat the backslashes, the hook then receives
   invalid JSON and correctly ignores it, and that looks like a filter bug.
   Cases and expected results:

   | Case | Bump |
   |---|---|
   | Edit of a file in the global store (backslash path) | yes |
   | Write of a cold file in a project store, path in odd letter case | yes |
   | MultiEdit of a `.py` file under `<claude>/skills/` | yes |
   | Edit of a project's `CLAUDE.md` outside `<claude>` | yes |
   | Edit of the global index given as a `~/...` path | yes |
   | Edit of an ordinary source file in some repository | no |
   | Edit of `<claude>/settings.json` | no |
   | Shell `ls -la` | no |
   | Shell command running the memory tool | yes |
   | PowerShell moving a file into the global store's `cold/` | yes |
   | A `Read` of a memory file (not in the matcher) | no |
   | `Stop` event | yes |
   | Invalid JSON on standard input | no |
   | Empty standard input | no |

   All 14 must exit 0 with no output.
2. **Prove it fires live.** After registering, delete the marker and run one
   harmless shell command whose text mentions `.claude`. The marker must
   appear. If it does not, the session has not reloaded its settings: open
   the `/hooks` menu once, or start a new session.

---

## Part B. The server

### B1. A stat fingerprint in the builder

Add a function next to the graph builder that returns a hash of the path,
size and modification time (in nanoseconds) of every file the builder reads,
plus the change time on POSIX systems (setting a file's times moves its
change time, so this catches the mtime-restoring edit there; on Windows the
"ctime" field is the creation time, so use 0). Walk exactly the builder's
roots:

1. the root instructions file, and every `.md`/`.py` it mentions by
   `~/.claude/...` path that exists;
2. every `*.md` anywhere under the global store;
3. each skill directory's `SKILL.md`;
4. for each project store directory the builder would include (same slug
   filter), every `*.md` under its `memory/`; list only those `memory/`
   subtrees, never the whole project directory (it holds session
   transcripts);
5. each project directory's `CLAUDE.md`;
6. the activity repository's `.git/logs/HEAD` (every commit and pull
   appends to it).

Details that matter:

- Use the directory-listing call that returns each entry's stat data with
  the listing (in Python, the scandir family). On Windows this costs no extra
  call per file. The reference store fingerprints in 2 to 4 ms.
- Sort entries by name so the hash is stable.
- Do not follow directory links.
- A file that is expected but missing contributes a distinct placeholder, so
  its appearing or disappearing changes the hash.
- Never read file contents, except the root file (for its mentions).

### B2. A cache entry per source

Replace build-per-request with one entry per source holding:

- `current`: one immutable record of (graph, the graph encoded as JSON once,
  version, first-built time). Swap it whole; never mutate it.
- a lock; the fingerprint the current build was made from; `checked` (time of
  the last rebuild, changed or not); `error` (the last rebuild's failure);
  the monotonic time of the last rebuild; a pending due time and reason.

Behaviour:

- **Get**: if there is no current record, take the lock, check again, and
  build (reason "first request"). Otherwise return the record as it stands.
  Requests never wait for a rebuild except the very first.
- **Rebuild(reason)**, under the lock:
  1. Take the fingerprint **first** (a file that changes during the build then
     shows up on the next walk).
  2. Build. On an exception: store the fingerprint, time and error, log it
     with the traceback, and keep serving the last good record; re-raise only
     if there is no record yet.
  3. Version = SHA-256 of the nodes, links and activity serialised with sorted
     keys and compact separators; keep the first 16 hex characters. Leave the
     metadata out (it carries the build time).
  4. If the version equals the current one: update `checked` and stop. Do not
     log at the normal level.
  5. Otherwise write the version into the graph's metadata, encode the body
     once, swap the record, and log the source, version, reason, node and
     link counts and build time.
- **Schedule(now, reason, delay)**: set a due time only if none is pending.
  The first change opens the window; everything inside it shares one rebuild.

### B3. The watcher thread

A daemon thread, started only after the listening socket is bound (a launch
that hands over to an already running server must build nothing):

1. Build the live source first, so the first page load is instant. Swallow
   a failure (it is logged; the first request retries).
2. Remember the marker's (size, mtime), or "absent". Only stat it, never
   open it: on Windows an open handle can make the hook's write fail.
3. Every 0.5 s:
   - Stat the marker. Different from last time means **signalled**.
   - When 5 s have passed since the last walk, this is a **walk** tick.
   - For each source that has been built and is not synthetic, if nothing is
     pending: signalled schedules a rebuild at now + 0.4 s ("signal");
     else on a walk tick, a fingerprint that differs from the entry's
     schedules one at now + 0.4 s ("files changed"); else an entry not
     rebuilt for 3600 s schedules one now ("clock").
   - Run every rebuild whose due time has passed.
   - Catch and log any exception from a tick; the thread must never die.

Sources other than live join the watcher once something has requested them.
Synthetic sources are never watched.

### B4. Routes and logging

- `/api/brain?src=K`: send the current record's pre-encoded body.
- `/api/version?src=K`: `{src, version, built, checked, error}`. Building on
  first request applies here too.
- `/api/file`: find the node in the current record's graph; keep every
  existing check, and add one: when the node's file is a link, what it
  resolves to must also end in `.md` or `.py`.
- Unknown source 404; a first build that fails 500 with the reason.
- In the request log, skip successful `/api/version` requests.
- Add a `--signal FILE` option, default `<marker>`.

### B5. Check the server on its own (before touching any page)

Run the end-to-end test in Part D, step D2. It needs no browser.

---

## Part C. The pages

Do step D1 (baseline fingerprints) **before** editing any page script: a
server that reads static files on each request serves your edits at once.

### C1. Tuning

Add a `live` group to each page's `TUNE` block:

| Page | Keys and reference defaults |
|---|---|
| canvas | pollMs 2000, flashMs 6000, pulseMs 1000, ringPx 12, noteMs 120000 |
| sigma | pollMs 2000, flashMs 6000, blinkMs 500, bornJitter 8, noteMs 120000 |
| 3D | pollMs 2000, flashMs 6000, blinkMs 500, bornJitter 6, noteMs 120000 |
| orbit | pollMs 2000, flashMs 6000, pulseMs 900, pulseGain 1.2, noteMs 120000 |

Remove any older fixed-interval refresh (for example a 60 s re-fetch with a
signature comparison) and its key.

### C2. Shared helpers

In the shared script used by the WebGL pages (the canvas page keeps its own
copy of the same logic):

- **follow(options)**: every `pollMs`, if the tab is visible, nothing is in
  flight, and a graph is on screen, request `/api/version` for the current
  source. On an answer, clear the "down" state, store the reported error, and
  if the answer is for the source still selected and its version differs
  from the one on screen, await the page's update function. On a network
  failure, record the time of the first failure. Also poll immediately when
  the tab becomes visible. Return the status object.
- **diff(before, after)**: added ids, removed ids, and changed ids, where a
  node's comparison key is its kind, label, area, layer, tier, type,
  volatility, path, note, changed time, body line count and flags minus any
  half-life flag. Age, health and overdue are left out on purpose.
- **live stamp items**: "! server not answering since HH:MM" while down;
  else "! rebuild failed, showing the last good graph" with the error as
  tooltip; and "updated HH:MM: +N new, N changed, N removed" (omit zero
  parts) for `noteMs` after an update.

### C3. The update function, per page

Common shape: remember the current load sequence number **without**
advancing it; fetch `/api/brain`; give up silently on failure (the next poll
retries); drop the result if a load started meanwhile; diff against the graph
on screen; apply; re-bind the selection by id (re-render the card, or close
it if the node is gone); drop a legend isolation that matches nothing; redo
the search matches; set the delta for the stamp; start the flash.

- **Canvas**: call the normal ingest path in its "not first" mode. It must
  already carry each node's old position into the new data and tween to the
  new targets without refitting. New nodes tween from the centre.
- **sigma**: patch the existing graph object; never rebuild the renderer.
  Drop nodes that are gone; clear all edges; for each node in the new data,
  merge label and raw data into an existing node (positions untouched) or add
  a new one at its area seed; re-add the edges exactly as the first build
  does; move each new node to the mean position of its neighbours that
  existed before, plus a random offset of up to half of `bornJitter` in each
  axis; recompute sizes and colours. Do not restart the force layout.
  Factor the first build into seed nodes, add edges and style nodes, and
  share the last two with the patch.
- **3D**: factor the preparation of node and link objects out of the
  renderer setup, with an optional "previous nodes by id". With it, copy
  x, y, z from the previous object of the same id, and start each new node
  at a placed neighbour plus up to half of `bornJitter` per axis. Mark the
  view as kept, so the "fit after N ticks" and "fit when the layout stops"
  handlers do nothing, then hand the library the new data.
- **Orbit**: the layout is deterministic, so use the normal load path with a
  "keep" flag: do not reset selection, isolation or search, do not show the
  loading message, re-run layout and scene build, and do not fit the camera.
  The disc may grow or shrink slightly with the node count.

### C4. The flash

Flash the added and changed nodes for `flashMs`; with
`prefers-reduced-motion`, make every flash steady.

- **Canvas**: in the node drawing pass, after the selection rings, stroke a
  ring around each flashing node in the ink colour at radius (node radius +
  selection gap + phase x `ringPx`), where phase is the position within the
  current `pulseMs`, with alpha (1 - phase) x (1 - elapsed / `flashMs`).
  The frame loop must keep drawing while a flash is live and clear it when
  it expires.
- **sigma**: keep the flashing ids in a set and toggle an "on" flag every
  `blinkMs`, refreshing without re-indexing. In the node reducer, a flashing
  node on the "on" half gets `highlighted`, a forced label and the top
  z-index; test for it before the "nothing is highlighted, return the stored
  attributes" fast path, and make that fast path still apply to every other
  node.
- **3D**: the node colour accessor returns the ink colour for a flashing node
  on the "on" half; re-apply the accessors on each toggle. Above the "big"
  band, stay steady: each toggle re-evaluates every object.
- **Orbit**: the recolour pass gives flashing nodes the ink colour (which
  blooms in the dark theme). Each frame of the flash, scale each flashing
  node's instance by 1 + `pulseGain` x (1 - cos(2 pi t / `pulseMs`)) / 2 and
  mark the render dirty. Hub badges and the root have hidden meshes, so give
  their HTML labels a `flash` class and set a CSS custom property to
  `pulseMs` for the animation period. At the end, remove the classes and
  restore positions and colours.

### C5. The header stamp

- Put the live items right after the build time and counts.
- Let the stamp take the space the bar leaves and truncate with an ellipsis
  instead of wrapping: flexible basis about 14em, minimum width 14em,
  hidden overflow, ellipsis, right-aligned, no wrapping. Set its tooltip to
  its full text. Otherwise the update note wraps the bar onto a second line,
  the stage shrinks, and it grows back when the note expires.
- CSS: the update note in the ink colour; a keyframe pulse for the orbit
  badges (an ink box shadow expanding to transparent) with a steady outline
  under reduced motion.

---

## Part D. Verification

### D1. Deterministic fingerprints, before and after

Use the method in spec 6.4 (synthetic 2000-node source, motion off, dark
theme, the same browser tab and window size before and after). Take the
baseline before any page edit and again after all of them. Every hash must
match: live refresh must not change a first render.

### D2. End-to-end against a scratch store (no browser)

Never use the real store. Write a test script that:

1. Creates a scratch checkout in a temporary directory, in snapshot shape:
   `machines/<user>/CLAUDE.md`; `memory/MEMORY.md` indexing two hot facts,
   one linking to the other; `projects/<slug for a demo project>/memory/`
   with an index and one hot fact. Frontmatter as the memory system writes
   it (name, description, and a metadata block with type, tier,
   volatility).
2. Fingerprints the real live store (to prove later that nothing touched it).
3. Starts a second server on a spare port with the scratch checkout as a
   snapshot source, no synthetic sources, no automatic sources, a scratch
   marker (`--signal`) and a scratch log.
4. Runs the checks below, polling `/api/version` every 0.1 s with a timeout.
5. Stops the server, then checks the log and the real store's fingerprint.

| Step | Expect |
|---|---|
| read `/api/sources`, `/api/version`, `/api/brain` | the scratch source is listed; the version has all five fields and no error; the brain's metadata carries the same version |
| add a hot fact and its index line, no signal | new version in under about 6 s; the node exists |
| wait over a second, bump the scratch marker, change nothing | `checked` moves, version does not |
| move a hot fact into `cold/`, set `tier: cold`, restore its mtime | new version; the node's kind is cold detail, layer 3 |
| edit a fact without changing its size, restore its mtime | size and mtime unchanged; no new version within 7 s on Windows |
| then bump the scratch marker | new version within about 1 s; the node shows the edit |
| delete a fact | new version; the node is gone |
| file route for a node / for an unknown id | 200 / 404 |
| version route for an unknown source; a POST | 404; 405 |
| the live source's version | present (built eagerly at startup) |
| the scratch log | no version poll lines; one line per new version, with its reason |
| the real store's fingerprint | unchanged |

Reference result: 18 of 18. Signal to version about 1 s; stat walk 2 to 5 s.

### D3. Pages in a browser

Run the scratch server again and open each page on the scratch source (set
each page's saved preferences to it). For each page:

1. If the tab reports `document.hidden` (an automation-driven tab can), the
   pages will rightly never poll. Override the property to return false for
   the test, and expect updates in 5 to 15 s rather than 2, because the
   browser still throttles the really-hidden tab's timers.
2. Move the camera off its default, then record its state: canvas, the zoom
   transform of the canvas element; sigma, the camera state; 3D, the camera
   position; orbit, the camera position.
3. From outside the browser, add a fact to the scratch store and bump the
   scratch marker.
4. Expect: the node count rises by one, the new node exists, the camera state
   is identical, the stamp shows "updated HH:MM: +1 new, 1 changed" (the
   index changed too) on a single header line, the page still has exactly one
   renderer (count its canvases), and the console has no errors.
5. Check the flash: sample the new node's state several times over two
   seconds (sigma: its display data's `highlighted`; 3D: the colour accessor)
   and expect both states, then the plain state once `flashMs` has passed.
   On canvas and orbit, a screenshot during the flash shows the rings or the
   white pulsing node.

Also do one re-tier on the orbit page: the node moves to the outer cold row as
a cold-detail shape and flashes.

### D4. Put it into service

Restart the long-running server (for an autostart task, stop and start the
task) so it runs the new code. Confirm that `/api/version?src=live` answers,
that its version equals the one a fresh test instance computed for the same
content, and that the log shows the startup build.

---

## Part E. Operating notes

- **Latency**: a memory write through Claude Code reaches a visible page in
  about 1 to 3 s (signal, settle, build, next poll). Edits Claude Code did not
  make arrive within about 5 s plus a poll. A hidden tab catches up the
  moment it becomes visible.
- **Cost**: the marker is one stat twice a second; the walk a few
  milliseconds every 5 s; each Stop event triggers one rebuild per built
  source, discarded when nothing changed.
- **Removing it**: delete the two hook entries and the script. The viewer
  still refreshes through the stat walk and the hourly rebuild; only the
  invisible mtime-preserving edit then waits for the hour.
- **Other consumers**: the marker is generic. Anything else that wants to
  know "the memory may have changed" can stat it the same way.
- **Still Level 2**: the hooks run inside Claude Code and write one file
  outside every store; the viewer only stats it. No control in the viewer
  runs, schedules, edits or triggers anything.
