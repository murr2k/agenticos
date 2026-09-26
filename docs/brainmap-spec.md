# Brain map: rebuild specification

A read-only local viewer for a tiered Markdown memory system, with four
renderers over one data contract. This document is the complete specification
for rebuilding it in an isolated environment. It describes behaviour, data
contracts, constants and known failure modes. It deliberately contains no
source code: implement from the spec, verify against the acceptance tests in
section 14.

- Reference build: 2026-09-25, Windows 11, Chrome, Python 3.14 (3.9+ is
  enough), i7-9700K + RTX 2070.
- Visual inspiration: the "Screen" layer brain panel in the public guide
  `pavrus117/ai-os-maps-guide` (six views of the same nodes on one canvas).

---

## 1. Non-negotiables

1. **Read-only.** The Markdown files are the store. The graph is derived on
   every request and never written back. The viewer must not open any store
   file for writing, touch it, or change its mtime: mtime is the memory
   system's review clock.
2. **Local only.** Bind loopback (or a private address), never a public or
   wildcard address. No cookies, no login, no third-party JavaScript, no CDN.
   Every library is a vendored local file.
3. **Standard library only on the server.** Python stdlib, no pip installs. A
   project venv may exist for convention, but nothing is installed into it.
4. **Strict CSP.** No `unsafe-inline`, no `unsafe-eval`. Section 11 lists the
   only exceptions (a blob worker, three library style blocks and one import
   map, each allowed narrowly) and why.
5. **The file route cannot be steered.** It serves only the file behind a node
   in the graph it just built, and nodes exist only for `.md` and `.py`. No path
   is ever joined from request input. Config files that carry secrets
   (`settings.json`, MCP config) can never become nodes.
6. **A visualizer, not an execution interface.** On the reference guide's
   three-level scale (1: a graph you look at; 2: panels that read your real
   files; 3: buttons that run things) this is deliberately Level 2. No route,
   button or shortcut runs, schedules, edits or triggers anything; the only
   actions are open (read), copy path and fly to. Execution stays in the
   Claude Code CLI. Adding a Level 3 control would break rules 1 and 5 by
   construction, so it is out of scope, not merely deferred.

---

## 2. Input: the memory system contract

The builder assumes this layout and schema. If the local memory system ships
its own parser/tool (a `memtool`-style helper), import it and use it rather
than writing a second reader of the schema; the graph must agree with it.

### 2.1 Locations

| Thing | Path | Loaded |
|---|---|---|
| Root instructions | `~/.claude/CLAUDE.md` | every session |
| Global store | `~/.claude/memory/` with `MEMORY.md` index, hot `*.md`, `cold/*.md` | index `@import`ed by the root |
| Project stores | `~/.claude/projects/<slug>/memory/` | index auto-loaded in that project |
| Project instructions | `<projects dir>/<name>/CLAUDE.md` | in that project |
| Skills | `~/.claude/skills/<dir>/SKILL.md` | descriptions always, body on demand |

`<slug>` is the project path with every non-alphanumeric character replaced
by `-` (for example `C:\Users\u\projects\foo-bar` gives
`C--Users-u-projects-foo-bar`). Resolve a slug to a project name by computing
the slug of each directory in the projects dir and matching; fall back to
stripping the `<slug of projects dir>-` prefix.

### 2.2 Frontmatter fields used

```
name, description,
metadata.type        user | feedback | project | reference
metadata.tier        hot | cold            (default hot)
metadata.volatility  stable | evolving | volatile   (default evolving)
metadata.links       [names]               related edges
metadata.cold        [names]               hot -> cold pointers
metadata.modified    ISO timestamp         harness-stamped; else use file mtime
```

A minimal parser is enough: `---` fenced block, top-level scalars, one nested
mapping level (`metadata`), inline `[a, b]` lists and block `- item` lists.

### 2.3 Identity and links

- A memory's identity is its **filename stem**, compared
  separator-insensitively: lowercase, `_` equals `-`, any directory prefix
  dropped. Also accept `name:` as an alias.
- Index entries are Markdown links whose target ends in `.md`:
  `](name.md)` or `](cold/name.md)`.
- Body wikilinks are `[[name]]` (letters, digits, `_`, `-`).
- Resolve links within the same store first; if not found and the store is a
  project store, try the global store. Anything still unresolved is a broken
  link.

### 2.4 Age and health

- Age in days = now minus `metadata.modified` if present, else file mtime.
- Half-life by volatility: stable none, evolving 90 d, volatile 30 d.
- Health: `stable` (no half-life), `overdue` (age > half-life), `due`
  (age >= 0.75 x half-life), else `fresh`. Store `overdue` as age minus
  half-life (negative means days left).
- Hot-file budget: 50 **body** lines (frontmatter excluded).

---

## 3. The graph contract (JSON)

One document per source, served by `/api/brain`:

```
{ meta: { source, label, built, root, nodes, links, last_snapshot,
          activity_repo, synthetic? },
  nodes: [ Node ],
  links: [ { s, t, kind } ],
  activity: [ { day: "YYYY-MM-DD", runs, files, cats: [..] } ] }
```

### 3.1 Node

| Field | Meaning |
|---|---|
| `id` | unique; see ids below |
| `kind` | `root`, `doc`, `index`, `project`, `memory` (hot), `detail` (cold), `skill` |
| `label` | display name; index nodes are `<area>/MEMORY.md` so hubs are distinguishable |
| `area` | `core` (root and root-referenced files), `global`, `skills`, or a project name |
| `layer` | 0 root, 1 always-in-context (indexes, project nodes, referenced files), 2 hot and skills, 3 cold |
| `path`, `rel` | absolute path, and the same with home as `~` and forward slashes; `null` when there is no file |
| `dir` | true when `path` is a directory (the "open" action is disabled) |
| `note` | description or first prose paragraph, whitespace-collapsed, clipped to 320 chars |
| `changed` | ISO local time (modified stamp or mtime) |
| memory only | `type`, `tier`, `volatility`, `age`, `health`, `overdue`, `lines` |
| `flags` | list of problems, shown on the card (section 3.4) |

Ids: `root`, `global:index`, `global:<key>`, `<project>:index`,
`<project>:<key>`, `project:<name>`, `skill:<name>`, `doc:<relpath>`.

### 3.2 Edges (undirected, deduplicated)

| kind | from -> to | rank |
|---|---|---|
| `import` | root -> global index | 6 |
| `loads` | project -> its index (or -> its hot files if no index) | 5 |
| `index` | index -> each hot file it lists | 4 |
| `lists` | the global inventory memory -> each project it lists | 4 |
| `detail` | hot -> cold (from `metadata.cold`) | 3 |
| `skill` | root -> each skill | 2 |
| `ref` | root -> each `.md`/`.py` it mentions as `~/.claude/<path>` | 2 |
| `scope` | root -> a project the inventory does not list | 1 |
| `related` | memory -> memory (links + wikilinks, minus cold pointers) | 0 |

Deduplicate on the unordered pair; when two rules produce the same pair, keep
the higher rank. Drop self-links and links to missing nodes.

Project inventory: if the global store has an inventory memory whose Markdown
table rows contain `~/projects/<name>`, those are "listed" projects; use the
row's last cell as the project note. Include a project when its store has at
least one memory file or a non-empty index, or when it is listed and its
directory exists.

A root-mentioned path that already belongs to a node (for example a skill or a
memory file) links to that node instead of creating a `doc` node.

### 3.3 Activity (optional timeline pulse)

If a git repository represents routine runs (for example a repo a hook commits
to), read `git log -n 2000 --format=%aI<TAB>%s` and bucket by day: `runs` =
commits, `files` and `cats` parsed from subjects matching
`<N> file(s) (<cat>, <cat>)` when present. `last_snapshot` = newest commit
time. No repo: empty activity, `last_snapshot` null.

### 3.4 Flags

`past <volatility> half-life by N d`, `not in MEMORY.md` (hot file missing
from its index), `over 50 lines`, `broken link: x`, `broken cold pointer: x`,
and on index nodes `dead entry: x` (index lists a file that does not exist).

---

## 4. Server

### 4.1 Routes (GET and HEAD only; anything else is 405 with a JSON error)

| Route | Returns |
|---|---|
| `/`, `/index.html` | canvas page |
| `/gpu` | WebGL 2D page |
| `/3d` | WebGL 3D page (force layout) |
| `/orbit` | WebGL orbital disc page (instanced three.js) |
| `/static/<path>` | only files present under `static/` at startup (a fixed whitelist map, built once) |
| `/api/sources` | `[ {key, label} ]` |
| `/api/brain?src=KEY` | the graph, built fresh on every call |
| `/api/file?src=KEY&id=NODE` | `{id, path (rel), truncated, text}` for that node's file; 512 KB cap |

Unknown route, source or node: 404 JSON. Compact JSON (no spaces).

### 4.2 Security and headers

- **Bind check:** accept `localhost`, loopback, private ranges and
  `100.64.0.0/10` (Tailscale CGNAT). Refuse `0.0.0.0`/`::` and public IPs, and
  exit with a message.
- **Host header check:** accept only `127.0.0.1:<port>`, `localhost:<port>`
  and `<bound host>:<port>`; otherwise 403. This blocks DNS rebinding, which
  would otherwise let a hostile web page read files through the file route.
- **Headers on every response:** `Cache-Control: no-store`,
  `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and the
  CSP below.
- **Content types are pinned** for `.js`, `.css`, `.html`, `.svg`. Do not
  trust `mimetypes` on Windows: it reads the registry, which can map `.js` to
  `text/plain`, and with `nosniff` the browser then refuses to run it.
- **CSP:**

```
default-src 'none'; script-src 'self' <sha256 of each inline import map>;
style-src 'self' <the three 3d-force-graph hashes from section 11>;
img-src 'self' data: blob:; connect-src 'self'; font-src 'self';
worker-src 'self' blob:; base-uri 'none'; form-action 'none';
frame-ancestors 'none'
```

Compute the import-map hashes at startup from the page files themselves
(find each `<script type="importmap">...</script>`, SHA-256 its exact inner
text, base64), so the policy can never drift from the page. Editing a page's
import map needs a server restart.

### 4.3 Sources

- `live`: the paths in 2.1, plus the optional activity repo.
- Snapshot checkouts (optional): any directory holding a copy of the stores
  in the same shape can be registered as another source. Note that a copy
  restores content but not mtimes, so ages there reflect the copy unless the
  files carry `metadata.modified`.
- `synthetic-N`: section 5. Default sizes 2000, 10000, 50000; configurable.

### 4.4 Launcher

A one-step script at the project root that runs the server with the project
venv's interpreter, forwards extra arguments, opens the browser **after** the
socket is bound (from the server, not from the script, or the browser races
the bind), and on failure prints a setup hint and pauses. Take the port from
the local port registry if one is kept (the reference build used 8770); do
not default to 3000/5000/8000/8080/8888.

---

## 5. Synthetic graph generator

Deterministic (seeded PRNG, cached per size), same schema as section 3, no
paths, notes and labels marked synthetic, `meta.synthetic = true`. The pages
show a "synthetic data" tag whenever it is set.

- Global store: `max(4, N/150)` hot facts under a global index; root imports it.
- Skills: `min(40, 6 + N/500)`.
- Projects: `max(6, min(600, remaining/60))`, sizes proportional to Pareto
  (alpha 1.3) weights. Each has a project node (listed by the first global
  fact), an index, hot facts, and cold details (15% chance per item once a hot
  exists, attached to a random hot).
- Related links per hot: pick 0, 1, 1, 2 or 3; half by preferential attachment
  (earlier facts favoured, exponential index), half uniform within the project.
  Plus cross-project links (hot count / 25) and hot-to-global links
  (hot count / 40). Result: about 2.1 links per node.
- Volatility weights stable 4 : evolving 5 : volatile 1; age exponential with a
  60-day mean; types weighted project 3 : reference : feedback : user.
- Activity: 180 days, runs per day drawn from {0,0,0,1,1,2,3,5}.
- Reference sizes: 50k nodes gives about 106k links and 20 MB of JSON, built
  in about 0.5 s.

---

## 6. Shared front-end specification

### 6.1 Tokens

Dark is the default look; light is a separate set of steps, not an inversion.
A header toggle switches them and is remembered.

| Token | Dark | Light |
|---|---|---|
| page | `#0d0d0d` | `#f9f9f7` |
| surface (stage) | `#1a1a19` | `#fcfcfb` |
| raised (panels) | `#232321` | `#ffffff` |
| ink | `#ffffff` | `#0b0b0b` |
| ink-2 | `#c3c2b7` | `#52514e` |
| muted | `#898781` | `#898781` |
| grid | `#2c2c2a` | `#e1e0d9` |
| axis | `#383835` | `#c3c2b7` |
| other (shared neutral hue) | `#6b6a65` | `#a9a8a2` |

Categorical slots 1-8 (fixed order; the order is the colour-blind-safety
mechanism):

| Slot | Dark | Light |
|---|---|---|
| 1 blue | `#3987e5` | `#2a78d6` |
| 2 orange | `#d95926` | `#eb6834` |
| 3 aqua | `#199e70` | `#1baf7a` |
| 4 yellow | `#c98500` | `#eda100` |
| 5 magenta | `#d55181` | `#e87ba4` |
| 6 green | `#008300` | `#008300` |
| 7 violet | `#9085e9` | `#4a3aa7` |
| 8 red | `#e66767` | `#e34948` |

Validated adjacent-pair colour-blind separation: worst Delta E 8.4 dark,
9.1 light. Only the first three slots survive an all-pairs test, which is why
area identity is also carried by position, legend and labels.

Status (health) colours, never reused as series: good `#0ca30c`, warning
`#fab219`, critical `#d03b3b`, always paired with an icon and a text label
(check, `!`, cross).

Type: `system-ui, -apple-system, "Segoe UI", sans-serif`; monospace for paths
and the file reader.

### 6.2 Colour assignment

Order areas: `core`, `global`, `skills`, then by node count (descending), then
name. Hand slots 1-8 to the first eight areas after `core`; every later area
gets the shared neutral. `core` is drawn in ink. Colour follows the area, never
its rank under a filter: isolating an area must not repaint the others.

Colour-by modes: **area** (above) and **health** (status colours; non-memory
nodes neutral).

### 6.3 Layout and chrome

- Header bar: brand; renderer switch (canvas, webgl 2d, webgl 3d, orbit) as links;
  source select; colour-by segment; search box; display toggles; a right-aligned
  stamp.
- Stamp: `built HH:MM`, node and link counts, snapshot age (marked with `!` and
  the warning colour when older than 7 days), frame cost, GPU name on WebGL
  pages, and `synthetic data` when applicable. A failed refresh shows
  `! refresh failed HH:MM, showing HH:MM` rather than hiding old data.
- Legend panel bottom-left: area (or review status) with swatches and counts,
  kinds with shape icons, memory types, and an edge key. Clicking an entry
  isolates it (others dim or hide); clicking again or "clear" resets. With
  more than 30 areas, list the top 30 and a "+ N more areas" row.
- Card panel top-right on selection: label; chips for kind, area (swatch),
  type, tier and volatility; changed time and age; health with icon and text
  ("past evolving half-life by N d", "review in N d"); body line count; note;
  path; flags in the warning colour; buttons **open** (file reader),
  **copy path**, **fly to**; linked-node chips (click to select and fly).
- File reader: modal overlay with the rel path, a close button, and the file
  text in a monospace `pre`. Build every dynamic element with `textContent`,
  never `innerHTML` with data. Any `[hidden]` element must stay hidden even
  when a class sets `display:flex` (add `[hidden] { display:none !important }`).
- Search: substring over label, note, path and area; matches highlighted,
  others dimmed. Enter selects the best match: label matches outrank note
  matches, then higher degree.
- Keyboard: `/` search, `Esc` closes the reader, then clears the selection, then
  the isolation; `f` fit; canvas page also `1`-`6` views, `n` names, `m` motion.
- Preferences (source, view, colour mode, toggles, theme) in `localStorage`,
  every access wrapped in try/catch; the page must work without it.
- Refresh every 60 s while visible; re-ingest only when a signature of
  (ids, changed, flag counts, health, link count) differs, keeping positions.
- **Load sequencing:** each load takes a sequence number; a response that
  arrives after a newer load started is discarded.

### 6.4 One tuning block per page

Each page script opens with a single frozen `TUNE` object, grouped (layout,
sizes, look, motion, camera, labels, picking, frame), with a unit on every
entry, and the code refers to it by name. Every speed, count, size and
threshold lives there exactly once, so tuning is one number. Three things stay
out: colours (CSS tokens, which the theme toggle needs), server limits (in the
server), and values computed from the graph (only their inputs go in the
block). Text offsets and shape proportions are drawing detail and stay where
they are drawn. Section 15 lists every page's keys and defaults.

A refactor that touches the block must not change behaviour unless it means
to. Verify with deterministic fingerprints taken before and after, on a
synthetic source with motion off: hashes of the rendered pixels per view for
the canvas and orbit pages, and hashes of every node's size, colour and label,
every edge and every renderer setting for the sigma page, and of the resolved
configuration for the 3D page.

---

## 7. Canvas page (`/`): d3 for maths, Canvas 2D for drawing

d3 supplies force simulation, zoom/pan transform, scales and easing only; it
never touches the DOM for drawing.

### 7.1 Render loop

- `requestAnimationFrame` loop that draws only when something changed or is
  animating (tween, idle motion, orbit spin, live simulation).
- Positions live in world units; every draw maps world to screen through the
  zoom transform, so strokes stay 1 px and text stays 11 px at any zoom.
  Node radius scales by `clamp(sqrt(k), 0.55, 2.6)`.
- Canvas sized to device pixel ratio.
- Draw order: guides, links, nodes, labels, selection and hover rings.
- Node radius (world): `3.2 + 1.7 * sqrt(degree)`; root at least 13; cold x0.8.
- Shapes by kind: root circle with an outer ring; hot circle; index square;
  cold diamond; skill triangle; project hexagon; referenced file pentagon.
  Each node gets a 1.5 px surface-coloured outline.
- Glow (shadow blur) only in dark mode, only for layer <= 1, and only when the
  graph has at most 2000 nodes: shadow blur is expensive.
- Links: structural kinds straight; `related` as a gentle quadratic arc; cold
  `detail` dotted. With a hovered or selected node, its links are drawn in its
  colour at 0.85 alpha and everything else fades to about 0.04.
- Labels: halo of 3 px surface colour. Always the root; project nodes only in
  the links and orbit views (the other views have area tags); hovered or
  selected node and its neighbours; all when "names" is on. Place greedily by
  priority (focus, neighbours, degree), try right then left, skip on
  collision.
- Hit test: nearest node whose screen distance is within `max(r + 3, 8)` px.
- View changes tween every node from its current position to the new target
  over 850 ms (1300 ms on first load, blooming out from the centre),
  cubic in-out; guides fade in with the same tween.
- Idle motion (toggle, default off under reduced-motion): wobble of 1.8 world
  units with periods 1.5 s and 1.9 s and a per-node phase, in rings, circle and
  areas only.
- Fit: bounding box of targets plus padding, into the viewport minus the
  legend (left 250 px) and card (right 360 px) on wide screens. When the page
  is hidden, apply the transform instantly instead of transitioning (see 12.3).
- Zoom extent 0.15 to 12. Double-click a node: select, fly to, open the file.

### 7.2 The six views

1. **rings**: root at the centre; one ring per layer that has nodes. Each area
   gets an angular sector weighted by its largest per-layer count, with a gap
   of `min(0.06, 0.4 * PI / areaCount)` radians between sectors. Ring radius
   `R[L] = max(R[L-1] + 105, max over areas of count * 24 / sectorWidth)`.
   Within a sector, nodes of a layer are spread evenly, sorted by kind then
   label. Area tags sit 30 units outside the outermost ring the area uses.
2. **circle**: every node on one ring ordered by area, layer, label, with a
   1.6-slot gap between areas; radius `max(230, slots * 21 / 2PI)`. Links are
   quadratic curves pulled 80% of the way toward the centre.
3. **areas**: one phyllotaxis cluster per area (spacing 17, golden angle
   2.39996 rad, ordered by layer then degree), cluster radius
   `17 * sqrt(n) + 12`, clusters around a circle sized to fit them, `core` at
   the centre. Faint circle and tag per cluster.
4. **links**: d3 force. Link distance by kind (import 70, loads 40, index 45,
   lists 90, skill 70, ref 60, scope 110, detail 28, related 55); strength 0.2
   for related, 0.55 otherwise; charge -700 root, -220 layer 1, -95 others,
   `distanceMax` 600; collide at r + 4; x/y centring 0.035; root pinned at the
   origin. Pre-run the simulation synchronously so the fit targets the settled
   picture: 320 ticks, 60 above 3k nodes, 12 above 20k (this pre-run blocks
   the page; see section 13). Reuse the settled result until the graph changes.
   Drag a node in this view to pin it while dragging and reheat.
5. **timeline**: shared time axis. Top half: activity bars (runs per day,
   one hue, rounded tops, min 5 px wide, centred on the day, hover tooltip with
   runs, files, categories), baseline and a max-runs gridline. Bottom half: one
   lane per area (at most 30; the rest share one "N more areas" lane), nodes at
   their `changed` time with a small beeswarm offset to avoid overlap (cap the
   collision search at 400 nodes per lane), undated nodes in a column at the
   left, a dashed "now" marker. Links hidden except the focused node's.
6. **3d orbit** (2.5D): each node gets a point on a shell of radius
   `0.95 * R[layer]` from the rings model: longitude from its ring angle,
   latitude in three bands (`((i % 3) - 1) * spread` plus a small per-node
   jitter; spread 0.25 on layer 1, 0.5 otherwise). Each frame rotate about the
   vertical axis (0.00014 rad/ms while motion is on and nothing is selected),
   tilt 0.62 rad about x, perspective divide `f = P / (P + z)` with
   `P = max(1400, 4 x the largest shell radius)`, sort back to front, scale
   size by `f` and alpha by depth (0.3 to 1). Draw each used shell's equator
   as a projected ellipse. (A fixed `P` smaller than the shells puts
   near-side nodes behind the eye; see 12.17.)

---

## 8. WebGL 2D page (`/gpu`): sigma.js + graphology

- Build an undirected graphology graph. Node attributes: `x`, `y`, `size`,
  `color`, `label`, and the original node under `raw`. **Never set a `type`
  attribute:** in sigma it selects the rendering program, and a memory type
  such as `project` crashes the renderer.
- Seed positions per area: area centres on a circle of radius
  `sqrt(N) * 14`, points within `sqrt(areaCount) * 8`, from a seeded PRNG. The
  force layout then refines a sane picture instead of untangling noise.
- Sizes (px): `min(16, 2 + 1.4 * sqrt(degree))`, x0.7 above 10k nodes, x1.8
  below 500; root at least 10. Edge size 0.4 above 10k, else 0.7.
- Settings: z-index on; labels 11 px system font in ink-2;
  `labelRenderedSizeThreshold` 9 above 10k, 0 below 500, else 5;
  `labelDensity` 0.6; `labelGridCellSize` 90; default edge colour grid above
  5k nodes, else axis; hide edges and labels while moving above 20k; camera
  ratio 0.005 to 20; stage padding 40.
- Custom hover drawer: surface-filled rounded label box with an axis border,
  a 1.5 px ink ring around the node, semibold ink text. The default drawer is a
  white box that looks wrong on the dark theme.
- Layout: ForceAtlas2 in its web worker (`FA2Layout`), settings from
  `inferSettings(graph)` with Barnes-Hut above 1500 nodes. Auto-stop after 4 s
  (under 2k), 9 s (under 12k) or 30 s; a toggle restarts it.
- Reducers: node and edge reducers implement focus (hover or selection plus
  neighbours), search matches and legend isolation (hidden). Give both an idle
  fast path that returns the stored attributes when nothing is active.
  Hover-highlighting is disabled above 20k nodes (each refresh costs about
  0.4 s at 50k); click still highlights.
- Fly to: animate the camera to the node's display position at ratio 0.12 over
  700 ms. Fit: animated camera reset.
- GPU detection on load: create a WebGL context, read
  `WEBGL_debug_renderer_info` for the unmasked renderer, show the GPU name in
  the stamp, and show a warning banner if it is a software rasteriser
  (SwiftShader, llvmpipe, "software", "Basic Render"). No WebGL at all: a
  critical banner; the canvas page still works.
- Context loss: listen for `webglcontextlost` on every WebGL canvas and show a
  critical banner ("GPU context lost, reload"). **Detach these listeners
  (AbortController) before `renderer.kill()`**, which releases contexts on
  purpose and otherwise raises a false alarm.

---

## 9. WebGL 3D page (`/3d`): 3d-force-graph (three.js)

- Construct with `new ForceGraph3D(element, { controlType: 'orbit' })`
  (1.80 API). Size it to the stage and update on resize.
- Data: copies of the nodes plus `{source, target, kind}` links; node value
  `30` for the root, else `1 + 0.8 * degree`; root fixed at the origin.
- Settings: background = surface; nav info off; `nodeRelSize` 2 above 20k,
  else 3; `nodeResolution` 4 above 20k, 6 above 5k, else 12; opacity 0.95;
  link opacity 0.08 above 20k, 0.14 above 5k, else 0.28; link width 0 (1 px GL
  lines) except focused links at 0.8 with 2 directional particles (width 1.6,
  speed 0.006, only while fewer than 200 links are lit); cooldown 25 s above
  20k, 18 s above 5k, else 12 s; velocity decay 0.3; charge -12 / -25 / -60 by
  the same size bands; link distance by kind (import 40, loads 18, index 22,
  lists 50, skill 40, ref 35, scope 60, detail 12, related 30); warm-up 120
  ticks under 3k nodes.
- **Shells force** (toggle, default on): for each node,
  `base = 38 * cbrt(N)`, target radius `[0, 0.4, 0.78, 1.0][layer] * base`;
  add `(target - r) / r * 0.12 * alpha` times the position vector to its
  velocity. This is the real-3D version of the canvas page's orbit.
- Tooltip via `nodeLabel`: it is inserted as HTML, so escape every value.
- Hover/selection: recolour non-focus nodes to axis colour and re-set the
  colour, width, link colour and particle accessors to force re-evaluation.
  Disable hover restyling above 20k nodes.
- Camera: fit once 40 engine ticks have run and again when the engine stops,
  unless the user has already moved the camera (listen for the controls'
  `start` event). Tie the first fit to ticks, not a timer (see 12.3). Fly to:
  camera 90 units outside the node along its radius, looking at it, 1200 ms.
  Auto-rotate at speed 0.5 when motion is on and nothing is selected.
- **Node drag off** (see 12.7).
- Above 8000 nodes show a banner: this library draws one mesh per node and one
  line per link, so draw calls, not the GPU, set the frame rate; the 2D WebGL
  page is the one built for that size.
- Stamp shows real frames per second from a `requestAnimationFrame` counter,
  or "paused (tab hidden)" when the page is hidden.

---

## 10. Orbital disc page (`/orbit`): instanced three.js

The polar "rings" layout rendered in real 3D, with a camera that orbits and
tilts the disc. It uses three.js directly (not 3d-force-graph), loaded as ES
modules through an import map, and instancing, so it stays fast at any size
tested. It is the recommended 3D view.

### 10.1 Layout (deterministic, no simulation)

The disc lies in the x-z plane with y up; angle 0 points along +x and angles
increase clockwise seen from above, starting at 12 o'clock (-z).

- **Rings by kind, outward:** root at the centre; skills evenly spaced on an
  inner ring at `max(45, 0.55 * rin)`; the **memory band** from `rin`
  outward; referenced files evenly spaced on a ring 40 beyond the band's
  outermost row; a **runs** ring 36 beyond that; a rim 44 beyond the runs.
- **Band membership:** project, index, hot and cold nodes. Each area has a
  **hub**: its project node, else its index, else its best-connected node.
- **Spacing:** mean dot spacing `S = clamp(10 * sqrt(300 / bandCount), 10, 22)`
  (small graphs spread out so labels fit). Dots along an arc are `0.72 S`
  apart; arc rows are `1.35 S` apart. The anisotropy is what makes rows read
  as arcs rather than radial spokes.
- **Radii:** `rin = max(110, areaCount * S * 1.2 / 2PI + 18)`;
  target band outer radius
  `rout = max(rin + 70, 1.08 * sqrt(rin^2 + 2 * 1.35 * 0.72 * S^2 * bandCount / span))`,
  where `span = 2PI - gap * areaCount` and
  `gap = min(0.05, 0.4 PI / areaCount)` radians between sectors.
- **Sectors:** areas in the palette order of 6.2, widths proportional to
  `(count - 1)^0.8` (floor 1). Big areas get wider sectors and, packed into
  the same band, denser rows; small areas stay a tight cluster.
- **Fill (parliament chart):** the hub sits at the sector's mid angle at
  `rin - 16`. The remaining members, sorted index first, then hot by degree
  (descending), then cold, fill arc rows from the inner edge outward. Row `j`
  is at `rin + (j + 0.5) * 1.35 s`, holds `c = floor(sectorAngle * r / (0.72 s))`
  slots, and slot `q` sits at `sectorStart + (q + off) * sectorAngle / c`
  with `off = 0.25` on even rows and `0.75` on odd rows (a half-slot stagger).
  A final partial row is centred on the mid angle with the same stagger. If
  the sector cannot hold the area inside `rout` at spacing `S`, shrink that
  area's spacing to `s = 0.98 * S * sqrt(capacity / count)`.
- **Sizes (world units):** root 9; project hub `min(7, 4 + 0.35 sqrt(deg))`;
  index 3 (a hub index `min(6.5, 4 + 0.3 sqrt(deg))`); skill 2.6; file 3.4;
  hot `min(4.2, 1.3 + 0.5 sqrt(deg), 0.36 s)`; cold x0.85.
- **Heights:** flat mode offsets by layer `[3, 1.5, 0, -1.5]` (root, layer 1,
  hot, cold); **stack** mode lifts layer L to `[1.45, 0.95, 0.45, 0][L] * H`
  with `H = 0.22 * rout`, tweened over 900 ms (cubic in-out). Rings, glows and
  labels move with their tier.
- **Runs ring:** one radial tick per day with runs over the last 120 days,
  today at 12 o'clock and time running backwards counter-clockwise; tick
  length `4 + min(26, 5 * runs)`, in categorical slot 1.

### 10.2 Rendering

- One `InstancedMesh` per node kind, unlit (`MeshBasicMaterial`), per-instance
  colour and matrix; shapes: root and project hexagonal prisms, index cube,
  hot sphere, cold octahedron, skill tetrahedron, file dodecahedron.
  Frustum culling off (positions move with stack).
- All links in one `LineSegments` with vertex colours, coloured by the
  endpoint further from the root (so root spokes take the colour of the area
  they reach). In dark mode links blend additively, with opacity
  `clamp(0.28 * sqrt(2000 / linkCount), 0.03, 0.28)` so large graphs read as
  a haze instead of saturating to white. Focus links are a second small
  `LineSegments`, rebuilt on focus change, at 0.95 opacity.
- Rings are 256-segment line loops in the axis colour; ring names are HTML
  labels at 12 o'clock.
- **Glow:** a radial-gradient sprite per coloured area (areas holding a
  categorical slot only; neutral areas get none), centred on the area's
  cloud, scale `2.6 * (rmsSpread + 14)`, additive in dark mode at opacity
  0.11 (0.07 for the root), normal blending at 0.08 in light mode. Plus an
  `UnrealBloomPass` (strength 0.55, radius 0.4, threshold 0.18, which sits
  above the neutral hue's luminance so only saturated colours bloom) followed
  by an `OutputPass`. Bloom runs only in dark mode with glow on; otherwise
  render directly.
- Core nodes (root, referenced files) use secondary ink in area mode: white
  blooms into a blob. The root itself is drawn as an outlined hexagon
  (circumradius 11, in ink) with its name beneath in monospace; its mesh is
  hidden but still picks.
- **Labels** via `CSS2DRenderer` (an HTML overlay with pointer events off):
  ring names; hub badges (coloured circle with the area's initial, the area
  name, its count) for the 30 biggest areas plus global; optional node names
  (top 400 by degree). A badge sits on its hub at the band's inner edge,
  with the circle centred on the hub, and **is** the hub: the hub's mesh is
  hidden (it still picks). This is how the reference reads.
- **Label declutter:** whenever the camera settles or positions change,
  project each badge and name, estimate its box from its text length, place
  greedily by priority (badges by area size, then names by degree), and hide
  any that would overlap. Toggle `Object3D.visible`, not `style.display`:
  `CSS2DRenderer` rewrites `display` on every render.

### 10.3 Camera and interaction

- `PerspectiveCamera` (fov 45) with `OrbitControls` (damping 0.08,
  auto-rotate speed 0.35 while motion is on, nothing is selected and no
  camera tween runs).
- **Fit:** frame the rim radius `R = rRim + 24`. Tilted view: camera at polar
  angle 55 degrees, distance `max(R * 0.8 / tan(fov/2), 1.02 R / (tan(fov/2) * aspect))`
  (a tilted disc is shorter than it is wide). **Top** view: polar angle near
  0, distance `1.04 R / tan(fov/2)` (aspect-limited likewise), which is the
  flat 2D rings picture.
- `camera.setViewOffset` shifts the projection by
  `(cardWidth - legendWidth) / 2` so the disc centres in the space the legend
  (250 px) and card (360 px) leave free; re-apply when the card opens or
  closes.
- **Picking in screen space:** project every node (cached until the camera,
  size or positions change), pick the nearest within
  `max(7, projected radius + 4)` px. Hover shows the shared tooltip and
  focuses the node and its neighbours (non-focus instances recoloured to the
  axis colour, their links to black in dark mode, glows dimmed to a quarter);
  click selects (card) if the pointer moved 5 px or less; double-click opens
  the file.
- Search and legend isolation use the same focus mechanism.
- Fly to: tween target and camera over 1100 ms, keeping the view direction,
  to a distance `max(70, 0.3 * rRim)`.
- Render on demand only: when controls report a change, a tween runs, or
  something is marked dirty.
- Toggles: top, stack, names, glow, motion, fit, theme; keys `t`, `s`, `n`,
  `m`, `f`, `/`, `Esc`.
- Stamp: GPU name, fps (or "idle" / "paused (tab hidden)"), draw calls per
  frame, synthetic tag. Console `bench(frames)` renders synchronously through
  the same path (bloom included) and returns ms per frame and draw calls.

---

## 11. Vendored libraries

Fetch from npm (or an internal mirror), verify, and serve from
`static/vendor/`. All MIT except d3, which is ISC; keep each library's license
file alongside it (`static/vendor/licenses/`). Hashes are of the files exactly
as published.

| npm package | File in package | Size | SHA-256 |
|---|---|---|---|
| `d3@7.9.0` | `dist/d3.min.js` | 279,706 | `f2094bbf6141b359722c4fe454eb6c4b0f0e42cc10cc7af921fc158fceb86539` |
| `sigma@3.0.3` | `dist/sigma.min.js` | 187,876 | `58e30383ab428f832068d9d16a5215c65ba12430d438ed091c5703f398de9e16` |
| `graphology@0.26.0` | `dist/graphology.umd.min.js` | 73,629 | `dc337efa23903f61e064c8e7e7f93a429e6855dccfc2458802b4ed30c621c087` |
| `graphology-library@0.8.0` | `dist/graphology-library.min.js` | 168,452 | `5323729ec6d4ac5d98a245873646c27fd80c7234df13972faec5869f3c54a105` |
| `3d-force-graph@1.80.0` | `dist/3d-force-graph.min.js` | 1,313,897 | `d96e738edcca580edd524730c1c6b05ed2efce028c23ca95db1bf43033a72e42` |

Globals: `d3`, `Sigma`, `graphology` (`graphology.UndirectedGraph`),
`graphologyLibrary` (`FA2Layout`, `layoutForceAtlas2`), `ForceGraph3D`.
3d-force-graph bundles its own three.js r183 internally.

The orbit page uses **three@0.183.2** as ES modules (no global), served under
`static/vendor/three-0.183.2/` with the package's `examples/jsm/` files under
`addons/` in the same sub-folders. The two addons of interest pull in the
rest; the full closure is these 14 files:

| File (package path) | Size | SHA-256 |
|---|---|---|
| `build/three.module.min.js` | 359,158 | `0a61c95f14e0fa015b3083475c73424f360e5f6f5b74c282b50fdbc2f4c228fc` |
| `build/three.core.min.js` | 382,617 | `0a9c2f0672c7b8d993ba7639e71919db181ca50c9dff99c78476d3e19057ca9c` |
| `examples/jsm/controls/OrbitControls.js` | 40,484 | `09673b997864b8091943d2673637c0f31f7cf67daeddd0902fce9bf098a8d093` |
| `examples/jsm/renderers/CSS2DRenderer.js` | 7,384 | `dc5f4c5075a3a330b7e679da943343dd86a0f2d745422194b5287e48d7204197` |
| `examples/jsm/postprocessing/EffectComposer.js` | 8,501 | `4e079a5886152d7e529a59aef644e968ab4d32c6a33ce016b36bf29b2eac26f7` |
| `examples/jsm/postprocessing/RenderPass.js` | 4,280 | `817f6c3cdcd0fd41515d112359ea0532568eefb5aabd3b33903957ebca1b8a6a` |
| `examples/jsm/postprocessing/UnrealBloomPass.js` | 14,921 | `1158bb02f6467889aba19c1a788b9107054d7f6a558498b5e2152db5873bb859` |
| `examples/jsm/postprocessing/OutputPass.js` | 4,184 | `02e4a261af34de71338185e9e87f0cbe5cba9115608d984363e1269dec1d2272` |
| `examples/jsm/postprocessing/ShaderPass.js` | 3,228 | `e2500a5913b26bbf5148ceaae644c6edcff06a18b01494ee37bf856353d2ab9d` |
| `examples/jsm/postprocessing/MaskPass.js` | 4,694 | `7cd08eee9d5d6f5578beaddbdcbe9c384f6873810af27f22ab7db3ceeb127aa3` |
| `examples/jsm/postprocessing/Pass.js` | 4,218 | `444b409c235ead986893c472e720da1b779a56985c7d10b279c7944b52bd61c5` |
| `examples/jsm/shaders/CopyShader.js` | 729 | `a33057d5ac91c43304c186ac0e8816e62bb2ed471d3a00ff3018dfd5c0389718` |
| `examples/jsm/shaders/LuminosityHighPassShader.js` | 1,291 | `5044f780b6e6cf863947f64c36fe1587132f7fbe395ada863cd1e5f0388dcf1e` |
| `examples/jsm/shaders/OutputShader.js` | 1,876 | `353479f77a8d7e2629d49ccac9fc2f5dbfdda5442e0adf867b00377a2fcb0cb2` |

The addons import the bare specifier `three`; `three.module.min.js` imports
`./three.core.min.js` relatively. The page's inline import map is exactly:
`{"imports":{"three":"/static/vendor/three-0.183.2/three.module.min.js","three/addons/":"/static/vendor/three-0.183.2/addons/"}}`.
The `three/addons/...` strings that appear inside the addon files are JSDoc
examples, not imports. None of these files uses `eval` or `new Function`.

The two graphology files end with a `sourceMappingURL` comment; stripping it
only silences a developer-tools 404 for the missing `.map`. It changes their
hashes, so record whichever bytes you serve.

**CSP exceptions, and the only ones:**

- `worker-src blob:`: graphology's ForceAtlas2 starts its worker from a blob
  URL of its own code.
- `style-src` hashes: 3d-force-graph 1.80.0 injects exactly three `<style>`
  blocks (`.graph-info-msg`, `.float-tooltip-kap`, `.scene-nav-info`). Allow
  them by hash, not with `unsafe-inline`:
  - `'sha256-0/4q5IwejFb2zgHlQwwtwmGHS8ZbXE1kmz/TkRFlZ7M='`
  - `'sha256-9xjtvxMT1ApHlgn9ohbh2FNfvK5Tqtzy94BjfXBeMSY='`
  - `'sha256-yfc2FhpkFR0EAy3T+zDsaAFGXSP9B3ELNvaJKDzNhkk='`

  If the bundle version changes, recompute: find each string literal passed to
  the bundle's style-inject helper, JSON-decode it, SHA-256 the UTF-8 bytes,
  base64 the digest.
- `script-src` hash for each inline import map (section 4.2): import maps are
  inline scripts, so without their hash the orbit page cannot resolve
  `three`. Computed at startup, never hand-copied.
- Stay on 3d-force-graph's default `d3` force engine. Its alternative `ngraph`
  engine generates code with `new Function`, which the CSP (correctly) blocks.

---

## 12. Known failure modes (all hit in the reference build)

1. **Windows MIME map.** `.js` served as `text/plain`, blocked by `nosniff`.
   Pin content types (4.2).
2. **`[hidden]` overridden** by a class with `display:flex`; the file reader
   showed on load. Force `[hidden]` to `display:none !important`.
3. **Background tabs.** No animation frames, so transitions and camera tweens
   stall part-way and look like wrong zoom levels. Chrome also throttles timers,
   heavily after a few minutes hidden. Snap transforms instantly when
   `document.hidden`, and drive "after layout" actions from engine ticks, not
   timers.
4. **sigma `type` attribute** selects the node program; never store the memory
   type there.
5. **False GPU-reset banner** after switching source: `kill()` and
   `_destructor()` release WebGL contexts deliberately. Abort the listeners
   first.
6. **Load race.** Switching source during a slow fetch rendered two sigma
   instances stacked on one element. Sequence-guard every load (6.3).
7. **3D clicks lost.** 3d-force-graph 1.80's drag-end handler calls
   OrbitControls' private `_onPointerCancel`, which throws under three r183 and
   swallows the click that ended the "drag". Disable node drag. Also note: the
   library treats any pointer move during a mouse press as a drag and dispatches
   clicks inside `requestAnimationFrame`, so scripted or background-tab clicks
   do not register; test the click path by invoking the click handler.
8. **Injected styles vs CSP** (section 11) and **tooltip HTML** (escape it).
9. **Many areas break layouts.** A fixed sector gap times 600 areas exceeds
   2 PI; scale the gap. Also cap area tags (top 30 by size), timeline lanes
   (30) and legend rows (30).
10. **Canvas force pre-layout blocks the main thread** for seconds at 10k+;
    scale the pre-run ticks down with size.
11. **Label ambiguity.** Every index was labelled `MEMORY.md`, and hubs are the
    nodes that get labels; include the area.
12. **Snapshot copies** carry content but not ages; prefer `metadata.modified`.
13. **Orbit: radial spokes instead of arcs.** With equal spacing along and
    across rows, adjacent rows hold nearly the same number of dots and line up
    radially. Tighter spacing along the arc, a wider row pitch and a
    half-slot stagger fix it (10.1).
14. **Orbit: white-out.** Pure white core nodes, additive glow for hundreds of
    neutral areas, and 100k additive link lines all saturate under bloom.
    Core in secondary ink, glow only for coloured areas, link opacity scaled
    by count, bloom threshold above the neutral hue (10.2).
15. **Orbit: labels.** `CSS2DRenderer` has no collision handling and resets
    `style.display` every frame; declutter by toggling `Object3D.visible`
    (10.2). Badges on the inner ring crowd when areas are many or small;
    declutter keeps the biggest areas' badges. Badges extend to the right of
    their anchor, so their declutter box must too.
16. **Orbit: clicks in tests.** With motion on, the disc turns between a
    screenshot and a scripted click; switch motion off before testing picks.
17. **Canvas 2.5D orbit: negative scale.** With a fixed perspective distance
    of 1400 and shells wider than that (the 2k synthetic set), near-side
    nodes land behind the eye, the scale factor goes negative, and
    `arc()` throws a negative-radius error that kills the render loop. Scale
    the eye distance with the largest shell (7.2). Found by the
    deterministic fingerprint run, not by eye.

---

## 13. Scale guidance and measured baseline

Measured with a synchronous benchmark on each page (render N frames, then
`gl.finish()` or a 1-pixel `getImageData` readback so GPU and rasteriser work
is counted, even in a background tab). Expose it as a console handle per page
returning ms per frame. Reference machine: i7-9700K, RTX 2070, Chrome.

| Nodes | Canvas 2D (rings) | sigma pan/zoom | sigma highlight refresh | 3d-force-graph | orbit (bloom on) |
|---|---|---|---|---|---|
| 42 | 0.5 | 0.7 | - | 0.6 | 1.2 (41 draw calls) |
| 2k | 9 | - | 9 | 15 (about 6k draw calls) | 1.6 (62) |
| 10k | 26 | 0.8 | 60 | 89 (about 31k draw calls) | 1.7 (69) |
| 50k | 150-160 | 3.0 | 400 | not run | 2.0 (69); 1.2 with bloom off (14) |

Other reference points: canvas links-view pre-layout 9.8 s at 10k (blocking);
sigma 50k load to first render 2.4 s including a 20 MB fetch; orbit 50k load
to first frame under 1.8 s, and a full focus recolour (every instance plus
106k link colours) 77 ms. Draw calls on the orbit page are per kind plus the
bloom passes, independent of node count.

Reading it:

- Almost everything is **single-threaded JavaScript on the main thread**:
  canvas path calls, sigma's buffer rebuild on any highlight change,
  3d-force-graph's per-object draw calls, JSON parsing, d3 layout. Per-core
  speed matters; extra cores sit idle apart from the one ForceAtlas2 worker.
- **Canvas 2D** is right up to a few thousand nodes and needs no GPU.
- **sigma** is the choice for large stores: panning and zooming stay cheap
  because the GPU holds the geometry. Highlights cost a full rebuild.
- **3d-force-graph** is for smaller subsets: one mesh per node and one line per
  link makes it draw-call bound.
- **The orbit page is the scalable 3D view.** Instancing (section 10) keeps a
  frame near 2 ms at 50k nodes with bloom. Its layout is deterministic, so
  there is no simulation to wait for; the cost that grows is a focus recolour
  (77 ms at 50k).
- A browser tab's JavaScript heap is capped at roughly 4 GB regardless of
  system RAM. At a few hundred thousand nodes, layout time and that cap become
  the wall: precompute positions server-side (where multiple cores can help,
  via multiple processes) or use a GPU layout library, and send positions
  with the graph.
- Before trusting WebGL numbers on any machine, confirm the GPU line in the
  stamp. Remote desktop sessions (unless GPU use is enabled for them),
  virtual machines and browser policies that disable hardware acceleration
  can fall back to a software rasteriser, which is slower than Canvas 2D
  (`chrome://gpu` or `edge://gpu` confirms).
- A GPU driver reset (a TDR on Windows) kills every WebGL context on the page;
  the context-loss banner exists for that.

---

## 14. Acceptance tests

Server:

- `/`, `/gpu`, `/3d`, `/orbit`, every vendored file: 200 with pinned content
  types (the three modules must be `text/javascript`).
- The CSP carries one `script-src` hash per inline import map, and the orbit
  page loads with no CSP report.
- `/static/../server.py` sent raw (no client path normalisation) and
  URL-encoded (`%2e%2e`): 404.
- `/api/file` with an id that is not a node, or a synthetic node: 404.
- `POST` to any route: 405. `Host: evil.example:<port>`: 403. Unknown `src`:
  404.
- Binding `0.0.0.0` or a public address: refused at startup.
- After a full session of use, no store file's mtime has changed.

Graph:

- Live counts match the memory tool's own store listing (hot and cold per
  store).
- Every broken link and over-budget hot file the memory tool's lint reports
  appears as a flag, except links that resolve through the global-store
  fallback (2.3), which lint may count as broken.
- No node has a path outside the store, project and skill roots, and none ends
  in anything but `.md` or `.py`.

Pages (on real data and on each synthetic size):

- All six canvas views render, tween, fit, and label without overlap.
- Legend isolation, search with Enter, card open/copy/fly, reader, `Esc`
  chain, theme toggle, colour-by health with overdue rings.
- Switching source rapidly (including mid-load of the largest synthetic)
  leaves exactly one renderer and the last-chosen source.
- Orbit: tilted and top views fit the rim; stack tweens tiers apart and back;
  names and badges never overlap after any camera move; click selects with
  motion off; light theme renders without bloom or additive haze; at 50k the
  band reads as a ring, not a white blow-out.
- WebGL pages show the real GPU name; no context-loss banner on a source
  switch; zero console errors, including CSP reports.
- Run the four benchmarks and compare with section 13.

---

## 15. Tuning defaults

Generated from each page's `TUNE` block (6.4); these are the reference
defaults. The sections above say what each value does. Distances are world
units unless a key ends in `Px`; keys ending in `Ms` are milliseconds;
angles are radians unless a key says `Deg`.

Canvas page (`app.js`):

| Group | Keys and defaults |
|---|---|
| `data` | refreshMs 60000, staleDays 7 |
| `node` | base 3.2, slope 1.7, rootMin 13, coldScale 0.8, zoomMin 0.55, zoomMax 2.6, timelineScale 0.7 |
| `areas` | tagAllUpTo 40, tagTop 30 |
| `rings` | gapMax 0.06, gapShare 0.4, minArc 24, step 105, tagPad 30 |
| `circle` | gapSlots 1.6, slotArc 21, radiusMin 230, tagPad 30, pull 0.8 |
| `clusters` | spacing 17, angle 2.39996, pad 12, gap 30, centreGap 50, ringPad 6 |
| `force` | distance { import 70, loads 40, index 45, lists 90, skill 70, ref 60, scope 110, detail 28, related 55 }, distanceDefault 50, strength 0.55, strengthRelated 0.2, chargeRoot -700, chargeLayer1 -220, charge -95, chargeRange 600, collidePad 4, centring 0.035, seedJitter 40, ticks 320, ticksOver3k 60, ticksOver20k 12, dragAlpha 0.25 |
| `timeline` | halfWidth 420, padDays 3, barBase -50, barTop -250, barMinPx 5, barRadiusPx 4, barDimmed 0.45, lanesMax 30, laneSpan 320, laneMin 18, laneMax 36, laneTop 40, undatedX -450, swarmTries 14, swarmStep 4, swarmCap 400, swarmPad 3 |
| `orbit` | tilt 0.62, perspective 1400, perspectiveOfRadius 4, shellScale 0.95, latSpread1 0.25, latSpread 0.5, latJitter 0.3, startAngle 0.6, speed 0.00014, depthFade 0.62, depthMin 0.3, fitScale 1.25, fitAspect 0.85, equatorSteps 72 |
| `motion` | wobble 1.8, periodX 1500, periodY 1900, phaseY 1.3, frameCapMs 64 |
| `camera` | zoomMin 0.15, zoomMax 12, fitZoomMax 4, fitPadPx 32, boundsPad 70, boundsPadLinks 30, viewMs 850, firstMs 1300, reloadMs 800, fitMs 700, flyMs 900, flyZoom 2.2 |
| `draw` | linkHot 0.85, linkDimmed 0.035, linkFocus 0.5, linkOff 0.03, linkStructural 0.26, linkRelated 0.34, linkMin 0.01, linkBend 0.18, linkHotWidth 1.5, nodeDimmed 0.13, glowMaxNodes 2000, glowRoot 22, glow 12, outline 1.5, rootRingGap 5, rootRingAlpha 0.45, overdueGap 4, selectGap 6, cullPx 40 |
| `labels` | fontPx 11, haloPx 3, gapPx 4, boxHalfPx 7, cullXPx 50, cullYPx 20, tipNoteChars 160 |
| `pick` | padPx 3, minPx 8 |
| `frame` | legendPx 250, cardPx 360, wideMinPx 900 |

WebGL 2D page (`gpu.js`):

| Group | Keys and defaults |
|---|---|
| `bands` | small 500, dimEdges 5000, big 10000, huge 20000 |
| `size` | base 2, slope 1.4, max 16, bigScale 0.7, smallScale 1.8, rootMin 10, edge 0.7, edgeBig 0.4, edgeFocus 1.4 |
| `seed` | radius 14, spread 8, prng 42 |
| `labels` | size 11, density 0.6, gridPx 90, threshold 5, thresholdBig 9, thresholdSmall 0, forceFocus 80, forceMatches 60 |
| `hover` | gapPx 6, padPx 4, cornerPx 4, ringGapPx 4, ringWidth 1.5 |
| `camera` | minRatio 0.005, maxRatio 20, stagePadPx 40, flyRatio 0.12, flyMs 700, fitMs 500 |
| `layout` | barnesHutOver 1500, stopMs 4000, stopMsMid 9000, stopMsBig 30000, midOver 2000, bigOver 12000 |

WebGL 3D page (`3d.js`):

| Group | Keys and defaults |
|---|---|
| `bands` | warmupUnder 3000, big 5000, banner 8000, huge 20000 |
| `distance` | import 40, loads 18, index 22, lists 50, skill 40, ref 35, scope 60, detail 12, related 30 |
| `distanceDefault` | 30 |
| `shells` | base 38, radii [0, 0.4, 0.78, 1], strength 0.12 |
| `node` | rootVal 30, valPerLink 0.8, relSize 3, relSizeHuge 2, resolution 12, resolutionBig 6, resolutionHuge 4, opacity 0.95 |
| `link` | opacity 0.28, opacityBig 0.14, opacityHuge 0.08, hotWidth 0.8, particles 2, particlesMaxLinks 200, particleWidth 1.6, particleSpeed 0.006 |
| `sim` | charge -60, chargeBig -25, chargeHuge -12, velocityDecay 0.3, warmupTicks 120, cooldownMs 12000, cooldownBigMs 18000, cooldownHugeMs 25000 |
| `camera` | fitTicks 40, fitMs 700, fitStopMs 900, fitPadPx 40, flyDistance 90, flyMs 1200, autoRotateSpeed 0.5 |

Orbit page (`orbit.js`):

| Group | Keys and defaults |
|---|---|
| `layout` | spacingMin 10, spacingMax 22, spacingRefCount 300, arc 0.72, row 1.35, sectorExponent 0.8, sectorGapMax 0.05, sectorGapShare 0.4, rinMin 110, rinPerArea 1.2, rinPad 18, bandDepthMin 70, bandSlack 1.08, bandEdgeMin 40, spacingShrink 0.98, hubInset 16, skillRingMin 45, skillRingFrac 0.55, refGap 40, runGap 36, rimGap 44, flatY [3, 1.5, 0, -1.5], tierY [1.45, 0.95, 0.45, 0], stackFrac 0.22, ringDrop 0.5, glowDrop 2 |
| `size` | root 9, rootHex 11, projectBase 4, projectSlope 0.35, projectMax 7, hubIndexBase 4, hubIndexSlope 0.3, hubIndexMax 6.5, index 3, skill 2.6, doc 3.4, dotBase 1.3, dotSlope 0.5, dotMax 4.2, dotOfSpacing 0.36, coldScale 0.85 |
| `look` | pixelRatioMax 2, bloomStrength 0.55, bloomRadius 0.4, bloomThreshold 0.18, linkOpacityMax 0.28, linkOpacityMin 0.03, linkOpacityRef 2000, hotOpacity 0.95, glowOpacityDark 0.11, glowOpacityRootDark 0.07, glowOpacityLight 0.08, glowDimmed 0.25, glowScale 2.6, glowPad 14, rootGlowSize 70, ring { skills 0.5, memory 0.55, bandEdge 0.25, references 0.5, runs 0.4, rim 0.35 }, bandEdgePad 8, tickOpacity 0.9 |
| `runs` | days 120, tickBase 4, tickPerRun 5, tickMax 26 |
| `camera` | fov 45, tiltDeg 55, damping 0.08, autoRotateSpeed 0.35, fitPad 24, fitTop 1.04, fitTilt 0.8, fitStackGain 0.4, fitWidth 1.02, fitTargetStack 0.45, fitMs 900, flyMin 70, flyFrac 0.3, flyMs 1100, stackMs 900 |
| `labels` | badgeAreas 30, maxNames 400, ringPad 10, runsPad 30, rootOffset 20, hubLift 3, ringLift 2, nameLift 2, badgeCharPx 7, badgePadPx 26, badgeAnchorPx 8, nameCharPx 5.6, namePadPx 6, boxHalfPx 8 |
| `pick` | minPx 7, padPx 4, clickMovePx 5, tipNoteChars 150 |
| `frame` | legendPx 250, cardPx 360, wideMinPx 900 |
