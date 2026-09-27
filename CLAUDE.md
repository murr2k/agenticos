# agenticos - Claude Code Configuration

## What this is

Agentic-OS experiments on the Surrey desktop. The first piece is **brain map**:
a read-only local viewer for the tiered Markdown memory system (global store,
per-project stores, skills, the root `CLAUDE.md`), modelled on the Screen
layer's brain panel in pavrus117/ai-os-maps-guide. The Markdown files are the
store; the graph is a view the server rebuilds whenever they change, never
written back. Neo4j (via `memtool.py graph --cypher`) stays an optional
second view of the same data.

`docs/brainmap-spec.md` is the rebuild specification for the isolated work
environment, which is reproduced by specification only, never by copying
files; `docs/live-refresh-recipe.md` is the step-by-step recipe for the live
refresh (hooks, server, pages, verification). Keep both in step with
behaviour changes here, and keep them free of anything machine- or
project-specific.

**Live refresh** (2026-09-26): the global hook `~/.claude/hooks/memory_signal.py`
(PostToolUse on Write/Edit/MultiEdit/NotebookEdit/Bash/PowerShell, and Stop,
both `async`, registered in `~/.claude/settings.json` next to the snapshot
Stop hook) rewrites `~/.claude/memory.signal` when memory may have changed.
The server stats that marker every 0.5 s, stat-walks each built source every
5 s, and rebuilds hourly; pages poll `/api/version` every 2 s while visible.
The hook lives in `~/.claude`, not this repo, and the snapshot job backs it up.

Four renderers over the same `/api/brain` JSON, switchable in the header:
`/` Canvas 2D (d3 maths, hand-drawn), `/gpu` sigma.js WebGL 2D, `/3d`
3d-force-graph (three.js) WebGL 3D, and `/orbit`, an instanced three.js
orbital disc of the polar rings layout (the user's preferred view; the
scalable 3D one). Synthetic memory-shaped graphs (2k, 10k, 50k nodes) are
served as extra sources for load testing.

## Run / build / test

```powershell
# Setup (first time only). Stdlib only, nothing to pip install.
py -3 -m venv .venv

# Autostart (installed 2026-09-26): per-user Scheduled Task "agenticos brain
# map" runs .venv\Scripts\pythonw.exe brainmap\server.py --log logs\brainmap.log
# at logon, windowless, with a one-minute watchdog trigger. Re-run to update;
# -Remove to stop for good (killing the process only brings it back).
.\scripts\autostart.ps1
.\scripts\autostart.ps1 -Remove

# Run: http://127.0.0.1:8770/ (port from ~/.claude/port-registry.md). With the
# autostarted server up, this just opens the page.
.\run.cmd
.\run.cmd --snapshot C:\path\to\claude-env@murr2   # add another snapshot checkout

# Dump the graph without the server
.\.venv\Scripts\python.exe brainmap\build.py --source live --out brainmap\data\brain.json

# Synthetic sizes (default 2000,10000,50000; '' for none)
.\run.cmd --synthetic 5000,100000
```

Each page has a console benchmark that renders synchronously and waits for
the GPU (`gl.finish()` or a pixel readback), so it is valid even in a
background tab: `__brainmap2d.bench()`, `__brainmapgpu.bench()`,
`__brainmap3d.bench()` return ms per frame; `__brainmaporbit.bench()` returns
`{ms, calls}`.

## Architecture

| Path | Role |
|---|---|
| `brainmap/build.py` | Walks a source, emits `{meta, nodes, links, activity}`. Imports `~/.claude/skills/memory-system/memtool.py` for frontmatter, link resolution and ageing. `fingerprint()` is the stat-only change check over the same roots. |
| `brainmap/server.py` | `ThreadingHTTPServer`: pages `/`, `/gpu`, `/3d`, `/orbit`; `/static/*`, `/api/sources`, `/api/brain`, `/api/version`, `/api/file`. GET only. One cached `Entry` per source; the `Watcher` thread rebuilds on the hooks' marker, a stat-walk difference, or the hourly clock. |
| `brainmap/synth.py` | Deterministic synthetic graphs, same schema, Pareto-sized projects. No paths, so nothing to serve from `/api/file`. |
| `brainmap/static/app.js` | Canvas renderer, six views (rings, circle, areas, links, timeline, 3d orbit), legend isolation, card, reader. Self-contained. |
| `brainmap/static/common.js` | Shared by the three WebGL pages: palette, area model, legend, card, reader, GPU detection, context-loss banner, live refresh (`follow`, `diff`, `liveItems`). |
| `brainmap/static/gpu.js` | sigma.js + graphology; ForceAtlas2 in a web worker. |
| `brainmap/static/3d.js` | 3d-force-graph; optional `shells` force puts each tier on its own sphere. |
| `brainmap/static/orbit.js` | ES module on vendored three r183.2: polar parliament-fill layout, one `InstancedMesh` per kind, all links in one `LineSegments`, bloom, CSS2D badges with declutter, top and stack modes. |

Vendored in `brainmap/static/vendor/` (from npm; MIT except d3, which is ISC;
license texts in `vendor/licenses/`; `sourceMappingURL`
comment stripped from the two graphology files). three r183.2 lives in
`vendor/three-0.183.2/` as `three.module.min.js` + `three.core.min.js` plus
the 12 addon files the orbit page needs under `addons/` (hashes in the spec,
section 11):

| File | Version | sha256 prefix |
|---|---|---|
| `d3.v7.min.js` | d3 7.9.0 | `f2094bbf6141b359` |
| `sigma-3.0.3.min.js` | sigma 3.0.3 | `58e30383ab428f83` |
| `graphology-0.26.0.umd.min.js` | graphology 0.26.0 | `e65803eba4826a52` |
| `graphology-library-0.8.0.min.js` | graphology-library 0.8.0 | `a414340a2feb9e85` |
| `3d-force-graph-1.80.0.min.js` | 3d-force-graph 1.80.0 (bundles three r183) | `d96e738edcca580e` |

Sources: `live` is `~/.claude` plus `~/projects` (project `CLAUDE.md` files)
and the `claude-env-surrey` commit log as the timeline pulse. A snapshot
source is a claude-env style checkout (`memory/`, `projects/<slug>/memory`,
`skills/`, `machines/<user>/CLAUDE.md`), narrowed to one machine.
`~/projects/claude-env` is auto-added when present (`--no-auto` to skip).

Layers are the memory tiers: 0 root, 1 always-in-context (indexes, project
`CLAUDE.md`), 2 hot, 3 cold. Health is memtool's volatility half-life.

## Invariants & "do not regress"

- **A visualizer, never an execution interface** (Level 2 on the reference
  guide's scale: panels that read real files, no buttons that run things).
  No route, button or shortcut that runs, schedules, edits or triggers
  anything; the only actions are open (read), copy path and fly to.
  Execution happens in the Claude Code CLI, locally or through remote
  control from the phone. **Why:** the user's decision, 2026-09-26; it also
  keeps the read-only and unsteerable-file-route guarantees true by
  construction.
- The viewer never writes to any store. **Why:** the files are authoritative
  and their mtime is the memory system's review clock; an accidental touch
  resets it.
- `/api/file` serves only a path that belongs to a node in the source's
  current (server-built) graph, and nodes exist only for `.md` and `.py`; a
  linked file must also resolve to one. No path is ever joined from the
  request. **Why:** `settings.json` and MCP config under `~/.claude` carry
  secrets.
- The graph version is a content hash of nodes, links and activity (not
  `meta`), and an unchanged rebuild is discarded. **Why:** a counter would
  restart with the server and could repeat a number for new content; the hash
  also makes over-signalling free, so the hook filter can stay loose.
- The server only stats `~/.claude/memory.signal`, never opens it; the marker
  sits outside every store and every snapshot-managed directory. **Why:** an
  open handle on Windows can fail the hook's write, and a marker inside
  `hooks/` or `memory/` would make every signal a snapshot commit.
- Successful `/api/version` polls are not logged. **Why:** one line per tab
  every 2 s rotates the 3 MB log away within hours.
- The page-side diff ignores age, health, overdue and the half-life flag.
  **Why:** they drift daily by themselves; counting them would flash every
  ageing node at each hourly rebuild.
- The header stamp truncates (ellipsis) instead of wrapping. **Why:** a
  wrapping update note changed the header height and resized the stage each
  time it appeared and expired.
- Bind loopback or a private/Tailscale address only; `0.0.0.0` and public IPs
  are refused, and a Host-header check blocks DNS rebinding.
- The listening socket is exclusive (`SO_EXCLUSIVEADDRUSE`, no
  `SO_REUSEADDR`), and a second launch that finds a brain map on the port
  hands over (opens the page, exits 0). **Why:** on Windows the stdlib
  default let a second server bind 8770 alongside the first and split the
  traffic (reproduced 2026-09-26).
- Logging goes through `logging`, to a rotating file with `--log`. **Why:**
  under `pythonw` there is no stderr, so the stdlib request log and error
  printer would raise on every request.
- The autostart watchdog is its own repeating trigger, not a repetition on the
  logon trigger. **Why:** a repetition on the logon trigger only arms after a
  logon fires it, and Task Scheduler's "restart on failure" only covers
  launch failures, not a process that dies later (both verified).
- Content types for static files are pinned in `server.py`. **Why:** Windows
  `mimetypes` reads the registry, which can map `.js` to `text/plain`; with
  `nosniff` the browser then refuses the script.
- Each page script opens with one frozen `TUNE` block holding every speed,
  count, size and threshold, with units; code refers to it by name, and the
  spec's section 15 lists the defaults (regenerate that table from the blocks
  when they change). Colours stay CSS tokens; server limits stay in
  `server.py`. **Why:** tuning is one number, and the work rebuild gets the
  tuning surface from the spec instead of from prose.
- Refactors are verified by deterministic fingerprints before and after
  (synthetic-2000, motion off): pixel hashes per view on the canvas and orbit
  pages, node/edge/settings hashes on sigma, resolved-config hash on 3D.
  **Why:** the first run caught a real crash (canvas 2.5D orbit threw a
  negative `arc()` radius on big graphs; its eye distance now scales with the
  largest shell) that no eyeball test had hit.
- Area colours: eight categorical slots in fixed order, then a shared neutral.
  The palette is the validated dataviz default; do not add a ninth hue.
- CSP stays strict. `worker-src blob:` exists only for graphology's FA2
  worker; `style-src` allows exactly the three `<style>` blocks
  3d-force-graph 1.80.0 injects, by sha256 (`STYLE_HASHES` in `server.py`).
  **Why:** `'unsafe-inline'` would be the easy fix and the wrong one. Re-hash
  if that bundle is upgraded. The orbit page's inline import map is allowed
  by a `script-src` hash that `server.py` computes from the HTML at startup,
  so editing an import map needs a server restart, never a hand-copied hash.
- Orbit labels are decluttered by toggling `Object3D.visible`. **Why:**
  `CSS2DRenderer` rewrites `style.display` on every render.
- Orbit link opacity scales with `sqrt(2000 / links)` and only coloured areas
  get glow sprites. **Why:** additive blending over 100k links and hundreds
  of neutral areas saturates to white under bloom.
- Every page drops a `/api/brain` response if a newer load started while it
  was in flight. **Why:** switching source during a slow 50k fetch stacked a
  second sigma instance on the first.
- 3D node drag is off. **Why:** 3d-force-graph 1.80's drag-end handler calls
  OrbitControls' private `_onPointerCancel`, which throws under three r183 and
  swallows the click. The library also treats any pointer move during a mouse
  press as a drag and fires clicks inside `requestAnimationFrame`, so
  synthetic clicks in an automated or background tab do not register.
- The WebGL context-loss watch is detached before `kill()` / `_destructor()`.
  **Why:** those release the context on purpose, which reads as a GPU reset.

## Measured (2026-09-25, RTX 2070, Chrome, the bench() handles above)

ms per frame; synthetic graphs carry about 2.1 links per node.

| Nodes | Canvas 2D (rings) | sigma pan/zoom | sigma highlight refresh | 3d-force-graph | orbit (bloom on) |
|---|---|---|---|---|---|
| 42 (live) | 0.5 | 0.7 | - | 0.6 | 1.2 (41 calls) |
| 2k | 9 | - | 9 | 15 (6k draw calls) | 1.6 (62) |
| 10k | 26 | 0.8 | 60 | 89 (31k draw calls) | 1.7 (69) |
| 50k | 150-160 | 3.0 | 400 | not run | 2.0 (69); 1.2 bloom off (14) |

The canvas "links" view also pays a blocking d3-force pre-layout (9.8 s at
10k); sigma's ForceAtlas2 runs in a worker and never blocks. 3d-force-graph
is bound by draw calls (one mesh per node, one line per link), not by the
GPU. The orbit page is the instanced answer: draw calls stay per-kind, and a
full focus recolour at 50k costs 77 ms.

Live refresh (2026-09-26, 46-node live store): fingerprint 2-4 ms, build
56 ms (about 200 ms with the snapshot repo's `git log`). Memory write to new
server version: about 1 s by the hook's signal, 2-5 s by the stat walk alone.
The scratch-store end-to-end test (spec 14, recipe D2) passed 18/18, and the
pre/post fingerprints matched on all four pages.

## Open questions / known gaps

- Snapshot checkouts restore content but not mtimes, so global-store ages in a
  snapshot source reflect the checkout, not the fact. Project-store files
  carry harness-stamped `modified` and are accurate.
- `~/projects/claude-env` is only as fresh as its last pull; the header marks
  it stale past 7 days.
- Harness-stamped `metadata.modified` is UTC (`...Z`); memtool drops the zone
  without converting, so those `changed` times read as local and can sit in
  the future (seen on linknode-com facts). A memtool issue, not the viewer's.
- Testing live updates in an automation-driven Chrome tab: it reports
  `document.hidden`, so pages never poll. Override the property to false in
  the test; expect throttled timers.
- Repo: private, `murr2k/agenticos` on GitHub. Update `CHANGELOG.md`
  `[Unreleased]` with each change before pushing.
