# agenticos

Agentic-OS experiments. The first piece is **brain map**: a read-only, local
viewer for a tiered Markdown memory system (the root `CLAUDE.md`, a global
memory store, per-project stores, skills). The Markdown files are the store;
the graph is rebuilt from them on every request and never written back.

It is a visualizer, not an execution interface: the only actions are open
(read-only), copy path and fly to. Execution stays in the Claude Code CLI.

Inspired by the brain panel in
[pavrus117/ai-os-maps-guide](https://github.com/pavrus117/ai-os-maps-guide).

## Four renderers, one data contract

| Page | Renderer | Best for |
|---|---|---|
| `/` | Canvas 2D, d3 for maths | Six views (rings, circle, areas, links, timeline, 2.5D orbit); up to a few thousand nodes |
| `/gpu` | sigma.js + graphology, WebGL 2D | Large graphs: 50k nodes pan and zoom in about 3 ms |
| `/3d` | 3d-force-graph (three.js), WebGL 3D | Force layout in real 3D, with optional tier shells; smaller graphs |
| `/orbit` | three.js, instanced, WebGL 3D | The polar rings layout as an orbital disc with bloom; about 2 ms a frame at 50k nodes |

Every page has search, hover dimming, legend isolation, colour by area or
review health, and a card with open, copy path and fly to. Synthetic
memory-shaped graphs (2k, 10k, 50k nodes) ship as extra sources for load
testing.

## Run

Windows, Python 3.9 or later, standard library only (nothing to install):

```powershell
py -3 -m venv .venv
.\run.cmd                                   # http://127.0.0.1:8770/
.\run.cmd --snapshot C:\path\to\claude-env@user   # add a snapshot checkout as a source
.\run.cmd --synthetic 5000,100000           # choose synthetic sizes ('' for none)
.\run.cmd --host <tailscale-ip>             # view from another device on your tailnet
```

The builder reads the memory schema through `memtool.py` from the
memory-system skill (`~/.claude/skills/memory-system/`), which must be
present.

Each page exposes a console benchmark that renders synchronously and waits
for the GPU: `__brainmap2d.bench()`, `__brainmapgpu.bench()`,
`__brainmap3d.bench()`, `__brainmaporbit.bench()`.

## Design rules

- **Read-only.** No store file is ever written or touched; mtime is the
  memory system's review clock.
- **Local only.** Binds loopback or a private/Tailscale address; public and
  wildcard binds are refused; a Host-header check blocks DNS rebinding.
- **An unsteerable file route.** It serves only the file behind a node in the
  graph it just built, and only `.md` and `.py`.
- **No third-party requests.** Every library is vendored; strict CSP with
  narrowly scoped, hash-based exceptions.
- **One tuning block per page.** Every speed, count, size and threshold lives
  in a single `TUNE` object at the top of each script.

## Layout

| Path | What |
|---|---|
| `brainmap/build.py` | Walks the stores and emits the graph JSON |
| `brainmap/server.py` | Stdlib HTTP server: pages, static files, three read-only API routes |
| `brainmap/synth.py` | Deterministic synthetic graphs for load testing |
| `brainmap/static/` | The four pages, shared helpers, styles, vendored libraries |
| `docs/brainmap-spec.md` | Complete rebuild specification, including tuning defaults, failure modes and acceptance tests |
| `CLAUDE.md` | Project notes: invariants, measurements, open questions |
| `CHANGELOG.md` | Release history |

## Third-party code

Vendored under `brainmap/static/vendor/`, license texts in
`brainmap/static/vendor/licenses/`:

| Library | Version | License |
|---|---|---|
| d3 | 7.9.0 | ISC |
| sigma | 3.0.3 | MIT |
| graphology | 0.26.0 | MIT |
| graphology-library | 0.8.0 | MIT |
| 3d-force-graph | 1.80.0 | MIT |
| three | 0.183.2 | MIT |
