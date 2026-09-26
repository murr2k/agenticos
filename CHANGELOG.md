# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-09-26

First release: brain map, a read-only viewer for the tiered Markdown memory
system.

### Added

- Graph builder (`brainmap/build.py`) that walks the root `CLAUDE.md`, the
  global and per-project memory stores, skills and files the root references,
  and emits nodes, links and snapshot activity. It reads the memory schema
  through the memory-system skill's `memtool.py`, and flags broken links,
  facts missing from their index, over-budget hot files and facts past their
  volatility half-life.
- Stdlib HTTP server (`brainmap/server.py`) with four pages and three
  read-only routes (`/api/sources`, `/api/brain`, `/api/file`); sources for
  the live `~/.claude`, snapshot checkouts, and synthetic graphs.
- Canvas 2D page with six views (rings, circle, areas, links, timeline, 2.5D
  orbit), legend isolation, search with fly-to, card and file reader, health
  colouring and a light theme.
- WebGL 2D page on sigma.js and graphology, with ForceAtlas2 in a web worker.
- WebGL 3D page on 3d-force-graph, with an optional force that puts each
  memory tier on its own shell.
- Orbit page: the polar rings layout as an instanced three.js disc, with a
  parliament-chart fill per area, area hub badges, bloom and area glow, label
  declutter, and top and stack modes.
- Deterministic synthetic graph generator (`brainmap/synth.py`) for load
  testing at 2k, 10k and 50k nodes.
- One `TUNE` block per page holding every speed, count, size and threshold.
- Console benchmarks on every page, and GPU detection with software-renderer
  and context-loss banners.
- Rebuild specification (`docs/brainmap-spec.md`) for reproducing the viewer
  in an isolated environment by specification only.
- One-step launcher (`run.cmd`) on port 8770.

### Security

- Binds loopback or private/Tailscale addresses only; refuses public and
  wildcard binds; rejects unexpected Host headers (DNS rebinding).
- The file route serves only the file behind a node in the freshly built
  graph, and only `.md` and `.py`, so config files that carry secrets can
  never be served.
- Strict CSP with hash-based exceptions only: three library style blocks and
  the orbit page's import map (hashed at startup), plus `worker-src blob:`
  for the ForceAtlas2 worker.
- GET and HEAD only; pinned content types for static files.

### Fixed

- A stale graph response could stack a second renderer on the first when the
  source changed mid-load; every page now drops superseded loads.
- 3D node clicks were lost because 3d-force-graph's drag-end handler throws
  under the bundled three r183; node drag is disabled on that page.
- A false "GPU context lost" banner appeared on source switches; the watch is
  now detached before a renderer is torn down.
- The canvas 2.5D orbit threw a negative-radius error on large graphs; its
  perspective distance now scales with the largest shell.

[Unreleased]: https://github.com/murr2k/agenticos/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/murr2k/agenticos/releases/tag/v0.1.0
