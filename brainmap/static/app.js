/* brain map - canvas renderer for the tiered memory graph.
   d3 is vendored; no framework, no build step. Six views of the same nodes:
   rings, circle, areas, links (force), timeline, 3d orbit. */
(function () {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const canvas = $('#canvas');
  const ctx = canvas.getContext('2d');
  const stage = $('#stage');
  const legendEl = $('#legend');
  const cardEl = $('#card');
  const tipEl = $('#tip');

  const VIEWS = ['rings', 'circle', 'areas', 'links', 'timeline', 'orbit'];
  const KINDS = ['root', 'doc', 'index', 'project', 'memory', 'detail', 'skill'];
  const KIND_LABEL = {
    root: 'root CLAUDE.md', doc: 'referenced file', index: 'MEMORY.md index',
    project: 'project', memory: 'hot fact', detail: 'cold detail', skill: 'skill',
  };
  const TYPES = ['user', 'feedback', 'project', 'reference'];
  const HEALTH = [
    { key: 'fresh', label: 'fresh', icon: '✓', tok: 'good', cls: 'st-good' },
    { key: 'stable', label: 'stable, never expires', icon: '✓', tok: 'good', cls: 'st-good' },
    { key: 'due', label: 'due within 25%', icon: '!', tok: 'warning', cls: 'st-warning' },
    { key: 'overdue', label: 'past half-life', icon: '✕', tok: 'critical', cls: 'st-critical' },
  ];
  const STRUCTURAL = new Set(['import', 'loads', 'index', 'lists', 'skill', 'ref', 'scope']);

  /* -- tuning ------------------------------------------------------------
     Every speed, count, size and threshold on this page lives in this one
     block, so tuning is one number. Distances are world units unless marked
     px; times are ms. Colours are CSS tokens in style.css. Text offsets and
     shape proportions are drawing detail and stay where they are drawn. */
  const TUNE = Object.freeze({
    data: {
      staleDays: 7,                 // a snapshot older than this is marked stale
    },
    live: {
      pollMs: 2000,                 // ask the server for its version while the tab is visible
      flashMs: 6000,                // changed nodes pulse this long after an update
      pulseMs: 1000,                // one pulse
      ringPx: 12,                   // how far a pulse ring grows
      noteMs: 120000,               // "updated ..." stays in the header this long
    },
    node: {
      base: 3.2, slope: 1.7,        // radius = base + slope x sqrt(degree)
      rootMin: 13,
      coldScale: 0.8,
      zoomMin: 0.55, zoomMax: 2.6,  // on-screen size follows sqrt(zoom), clamped
      timelineScale: 0.7,
    },
    areas: {
      tagAllUpTo: 40,               // up to this many areas, every area gets a tag
      tagTop: 30,                   // beyond that, only the biggest this many
    },
    rings: {
      gapMax: 0.06, gapShare: 0.4,  // sector gap = min(max, share x PI / areas) rad
      minArc: 24,                   // arc length per node on a ring
      step: 105,                    // minimum distance between rings
      tagPad: 30,                   // area tags outside the area's outer ring
    },
    circle: {
      gapSlots: 1.6,                // empty slots between areas
      slotArc: 21,                  // arc length per slot
      radiusMin: 230,
      tagPad: 30,
      pull: 0.8,                    // links curve this far toward the centre
    },
    clusters: {
      spacing: 17,                  // phyllotaxis spacing inside an area cluster
      angle: 2.39996,               // golden angle, rad
      pad: 12,                      // cluster radius = spacing x sqrt(n) + pad
      gap: 30,                      // between clusters around the ring
      centreGap: 50,                // clearance around the core cluster
      ringPad: 6,                   // outline outside the cluster
    },
    force: {
      distance: { import: 70, loads: 40, index: 45, lists: 90, skill: 70, ref: 60, scope: 110, detail: 28, related: 55 },
      distanceDefault: 50,
      strength: 0.55, strengthRelated: 0.2,
      chargeRoot: -700, chargeLayer1: -220, charge: -95, chargeRange: 600,
      collidePad: 4,
      centring: 0.035,
      seedJitter: 40,
      ticks: 320, ticksOver3k: 60, ticksOver20k: 12,   // synchronous pre-layout
      dragAlpha: 0.25,
    },
    timeline: {
      halfWidth: 420,               // x range is -halfWidth .. halfWidth
      padDays: 3,
      barBase: -50, barTop: -250,   // runs bars grow from base toward top
      barMinPx: 5, barRadiusPx: 4, barDimmed: 0.45,
      lanesMax: 30,
      laneSpan: 320, laneMin: 18, laneMax: 36, laneTop: 40,
      undatedX: -450,
      swarmTries: 14, swarmStep: 4, swarmCap: 400, swarmPad: 3,
    },
    orbit: {
      tilt: 0.62,                   // rad
      perspective: 1400,            // eye distance, at least ...
      perspectiveOfRadius: 4,       // ... this x the largest shell
      shellScale: 0.95,             // shell radius x the rings radius
      latSpread1: 0.25, latSpread: 0.5, latJitter: 0.3,
      startAngle: 0.6,              // rad
      speed: 0.00014,               // rad per ms while motion is on
      depthFade: 0.62, depthMin: 0.3,
      fitScale: 1.25, fitAspect: 0.85,
      equatorSteps: 72,
    },
    motion: {
      wobble: 1.8, periodX: 1500, periodY: 1900, phaseY: 1.3,
      frameCapMs: 64,               // largest frame step fed to the orbit spin
    },
    camera: {
      zoomMin: 0.15, zoomMax: 12,
      fitZoomMax: 4, fitPadPx: 32,
      boundsPad: 70, boundsPadLinks: 30,   // room for sector tags
      viewMs: 850, firstMs: 1300, reloadMs: 800, fitMs: 700,
      flyMs: 900, flyZoom: 2.2,
    },
    draw: {
      linkHot: 0.85, linkDimmed: 0.035, linkFocus: 0.5, linkOff: 0.03,
      linkStructural: 0.26, linkRelated: 0.34, linkMin: 0.01,
      linkBend: 0.18,               // related links arc by this x their length
      linkHotWidth: 1.5,
      nodeDimmed: 0.13,
      glowMaxNodes: 2000, glowRoot: 22, glow: 12,
      outline: 1.5, rootRingGap: 5, rootRingAlpha: 0.45, overdueGap: 4, selectGap: 6,
      cullPx: 40,
    },
    labels: {
      fontPx: 11, haloPx: 3, gapPx: 4, boxHalfPx: 7,
      cullXPx: 50, cullYPx: 20,
      tipNoteChars: 160,
    },
    pick: { padPx: 3, minPx: 8 },
    frame: { legendPx: 250, cardPx: 360, wideMinPx: 900 },
  });
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  // -- state -------------------------------------------------------------
  const S = {
    src: 'live', view: 'rings', colorBy: 'area',
    names: false, motion: !reduceMotion, theme: 'dark',
    iso: null,            // { dim: 'area' | 'kind' | 'type' | 'health', value }
    query: '',
    hover: null, hoverBar: null, sel: null,
    k: d3.zoomIdentity,
  };
  let G = null;
  let nodes = [], links = [], byId = new Map(), nbrs = new Map();
  let areaOrder = [], areaSlot = new Map(), tagged = new Set();
  let guides = null, tl = null;
  let W = 0, H = 0, dpr = 1;
  let tok = {};
  let tween = { t0: 0, dur: 0 };
  let sim = null, simGraph = null, simHot = false;
  let orbitAngle = TUNE.orbit.startAngle, lastFrame = performance.now();
  let dirty = true;
  let live = null, delta = null, flash = null;   // poll status, last change, pulsing nodes
  const drawMs = [];

  const store = {
    get() { try { return JSON.parse(localStorage.getItem('brainmap') || '{}'); } catch (e) { return {}; } },
    set(v) { try { localStorage.setItem('brainmap', JSON.stringify(v)); } catch (e) { /* private mode */ } },
  };
  function savePrefs() {
    store.set({ src: S.src, view: S.view, colorBy: S.colorBy, names: S.names, motion: S.motion, theme: S.theme });
  }

  // -- tokens & colour ---------------------------------------------------
  function readTokens() {
    const cs = getComputedStyle(document.documentElement);
    const g = (n) => cs.getPropertyValue(n).trim();
    tok = {
      surface: g('--surface'), ink: g('--ink'), ink2: g('--ink-2'), muted: g('--muted'),
      grid: g('--grid'), axis: g('--axis'), other: g('--other'),
      good: g('--good'), warning: g('--warning'), critical: g('--critical'),
      series: [1, 2, 3, 4, 5, 6, 7, 8].map((i) => g('--series-' + i)),
      dark: cs.colorScheme !== 'light',
    };
    dirty = true;
  }
  function areaColor(a) {
    if (a === 'core') return tok.ink;
    const s = areaSlot.get(a);
    return s == null ? tok.other : tok.series[s];
  }
  function healthColor(n) {
    const h = HEALTH.find((x) => x.key === n.health);
    return h ? tok[h.tok] : tok.other;
  }
  const fill = (n) => (S.colorBy === 'health' ? healthColor(n) : areaColor(n.area));

  // -- utilities ---------------------------------------------------------
  function hash(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return ((h >>> 0) % 100000) / 100000;
  }
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const byLabel = (a, b) => a.label.localeCompare(b.label);
  const areaIdx = (a) => areaOrder.indexOf(a);
  const parseDay = d3.timeParse('%Y-%m-%d');
  const fmtDay = d3.timeFormat('%Y-%m-%d');
  const fmtTime = d3.timeFormat('%H:%M');
  function daysAgo(d) {
    const n = Math.floor((Date.now() - d.getTime()) / 86400000);
    return n <= 0 ? 'today' : n + ' d ago';
  }
  function h(tag, cls, text) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = text;
    return el;
  }
  function shapeIcon(kind) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '-6 -6 12 12');
    svg.setAttribute('class', 'shape');
    const pts = shapePoints(kind, 0, 0, 4.2);
    let el;
    if (!pts) {
      el = document.createElementNS(NS, 'circle');
      el.setAttribute('r', kind === 'root' ? '5' : '4.2');
    } else {
      el = document.createElementNS(NS, 'polygon');
      el.setAttribute('points', pts.map((p) => p.join(',')).join(' '));
    }
    el.setAttribute('fill', 'currentColor');
    svg.appendChild(el);
    return svg;
  }

  // -- data --------------------------------------------------------------
  function radius(n) {
    const N = TUNE.node;
    const base = N.base + N.slope * Math.sqrt(n.deg);
    if (n.kind === 'root') return Math.max(N.rootMin, base);
    if (n.kind === 'detail') return base * N.coldScale;
    return base;
  }

  function ingest(data, first) {
    const old = new Map(nodes.map((n) => [n.id, n]));
    G = data;
    nodes = data.nodes.map((d) => {
      const o = old.get(d.id);
      return Object.assign({}, d, {
        x: o ? o.x : 0, y: o ? o.y : 0, deg: 0, phase: hash(d.id) * Math.PI * 2,
        t: d.changed ? new Date(d.changed) : null,
      });
    });
    byId = new Map(nodes.map((n) => [n.id, n]));
    links = data.links.filter((l) => byId.has(l.s) && byId.has(l.t))
      .map((l) => ({ source: byId.get(l.s), target: byId.get(l.t), kind: l.kind }));
    nbrs = new Map(nodes.map((n) => [n, new Set()]));
    for (const l of links) {
      l.source.deg++; l.target.deg++;
      nbrs.get(l.source).add(l.target); nbrs.get(l.target).add(l.source);
    }
    for (const n of nodes) n.r = radius(n);

    // Areas in a fixed order: core, global, skills, then by size. Slots are
    // handed out in that order and stop at eight; later areas share the
    // neutral hue and rely on position, legend and label for identity.
    const counts = d3.rollup(nodes, (v) => v.length, (n) => n.area);
    const rank = (a) => (a === 'core' ? 0 : a === 'global' ? 1 : a === 'skills' ? 2 : 3);
    areaOrder = [...counts.keys()].sort((a, b) => rank(a) - rank(b) || counts.get(b) - counts.get(a) || a.localeCompare(b));
    tagged = new Set(areaOrder.length <= TUNE.areas.tagAllUpTo ? areaOrder
      : areaOrder.slice().sort((a, b) => counts.get(b) - counts.get(a)).slice(0, TUNE.areas.tagTop));
    areaSlot = new Map();
    let slot = 0;
    for (const a of areaOrder) if (a !== 'core' && slot < 8) areaSlot.set(a, slot++);

    S.hover = null;
    S.sel = S.sel ? byId.get(S.sel.id) || null : null;
    if (S.iso && !nodes.some((n) => matchesIso(n, S.iso))) S.iso = null;
    simGraph = null;
    $('#empty').hidden = nodes.length > 0;
    $('#empty').textContent = 'No memory files found in this source.';
    renderLegend();
    renderStamp();
    if (S.sel) renderCard(); else hideCard();
    setView(S.view, { refit: first, dur: first ? TUNE.camera.firstMs : TUNE.camera.reloadMs });
  }

  async function fetchJSON(url) {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(res.status + ' ' + res.statusText);
    return res.json();
  }

  let loadSeq = 0;
  async function load(first) {
    const my = ++loadSeq;
    const data = await fetchJSON('/api/brain?src=' + encodeURIComponent(S.src));
    // A newer load started while this one was fetching; drop the stale graph.
    if (my !== loadSeq) return;
    delta = null; flash = null;
    ingest(data, first);
  }

  // -- live refresh (same contract as common.js on the WebGL pages) ----------
  // A node apart from the clock: age, health and the half-life flag drift by
  // themselves every day and are not a change to the memory.
  const SIG_KEYS = ['kind', 'label', 'area', 'layer', 'tier', 'type', 'volatility', 'path', 'note', 'changed', 'lines'];
  const nodeSig = (n) => JSON.stringify(SIG_KEYS.map((k) => (n[k] == null ? null : n[k]))
    .concat([(n.flags || []).filter((f) => !/half-life/.test(f))]));
  function diff(before, after) {
    const old = new Map(before.map((n) => [n.id, nodeSig(n)]));
    const added = [], changed = [], seen = new Set();
    for (const n of after) {
      seen.add(n.id);
      const s = old.get(n.id);
      if (s == null) added.push(n.id);
      else if (s !== nodeSig(n)) changed.push(n.id);
    }
    return { added, changed, removed: before.filter((n) => !seen.has(n.id)).map((n) => n.id), at: Date.now() };
  }

  // The server has a newer version: re-fetch it, keep the view (ingest tweens
  // every node from where it was), and pulse what changed.
  async function update() {
    const my = loadSeq;
    let data;
    try {
      data = await fetchJSON('/api/brain?src=' + encodeURIComponent(S.src));
    } catch (e) {
      return;                       // the next poll tries again
    }
    if (my !== loadSeq || !G) return;
    const d = diff(G.nodes, data.nodes);
    ingest(data, false);
    delta = d;
    const ids = new Set(d.added.concat(d.changed));
    flash = ids.size ? { nodes: nodes.filter((n) => ids.has(n.id)), t0: performance.now() } : null;
    dirty = true;
  }

  function follow() {
    const st = { down: null, error: null };
    let busy = false;
    async function poll() {
      if (document.hidden || busy || !G || !G.meta.version) return;
      busy = true;
      const src = S.src;
      try {
        const v = await fetchJSON('/api/version?src=' + encodeURIComponent(src));
        st.down = null;
        st.error = v.error || null;
        if (src === S.src && v.version && v.version !== G.meta.version) await update();
      } catch (e) {
        if (!st.down) st.down = new Date();
      } finally {
        busy = false;
      }
    }
    setInterval(poll, TUNE.live.pollMs);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
    return st;
  }

  // -- layouts -----------------------------------------------------------
  function sectors(weight) {
    const w = areaOrder.map((a) => Math.max(1, weight(a)));
    const gap = Math.min(TUNE.rings.gapMax, (Math.PI * TUNE.rings.gapShare) / areaOrder.length), total = d3.sum(w);
    const span = Math.PI * 2 - gap * areaOrder.length;
    const out = new Map();
    let a = -Math.PI / 2;
    areaOrder.forEach((ar, i) => {
      const da = (span * w[i]) / total;
      out.set(ar, [a + gap / 2, a + gap / 2 + da]);
      a += da + gap;
    });
    return out;
  }

  function ringModel() {
    const grp = d3.group(nodes, (n) => n.area, (n) => n.layer);
    const sec = sectors((a) => d3.max([...grp.get(a).values()], (v) => v.length));
    const minArc = TUNE.rings.minArc;
    const R = [0];
    for (let L = 1; L <= 3; L++) {
      let need = 0;
      for (const [a, layers] of grp) {
        const arr = layers.get(L);
        if (!arr) continue;
        const [a0, a1] = sec.get(a);
        need = Math.max(need, (arr.length * minArc) / (a1 - a0));
      }
      R[L] = Math.max(R[L - 1] + TUNE.rings.step, need);
    }
    const ang = new Map();
    for (const [a, layers] of grp) {
      const [a0, a1] = sec.get(a);
      for (const arr of layers.values()) {
        arr.sort((x, y) => x.kind.localeCompare(y.kind) || byLabel(x, y));
        arr.forEach((n, i) => ang.set(n, a0 + ((a1 - a0) * (i + 0.5)) / arr.length));
      }
    }
    return { R, sec, ang };
  }

  function layoutRings() {
    const m = ringModel();
    for (const n of nodes) {
      if (n.layer === 0) { n.tx = 0; n.ty = 0; continue; }
      const a = m.ang.get(n);
      n.tx = m.R[n.layer] * Math.cos(a);
      n.ty = m.R[n.layer] * Math.sin(a);
    }
    const outer = d3.rollup(nodes, (v) => d3.max(v, (n) => n.layer), (n) => n.area);
    const used = [...new Set(nodes.map((n) => n.layer))].filter((L) => L > 0);
    guides = { kind: 'rings', R: m.R, sec: m.sec, outer, used };
  }

  function layoutCircle() {
    const sorted = nodes.slice().sort((a, b) => areaIdx(a.area) - areaIdx(b.area) || a.layer - b.layer || byLabel(a, b));
    const C = TUNE.circle, GAP = C.gapSlots;
    const slots = sorted.length + GAP * areaOrder.length;
    const R = Math.max(C.radiusMin, (slots * C.slotArc) / (Math.PI * 2));
    const arcs = new Map();
    let s = 0, prev = null;
    for (const n of sorted) {
      if (n.area !== prev) { s += GAP; prev = n.area; }
      const a = -Math.PI / 2 + (s / slots) * Math.PI * 2;
      n.tx = R * Math.cos(a); n.ty = R * Math.sin(a);
      const arc = arcs.get(n.area) || [a, a];
      arc[1] = a; arcs.set(n.area, arc);
      s += 1;
    }
    guides = { kind: 'circle', R, sec: arcs };
  }

  function layoutAreas() {
    const grp = d3.group(nodes, (n) => n.area);
    const K = TUNE.clusters, SP = K.spacing;
    const clusters = areaOrder.map((a) => {
      const arr = grp.get(a).slice().sort((x, y) => x.layer - y.layer || y.deg - x.deg || byLabel(x, y));
      return { a, arr, r: SP * Math.sqrt(arr.length) + K.pad };
    });
    const core = clusters.find((c) => c.a === 'core');
    const rest = clusters.filter((c) => c !== core);
    const PAD = K.gap;
    const circ = d3.sum(rest, (c) => 2 * c.r + PAD);
    const Rc = Math.max((core ? core.r : 0) + (d3.max(rest, (c) => c.r) || 0) + K.centreGap, circ / (Math.PI * 2));
    let acc = 0;
    for (const c of rest) {
      const a = -Math.PI / 2 + ((acc + c.r + PAD / 2) / circ) * Math.PI * 2;
      acc += 2 * c.r + PAD;
      c.cx = Rc * Math.cos(a); c.cy = Rc * Math.sin(a);
    }
    if (core) { core.cx = 0; core.cy = 0; }
    for (const c of clusters) {
      c.arr.forEach((n, i) => {
        const rr = SP * Math.sqrt(i);
        const th = i * K.angle;
        n.tx = c.cx + rr * Math.cos(th);
        n.ty = c.cy + rr * Math.sin(th);
      });
    }
    guides = { kind: 'areas', clusters };
  }

  function layoutLinks() {
    if (!sim || simGraph !== G) {
      if (sim) sim.stop();
      const F = TUNE.force, J = F.seedJitter;
      const sn = nodes.map((n) => (n.sim = { n, x: n.x + (hash(n.id) - 0.5) * J, y: n.y + (hash(n.id + '.') - 0.5) * J }));
      const sl = links.map((l) => ({ source: l.source.sim, target: l.target.sim, kind: l.kind }));
      sim = d3.forceSimulation(sn)
        .force('link', d3.forceLink(sl).distance((l) => F.distance[l.kind] || F.distanceDefault)
          .strength((l) => (l.kind === 'related' ? F.strengthRelated : F.strength)))
        .force('charge', d3.forceManyBody().strength((d) => (d.n.kind === 'root' ? F.chargeRoot : d.n.layer === 1 ? F.chargeLayer1 : F.charge))
          .distanceMax(F.chargeRange))
        .force('collide', d3.forceCollide((d) => d.n.r + F.collidePad))
        .force('x', d3.forceX(0).strength(F.centring))
        .force('y', d3.forceY(0).strength(F.centring))
        .stop();
      const root = nodes.find((n) => n.kind === 'root');
      if (root) { root.sim.fx = 0; root.sim.fy = 0; }
      const ticks = nodes.length > 20000 ? F.ticksOver20k : nodes.length > 3000 ? F.ticksOver3k : F.ticks;
      for (let i = 0; i < ticks; i++) sim.tick();
      sim.on('tick', () => { dirty = true; }).on('end', () => { simHot = false; });
      simGraph = G;
    }
    for (const n of nodes) { n.tx = n.sim.x; n.ty = n.sim.y; }
    guides = { kind: 'links' };
  }

  function layoutTimeline() {
    const now = new Date();
    const days = (G.activity || []).map((d) => Object.assign({}, d, { date: parseDay(d.day) }));
    const dates = nodes.filter((n) => n.t).map((n) => n.t).concat(days.map((d) => d.date), [now]);
    const [lo, hi] = d3.extent(dates);
    const TL = TUNE.timeline;
    const x = d3.scaleTime().domain([d3.timeDay.offset(lo, -TL.padDays), d3.timeDay.offset(hi, TL.padDays)])
      .range([-TL.halfWidth, TL.halfWidth]);
    const maxRuns = d3.max(days, (d) => d.runs) || 1;
    const yb = d3.scaleLinear().domain([0, maxRuns]).range([TL.barBase, TL.barTop]);
    const bars = days.map((d) => ({ d, x0: x(d.date), x1: x(d3.timeDay.offset(d.date, 1)), y: yb(d.runs) }));
    const MAXL = TL.lanesMax;
    let laneAreas = areaOrder.filter((a) => nodes.some((n) => n.area === a));
    const laneOf = new Map(laneAreas.map((a) => [a, a]));
    if (laneAreas.length > MAXL) {
      const rest = laneAreas.slice(MAXL - 1);
      const other = rest.length + ' more areas';
      for (const a of rest) laneOf.set(a, other);
      laneAreas = laneAreas.slice(0, MAXL - 1).concat([other]);
    }
    const laneH = clamp(TL.laneSpan / laneAreas.length, TL.laneMin, TL.laneMax);
    const lanes = laneAreas.map((a, i) => ({ a, y: TL.laneTop + i * laneH + laneH / 2 }));
    const undatedX = TL.undatedX;
    for (const lane of lanes) {
      const arr = nodes.filter((n) => laneOf.get(n.area) === lane.a).sort((a, b) => (a.t || 0) - (b.t || 0));
      const placed = [];
      for (const n of arr) {
        const px = n.t ? x(n.t) : undatedX;
        const r = n.r * TUNE.node.timelineScale;
        let py = lane.y;
        for (let i = 0; i < TL.swarmTries && placed.length < TL.swarmCap; i++) {
          const off = (i % 2 ? 1 : -1) * Math.ceil(i / 2) * TL.swarmStep;
          py = lane.y + clamp(off, -laneH / 2 + TL.swarmPad, laneH / 2 - TL.swarmPad);
          if (!placed.some((p) => Math.abs(p.x - px) < p.r + r + 1 && Math.abs(p.y - py) < p.r + r + 1)) break;
        }
        n.tx = px; n.ty = py;
        placed.push({ x: px, y: py, r });
      }
    }
    tl = { x, yb, bars, lanes, laneH, maxRuns, undatedX, now, hasUndated: nodes.some((n) => !n.t) };
    guides = { kind: 'timeline' };
  }

  function layoutOrbit() {
    const m = ringModel();
    const O = TUNE.orbit;
    const R = m.R.map((r) => r * O.shellScale);
    const grp = d3.group(nodes, (n) => n.area, (n) => n.layer);
    for (const layers of grp.values()) {
      for (const arr of layers.values()) {
        arr.forEach((n, i) => {
          const lon = m.ang.get(n) || 0;
          const spread = n.layer === 1 ? O.latSpread1 : O.latSpread;
          const lat = n.layer === 0 ? 0 : ((i % 3) - 1) * spread + (hash(n.id) - 0.5) * O.latJitter;
          const r = R[n.layer] || 0;
          n.ox = r * Math.cos(lat) * Math.cos(lon);
          n.oy = r * Math.sin(lat);
          n.oz = r * Math.cos(lat) * Math.sin(lon);
        });
      }
    }
    const used = [...new Set(nodes.map((n) => n.layer))].filter((L) => L > 0);
    const Rmax = R[d3.max(used) || 1];
    // The eye must sit well outside the largest shell, or near-side nodes end
    // up behind it with a negative scale (and arc() throws on big graphs).
    guides = { kind: 'orbit', R, used, Rmax, persp: Math.max(O.perspective, O.perspectiveOfRadius * Rmax) };
    projectAll();
  }

  function project3(x, y, z) {
    const c = Math.cos(orbitAngle), s = Math.sin(orbitAngle);
    const X = x * c + z * s, Z = -x * s + z * c;
    const ct = Math.cos(TUNE.orbit.tilt), st = Math.sin(TUNE.orbit.tilt);
    const Y2 = y * ct - Z * st, Z2 = y * st + Z * ct;
    const P = (guides && guides.persp) || TUNE.orbit.perspective;
    const f = P / (P + Z2);
    return { x: X * f, y: Y2 * f, s: f, z: Z2 };
  }
  function projectAll() {
    for (const n of nodes) n.proj = project3(n.ox || 0, n.oy || 0, n.oz || 0);
  }
  function depthAlpha(z) {
    const Rm = (guides && guides.Rmax) || 300;
    return clamp(1 - (TUNE.orbit.depthFade * (z + Rm)) / (2 * Rm), TUNE.orbit.depthMin, 1);
  }

  const LAYOUT = { rings: layoutRings, circle: layoutCircle, areas: layoutAreas, links: layoutLinks, timeline: layoutTimeline, orbit: layoutOrbit };

  function setView(v, opts) {
    opts = opts || {};
    if (!VIEWS.includes(v)) v = 'rings';
    S.view = v;
    document.querySelectorAll('#views button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === v)));
    if (!nodes.length) { dirty = true; return; }
    for (const n of nodes) { n.fx0 = n.x; n.fy0 = n.y; }
    LAYOUT[v]();
    tween = { t0: performance.now(), dur: opts.dur || TUNE.camera.viewMs };
    if (opts.refit !== false) fit(opts.dur || TUNE.camera.viewMs);
    savePrefs();
    dirty = true;
  }

  function target(n, now) {
    let x, y;
    if (S.view === 'links') { x = n.sim.x; y = n.sim.y; }
    else if (S.view === 'orbit') { x = n.proj.x; y = n.proj.y; }
    else { x = n.tx; y = n.ty; }
    if (S.motion && (S.view === 'rings' || S.view === 'circle' || S.view === 'areas')) {
      const M = TUNE.motion;
      x += M.wobble * Math.sin(now / M.periodX + n.phase);
      y += M.wobble * Math.cos(now / M.periodY + n.phase * M.phaseY);
    }
    return [x, y];
  }

  // -- camera ------------------------------------------------------------
  const zoom = d3.zoom()
    .scaleExtent([TUNE.camera.zoomMin, TUNE.camera.zoomMax])
    .filter((ev) => (!ev.ctrlKey || ev.type === 'wheel') && !ev.button)
    .on('zoom', (ev) => { S.k = ev.transform; dirty = true; hideTip(); });

  function viewport() {
    const Fr = TUNE.frame;
    const left = W > Fr.wideMinPx && !legendEl.hidden ? Fr.legendPx : 0;
    const right = W > Fr.wideMinPx && !cardEl.hidden ? Fr.cardPx : 0;
    return { x0: left, x1: W - right, cx: (left + W - right) / 2, cy: H / 2, w: W - left - right, h: H };
  }

  function targetBounds() {
    if (S.view === 'orbit') {
      const r = guides.Rmax * TUNE.orbit.fitScale, a = TUNE.orbit.fitAspect;
      return [-r, -r * a, r, r * a];
    }
    if (S.view === 'timeline') {
      const bottom = tl.lanes.length ? tl.lanes[tl.lanes.length - 1].y + tl.laneH : 60;
      return [-560, -290, 440, bottom];
    }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of nodes) {
      x0 = Math.min(x0, n.tx - n.r); y0 = Math.min(y0, n.ty - n.r);
      x1 = Math.max(x1, n.tx + n.r); y1 = Math.max(y1, n.ty + n.r);
    }
    const pad = S.view === 'links' ? TUNE.camera.boundsPadLinks : TUNE.camera.boundsPad;
    return [x0 - pad, y0 - pad, x1 + pad, y1 + pad];
  }

  function fit(dur) {
    if (!nodes.length || !W) return;
    const [x0, y0, x1, y1] = targetBounds();
    const vp = viewport();
    const Cm = TUNE.camera;
    const k = clamp(Math.min((vp.w - Cm.fitPadPx) / (x1 - x0), (vp.h - Cm.fitPadPx) / (y1 - y0)), Cm.zoomMin, Cm.fitZoomMax);
    const t = d3.zoomIdentity.translate(vp.cx, vp.cy).scale(k).translate(-(x0 + x1) / 2, -(y0 + y1) / 2);
    // A background tab gets no animation frames, so a transition would stall
    // half-way; snap instead.
    if (document.hidden || dur === 0) d3.select(canvas).interrupt().call(zoom.transform, t);
    else d3.select(canvas).transition().duration(dur == null ? Cm.fitMs : dur).call(zoom.transform, t);
  }

  function flyTo(n) {
    const vp = viewport();
    const k = Math.max(S.k.k, TUNE.camera.flyZoom);
    const t = d3.zoomIdentity.translate(vp.cx, vp.cy).scale(k).translate(-n.x, -n.y);
    d3.select(canvas).transition().duration(TUNE.camera.flyMs).call(zoom.transform, t);
  }

  // -- focus ---------------------------------------------------------------
  function matchesIso(n, iso) {
    if (iso.dim === 'area') return n.area === iso.value;
    if (iso.dim === 'kind') return n.kind === iso.value;
    if (iso.dim === 'type') return n.type === iso.value;
    if (iso.dim === 'health') return (n.health || 'none') === iso.value;
    return true;
  }
  function matchesQuery(n) {
    const q = S.query;
    return (n.label + ' ' + (n.note || '') + ' ' + (n.rel || '') + ' ' + n.area).toLowerCase().includes(q);
  }
  function focusSet() {
    const c = S.hover || S.sel;
    if (c) return new Set([c, ...nbrs.get(c)]);
    if (!S.iso && !S.query) return null;
    const F = new Set();
    for (const n of nodes) if ((!S.iso || matchesIso(n, S.iso)) && (!S.query || matchesQuery(n))) F.add(n);
    return F;
  }

  // -- drawing -------------------------------------------------------------
  function shapePoints(kind, x, y, r) {
    const poly = (k, rr, rot) => d3.range(k).map((i) => {
      const a = rot + (i * Math.PI * 2) / k;
      return [x + rr * Math.cos(a), y + rr * Math.sin(a)];
    });
    switch (kind) {
      case 'index': return poly(4, r * 1.2, Math.PI / 4);
      case 'detail': return poly(4, r * 1.25, 0);
      case 'skill': return poly(3, r * 1.35, -Math.PI / 2);
      case 'project': return poly(6, r * 1.15, 0);
      case 'doc': return poly(5, r * 1.2, -Math.PI / 2);
      default: return null;
    }
  }
  function shapePath(kind, x, y, r) {
    ctx.beginPath();
    const pts = shapePoints(kind, x, y, r);
    if (!pts) { ctx.arc(x, y, r, 0, Math.PI * 2); return; }
    pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
    ctx.closePath();
  }

  function text(str, x, y, opts) {
    opts = opts || {};
    ctx.font = (opts.weight || 400) + ' ' + (opts.size || TUNE.labels.fontPx) + 'px system-ui, -apple-system, "Segoe UI", sans-serif';
    ctx.textAlign = opts.align || 'left';
    ctx.textBaseline = opts.base || 'middle';
    if (opts.halo !== false) {
      ctx.lineJoin = 'round';
      ctx.lineWidth = TUNE.labels.haloPx;
      ctx.strokeStyle = tok.surface;
      ctx.strokeText(str, x, y);
    }
    ctx.fillStyle = opts.color || tok.ink2;
    ctx.fillText(str, x, y);
  }

  function areaTag(a, x, y, align, force) {
    if (!force && !tagged.has(a)) return;
    const w = ctx.measureText(a).width;
    ctx.fillStyle = areaColor(a);
    const dx = align === 'right' ? -w - 9 : align === 'center' ? -w / 2 - 9 : 0;
    ctx.beginPath(); ctx.arc(x + dx + 3, y, 3.5, 0, Math.PI * 2); ctx.fill();
    text(a, x + dx + 10, y, { color: tok.ink2, align: 'left' });
  }

  function drawGuides(t, e) {
    if (!guides) return;
    ctx.globalAlpha = e;
    ctx.lineWidth = 1;
    const [ox, oy] = t.apply([0, 0]);
    if (guides.kind === 'rings') {
      ctx.strokeStyle = tok.grid;
      for (const L of guides.used) { ctx.beginPath(); ctx.arc(ox, oy, guides.R[L] * t.k, 0, Math.PI * 2); ctx.stroke(); }
      ctx.font = TUNE.labels.fontPx + 'px system-ui';
      for (const [a, [a0, a1]] of guides.sec) {
        const m = (a0 + a1) / 2;
        const Ro = guides.R[Math.max(1, guides.outer.get(a) || 1)] + TUNE.rings.tagPad;
        const [x, y] = t.apply([Ro * Math.cos(m), Ro * Math.sin(m)]);
        areaTag(a, x, y, Math.cos(m) < -0.2 ? 'right' : Math.cos(m) > 0.2 ? 'left' : 'center');
      }
    } else if (guides.kind === 'circle') {
      ctx.strokeStyle = tok.grid;
      ctx.beginPath(); ctx.arc(ox, oy, guides.R * t.k, 0, Math.PI * 2); ctx.stroke();
      ctx.font = TUNE.labels.fontPx + 'px system-ui';
      for (const [a, [a0, a1]] of guides.sec) {
        const m = (a0 + a1) / 2, Ro = guides.R + TUNE.circle.tagPad;
        const [x, y] = t.apply([Ro * Math.cos(m), Ro * Math.sin(m)]);
        areaTag(a, x, y, Math.cos(m) < -0.2 ? 'right' : Math.cos(m) > 0.2 ? 'left' : 'center');
      }
    } else if (guides.kind === 'areas') {
      ctx.font = TUNE.labels.fontPx + 'px system-ui';
      for (const c of guides.clusters) {
        const [x, y] = t.apply([c.cx, c.cy]);
        ctx.strokeStyle = tok.grid;
        const rp = TUNE.clusters.ringPad;
        ctx.beginPath(); ctx.arc(x, y, (c.r + rp) * t.k, 0, Math.PI * 2); ctx.stroke();
        areaTag(c.a, x, y - (c.r + rp) * t.k - 10, 'center');
      }
    } else if (guides.kind === 'orbit') {
      ctx.strokeStyle = tok.grid;
      for (const L of guides.used) {
        const r = guides.R[L];
        ctx.beginPath();
        const steps = TUNE.orbit.equatorSteps;
        for (let i = 0; i <= steps; i++) {
          const a = (i / steps) * Math.PI * 2;
          const p = project3(r * Math.cos(a), 0, r * Math.sin(a));
          const [x, y] = t.apply([p.x, p.y]);
          i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
        }
        ctx.stroke();
      }
    } else if (guides.kind === 'timeline') {
      drawTimelineChrome(t);
    }
    ctx.globalAlpha = 1;
  }

  function drawTimelineChrome(t) {
    const { x, yb, bars, lanes, laneH } = tl;
    const TL = TUNE.timeline;
    const bottom = lanes.length ? lanes[lanes.length - 1].y + laneH / 2 : 60;
    const [X0] = t.apply([x.range()[0], 0]);
    const [X1] = t.apply([x.range()[1], 0]);
    // gridlines and date ticks
    ctx.lineWidth = 1;
    ctx.strokeStyle = tok.grid;
    ctx.font = TUNE.labels.fontPx + 'px system-ui';
    for (const d of x.ticks(Math.max(3, Math.floor((X1 - X0) / 110)))) {
      const [sx, sTop] = t.apply([x(d), TL.barTop - 5]);
      const [, sBot] = t.apply([x(d), bottom]);
      ctx.beginPath(); ctx.moveTo(sx, sTop); ctx.lineTo(sx, sBot); ctx.stroke();
      const [, sy] = t.apply([0, -22]);
      text(d3.timeFormat('%b %d')(d), sx, sy, { color: tok.muted, align: 'center' });
    }
    // top panel: snapshot runs per day
    const [, base] = t.apply([0, TL.barBase]);
    ctx.strokeStyle = tok.axis;
    ctx.beginPath(); ctx.moveTo(X0, base); ctx.lineTo(X1, base); ctx.stroke();
    const [, yMax] = t.apply([0, yb(tl.maxRuns)]);
    ctx.strokeStyle = tok.grid;
    ctx.beginPath(); ctx.moveTo(X0, yMax); ctx.lineTo(X1, yMax); ctx.stroke();
    text(tl.maxRuns + (tl.maxRuns === 1 ? ' run' : ' runs'), X0 - 6, yMax, { color: tok.muted, align: 'right' });
    const [, ttl] = t.apply([0, TL.barTop - 32]);
    text(bars.length ? 'snapshot runs per day (Stop hook commits)' : 'no snapshot repo for this source', X0, ttl,
      { color: tok.ink2, weight: 600 });
    for (const b of bars) {
      const [sx0, sy] = t.apply([b.x0, b.y]);
      const [sx1] = t.apply([b.x1, b.y]);
      const w = Math.max(TL.barMinPx, sx1 - sx0 - 2);
      const bx = (sx0 + sx1) / 2 - w / 2;
      const hgt = base - sy;
      ctx.globalAlpha = S.hoverBar && S.hoverBar !== b ? TL.barDimmed : 1;
      ctx.fillStyle = tok.series[0];
      ctx.beginPath();
      const br = Math.min(TL.barRadiusPx, w / 2);
      if (ctx.roundRect) ctx.roundRect(bx, sy, w, hgt, [br, br, 0, 0]);
      else ctx.rect(bx, sy, w, hgt);
      ctx.fill();
      b.sx0 = bx; b.sx1 = bx + w; b.sy = sy; b.sb = base;
    }
    ctx.globalAlpha = 1;
    // bottom panel: files by last change, one lane per area
    const [, lt] = t.apply([0, 18]);
    text('files by last change', X0, lt, { color: tok.ink2, weight: 600 });
    ctx.strokeStyle = tok.grid;
    for (const ln of lanes) {
      const [, sy] = t.apply([0, ln.y + laneH / 2]);
      ctx.beginPath(); ctx.moveTo(X0, sy); ctx.lineTo(X1, sy); ctx.stroke();
      const [, cy] = t.apply([0, ln.y]);
      const [lx] = t.apply([tl.hasUndated ? tl.undatedX - 14 : x.range()[0] - 8, 0]);
      ctx.font = TUNE.labels.fontPx + 'px system-ui';
      areaTag(ln.a, lx, cy, 'right', true);
    }
    if (tl.hasUndated) {
      const [ux, uy] = t.apply([tl.undatedX, 26]);
      text('undated', ux, uy, { color: tok.muted, align: 'center' });
    }
    // now marker
    const [nx, ny0] = t.apply([x(tl.now), TL.barTop - 12]);
    const [, ny1] = t.apply([0, bottom]);
    ctx.strokeStyle = tok.muted;
    ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(nx, ny0); ctx.lineTo(nx, ny1); ctx.stroke();
    ctx.setLineDash([]);
    text('now', nx, ny0 - 8, { color: tok.muted, align: 'center' });
  }

  function drawLinks(t, F) {
    const c = S.hover || S.sel;
    const orbit = S.view === 'orbit';
    const D = TUNE.draw;
    const [ox, oy] = t.apply([0, 0]);
    ctx.lineWidth = 1;
    for (const l of links) {
      const a = l.source, b = l.target;
      const hot = c && (a === c || b === c);
      let alpha;
      if (c) alpha = hot ? D.linkHot : D.linkDimmed;
      else if (F) alpha = F.has(a) && F.has(b) ? D.linkFocus : D.linkOff;
      else alpha = STRUCTURAL.has(l.kind) ? D.linkStructural : D.linkRelated;
      if (S.view === 'timeline' && !hot) continue;
      if (orbit) alpha *= depthAlpha((a.proj.z + b.proj.z) / 2);
      if (alpha < D.linkMin) continue;
      const [x1, y1] = t.apply([a.x, a.y]);
      const [x2, y2] = t.apply([b.x, b.y]);
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = hot ? fill(c) : l.kind === 'related' ? tok.ink2 : tok.muted;
      ctx.lineWidth = hot ? D.linkHotWidth : 1;
      ctx.setLineDash(l.kind === 'detail' ? [2, 3] : []);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      if (S.view === 'circle') {
        const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
        ctx.quadraticCurveTo(mx + (ox - mx) * TUNE.circle.pull, my + (oy - my) * TUNE.circle.pull, x2, y2);
      } else if (l.kind === 'related') {
        const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
        ctx.quadraticCurveTo(mx - (y2 - y1) * D.linkBend, my + (x2 - x1) * D.linkBend, x2, y2);
      } else {
        ctx.lineTo(x2, y2);
      }
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    ctx.lineWidth = 1;
  }

  function drawNodes(t, F) {
    const N = TUNE.node, D = TUNE.draw;
    const sz = clamp(Math.sqrt(t.k), N.zoomMin, N.zoomMax) * (S.view === 'timeline' ? N.timelineScale : 1);
    const orbit = S.view === 'orbit';
    const list = orbit ? nodes.slice().sort((a, b) => b.proj.z - a.proj.z) : nodes;
    const dark = tok.dark;
    const small = nodes.length <= D.glowMaxNodes;
    for (const n of list) {
      const [x, y] = t.apply([n.x, n.y]);
      const r = n.r * sz * (orbit ? n.proj.s : 1);
      n.sx = x; n.sy = y; n.sr = r;
      if (x < -D.cullPx || y < -D.cullPx || x > W + D.cullPx || y > H + D.cullPx) continue;
      let alpha = F && !F.has(n) ? D.nodeDimmed : 1;
      if (orbit) alpha *= depthAlpha(n.proj.z);
      ctx.globalAlpha = alpha;
      const col = fill(n);
      if (dark && small && n.layer <= 1 && alpha > 0.5) { ctx.shadowColor = col; ctx.shadowBlur = n.kind === 'root' ? D.glowRoot : D.glow; }
      ctx.fillStyle = col;
      shapePath(n.kind, x, y, r);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.lineWidth = D.outline;
      ctx.strokeStyle = tok.surface;
      ctx.stroke();
      if (n.kind === 'root') {
        ctx.strokeStyle = tok.ink; ctx.globalAlpha = alpha * D.rootRingAlpha; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(x, y, r + D.rootRingGap, 0, Math.PI * 2); ctx.stroke();
      }
      if (S.colorBy === 'health' && n.health === 'overdue') {
        ctx.strokeStyle = tok.critical; ctx.globalAlpha = alpha; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(x, y, r + D.overdueGap, 0, Math.PI * 2); ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
    for (const [n, w, a] of [[S.sel, 2, 1], [S.hover, 1.5, 0.7]]) {
      if (!n || n.sx == null) continue;
      ctx.globalAlpha = a; ctx.lineWidth = w; ctx.strokeStyle = tok.ink;
      ctx.beginPath(); ctx.arc(n.sx, n.sy, n.sr + D.selectGap, 0, Math.PI * 2); ctx.stroke();
    }
    if (flash) {
      // Changed nodes after a live update: rings that grow and fade, fading
      // out overall; a steady ring when reduced motion is asked for.
      const Lv = TUNE.live, age = performance.now() - flash.t0;
      const p = reduceMotion ? 0 : (age % Lv.pulseMs) / Lv.pulseMs;
      ctx.lineWidth = 2; ctx.strokeStyle = tok.ink;
      ctx.globalAlpha = Math.max(0, (1 - p) * (1 - age / Lv.flashMs));
      for (const n of flash.nodes) {
        if (n.sx == null) continue;
        ctx.beginPath(); ctx.arc(n.sx, n.sy, n.sr + D.selectGap + p * Lv.ringPx, 0, Math.PI * 2); ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
  }

  function drawLabels(t, F) {
    const c = S.hover || S.sel;
    const want = [];
    for (const n of nodes) {
      const near = c && (n === c || nbrs.get(c).has(n));
      let show = near || S.names || n.kind === 'root';
      // Views with area tags already name each project; the rest label the hexagons.
      if (!show && n.kind === 'project' && (S.view === 'links' || S.view === 'orbit')) show = true;
      if (!show && F && !c && S.query && F.has(n)) show = true;
      if (!show) continue;
      if (F && !F.has(n) && !near) continue;
      want.push(n);
    }
    const pri = (n) => (n === c ? 1e6 : c && nbrs.get(c).has(n) ? 1e5 : 0) + n.deg * 10 + (3 - n.layer);
    want.sort((a, b) => pri(b) - pri(a));
    const boxes = [];
    ctx.font = TUNE.labels.fontPx + 'px system-ui';
    const hit = (b) => boxes.some((o) => b[0] < o[2] && b[2] > o[0] && b[1] < o[3] && b[3] > o[1]);
    for (const n of want) {
      const Lb = TUNE.labels, bh = Lb.boxHalfPx;
      if (n.sx == null || n.sx < -Lb.cullXPx || n.sx > W + Lb.cullXPx || n.sy < -Lb.cullYPx || n.sy > H + Lb.cullYPx) continue;
      const label = n.label;
      const w = ctx.measureText(label).width;
      const gap = n.sr + Lb.gapPx;
      let box = [n.sx + gap, n.sy - bh, n.sx + gap + w, n.sy + bh], align = 'left', lx = n.sx + gap;
      if (hit(box)) { box = [n.sx - gap - w, n.sy - bh, n.sx - gap, n.sy + bh]; align = 'right'; lx = n.sx - gap; }
      if (hit(box) && n !== c) continue;
      boxes.push(box);
      ctx.globalAlpha = S.view === 'orbit' ? depthAlpha(n.proj.z) : 1;
      text(label, lx, n.sy, { color: n === c ? tok.ink : n.layer <= 1 ? tok.ink : tok.ink2, align, weight: n === c || n.kind === 'root' ? 600 : 400 });
    }
    ctx.globalAlpha = 1;
  }

  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min(TUNE.motion.frameCapMs, now - lastFrame);
    lastFrame = now;
    if (!nodes.length || !W) return;
    const tweening = now - tween.t0 < tween.dur + 30;
    const idle = S.motion && S.view !== 'links' && S.view !== 'timeline';
    if (flash && now - flash.t0 >= TUNE.live.flashMs) { flash = null; dirty = true; }
    if (!tweening && !idle && !dirty && !simHot && !flash) return;
    if (S.view === 'orbit') {
      if (S.motion && !S.sel) orbitAngle += dt * TUNE.orbit.speed;
      projectAll();
    }
    const e = d3.easeCubicInOut(clamp((now - tween.t0) / tween.dur, 0, 1));
    for (const n of nodes) {
      const [tx, ty] = target(n, now);
      if (e >= 1) { n.x = tx; n.y = ty; }
      else { n.x = n.fx0 + (tx - n.fx0) * e; n.y = n.fy0 + (ty - n.fy0) * e; }
    }
    const t0 = performance.now();
    draw(e);
    drawMs.push(performance.now() - t0);
    if (drawMs.length > 30) drawMs.shift();
    dirty = false;
  }

  function draw(e) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const t = S.k;
    const F = focusSet();
    drawGuides(t, e == null ? 1 : e);
    drawLinks(t, F);
    drawNodes(t, F);
    drawLabels(t, F);
  }

  // -- picking & interaction ----------------------------------------------
  function pick(mx, my) {
    let best = null, bd = Infinity;
    for (const n of nodes) {
      if (n.sx == null) continue;
      const dx = n.sx - mx, dy = n.sy - my, d = dx * dx + dy * dy;
      const rr = Math.max(n.sr + TUNE.pick.padPx, TUNE.pick.minPx);
      if (d < rr * rr && d < bd) { best = n; bd = d; }
    }
    return best;
  }
  function pickBar(mx, my) {
    if (S.view !== 'timeline' || !tl) return null;
    return tl.bars.find((b) => mx >= b.sx0 - 2 && mx <= b.sx1 + 2 && my >= b.sy - 4 && my <= b.sb) || null;
  }

  function showTip(mx, my, build) {
    tipEl.replaceChildren();
    build(tipEl);
    tipEl.hidden = false;
    const tw = tipEl.offsetWidth, th = tipEl.offsetHeight;
    let x = mx + 14, y = my + 14;
    if (x + tw > W - 8) x = mx - tw - 14;
    if (y + th > H - 8) y = my - th - 14;
    tipEl.style.left = Math.max(8, x) + 'px';
    tipEl.style.top = Math.max(8, y) + 'px';
  }
  function hideTip() { tipEl.hidden = true; }

  function nodeTip(n) {
    return (el) => {
      el.append(h('b', null, n.label));
      el.append(h('span', null, KIND_LABEL[n.kind] + ' · ' + n.area + (n.type ? ' · ' + n.type : '')));
      const max = TUNE.labels.tipNoteChars;
      if (n.note) el.append(h('p', null, n.note.length > max ? n.note.slice(0, max - 3) + '...' : n.note));
    };
  }

  function onMove(ev) {
    const [mx, my] = d3.pointer(ev, canvas);
    const n = pick(mx, my);
    const b = n ? null : pickBar(mx, my);
    if (n !== S.hover || b !== S.hoverBar) { S.hover = n; S.hoverBar = b; dirty = true; }
    canvas.classList.toggle('over', !!(n || b));
    if (n) showTip(mx, my, nodeTip(n));
    else if (b) {
      showTip(mx, my, (el) => {
        el.append(h('b', null, b.d.day));
        el.append(h('span', null, b.d.runs + (b.d.runs === 1 ? ' snapshot run, ' : ' snapshot runs, ') + b.d.files + ' files'));
        if (b.d.cats.length) el.append(h('p', null, b.d.cats.join(', ')));
      });
    } else hideTip();
  }

  function select(n, fly) {
    S.sel = n;
    if (n) renderCard(); else hideCard();
    if (n && fly) flyTo(n);
    dirty = true;
  }

  const drag = d3.drag()
    .container(canvas)
    .subject((ev) => {
      if (S.view !== 'links') return null;
      const n = pick(ev.x, ev.y);
      return n ? { n, x: ev.x, y: ev.y } : null;
    })
    .on('start', (ev) => {
      simHot = true;
      if (!ev.active) sim.alphaTarget(TUNE.force.dragAlpha).restart();
      hideTip();
    })
    .on('drag', (ev) => {
      const [wx, wy] = S.k.invert([ev.x, ev.y]);
      ev.subject.n.sim.fx = wx; ev.subject.n.sim.fy = wy;
    })
    .on('end', (ev) => {
      if (!ev.active) sim.alphaTarget(0);
      const n = ev.subject.n;
      if (n.kind !== 'root') { n.sim.fx = null; n.sim.fy = null; }
    });

  d3.select(canvas).call(drag).call(zoom).on('dblclick.zoom', null);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerleave', () => { S.hover = null; S.hoverBar = null; hideTip(); dirty = true; });
  canvas.addEventListener('click', (ev) => {
    const [mx, my] = d3.pointer(ev, canvas);
    const n = pick(mx, my);
    select(n && n === S.sel ? null : n, false);
  });
  canvas.addEventListener('dblclick', (ev) => {
    const [mx, my] = d3.pointer(ev, canvas);
    const n = pick(mx, my);
    if (n) { select(n, true); openFile(n); }
  });

  // -- legend ----------------------------------------------------------------
  function legendSection(title, dim) {
    const hd = h('h3', null, title);
    if (S.iso && S.iso.dim === dim) {
      const clr = h('button', null, 'clear');
      clr.addEventListener('click', () => { S.iso = null; renderLegend(); dirty = true; });
      hd.append(clr);
    }
    const ul = h('ul');
    legendEl.append(hd, ul);
    return ul;
  }
  function legendItem(ul, dim, value, lead, label, count, title) {
    const li = h('li');
    li.append(lead, h('span', 'name', label), h('span', 'n', String(count)));
    if (title) li.title = title;
    if (S.iso && S.iso.dim === dim) li.classList.add(S.iso.value === value ? 'on' : 'off');
    li.addEventListener('click', () => {
      S.iso = S.iso && S.iso.dim === dim && S.iso.value === value ? null : { dim, value };
      renderLegend();
      dirty = true;
    });
    ul.append(li);
  }

  function renderLegend() {
    legendEl.replaceChildren();
    if (!nodes.length) return;
    if (S.colorBy === 'area') {
      const ul = legendSection('area', 'area');
      const counts = d3.rollup(nodes, (v) => v.length, (n) => n.area);
      for (const a of areaOrder) {
        const sw = h('span', 'sw');
        sw.style.background = areaColor(a);
        const shared = a !== 'core' && !areaSlot.has(a);
        legendItem(ul, 'area', a, sw, a, counts.get(a), shared ? 'Past eight areas the hue is shared; position and labels carry identity' : null);
      }
    } else {
      const ul = legendSection('review status', 'health');
      const counts = d3.rollup(nodes, (v) => v.length, (n) => n.health || 'none');
      for (const st of HEALTH) {
        if (!counts.get(st.key)) continue;
        const ic = h('span', 'icon ' + st.cls, st.icon);
        legendItem(ul, 'health', st.key, ic, st.label, counts.get(st.key));
      }
      if (counts.get('none')) {
        const sw = h('span', 'sw');
        sw.style.background = tok.other;
        legendItem(ul, 'health', 'none', sw, 'not a memory file', counts.get('none'));
      }
    }
    const kinds = d3.rollup(nodes, (v) => v.length, (n) => n.kind);
    const ulk = legendSection('kind', 'kind');
    for (const k of KINDS) if (kinds.get(k)) legendItem(ulk, 'kind', k, shapeIcon(k), KIND_LABEL[k], kinds.get(k));
    const types = d3.rollup(nodes.filter((n) => n.type), (v) => v.length, (n) => n.type);
    if (types.size) {
      const ult = legendSection('memory type', 'type');
      for (const ty of TYPES) if (types.get(ty)) legendItem(ult, 'type', ty, h('span', 'icon', '·'), ty, types.get(ty));
    }
    legendEl.append(h('h3', null, 'edges'));
    const NS = 'http://www.w3.org/2000/svg';
    for (const [d, label, dash] of [
      ['M1 5 L25 5', 'structure: import, index, lists', null],
      ['M1 8 Q13 -2 25 8', 'related (links, wikilinks)', null],
      ['M1 5 L25 5', 'hot to cold detail', '2 3'],
    ]) {
      const row = h('div', 'keyline');
      const svg = document.createElementNS(NS, 'svg');
      svg.setAttribute('viewBox', '0 0 26 10');
      const p = document.createElementNS(NS, 'path');
      p.setAttribute('d', d);
      p.setAttribute('fill', 'none');
      p.setAttribute('stroke', 'currentColor');
      if (dash) p.setAttribute('stroke-dasharray', dash);
      svg.append(p);
      row.append(svg, h('span', null, label));
      legendEl.append(row);
    }
  }

  // -- card & reader -------------------------------------------------------
  function hideCard() { cardEl.hidden = true; }

  function renderCard() {
    const n = S.sel;
    if (!n) return hideCard();
    cardEl.replaceChildren();
    const x = h('button', 'x', '×');
    x.title = 'Close (Esc)';
    x.addEventListener('click', () => select(null));
    cardEl.append(x, h('h2', null, n.label));

    const chips = h('div', 'chips');
    const kc = h('span', 'chip');
    kc.append(shapeIcon(n.kind), document.createTextNode(KIND_LABEL[n.kind]));
    const ac = h('span', 'chip');
    const sw = h('span', 'sw');
    sw.style.background = areaColor(n.area);
    ac.append(sw, document.createTextNode(n.area));
    chips.append(kc, ac);
    if (n.type) chips.append(h('span', 'chip', n.type));
    if (n.volatility && n.tier) chips.append(h('span', 'chip', n.tier + ' · ' + n.volatility));
    cardEl.append(chips);

    if (n.t) cardEl.append(h('div', 'meta', 'changed ' + fmtDay(n.t) + ' ' + fmtTime(n.t) + ' (' + daysAgo(n.t) + ')'));
    const st = HEALTH.find((s) => s.key === n.health);
    if (st) {
      let msg = st.label;
      if (n.health === 'overdue') msg = 'past ' + n.volatility + ' half-life by ' + n.overdue + ' d';
      else if (n.overdue != null) msg += ', review in ' + -n.overdue + ' d';
      const row = h('div', 'meta');
      row.append(h('span', st.cls, st.icon + ' '), document.createTextNode(msg));
      cardEl.append(row);
    }
    if (n.lines != null) cardEl.append(h('div', 'meta', n.lines + ' body lines'));
    if (n.note) cardEl.append(h('p', 'note', n.note));
    if (n.rel) cardEl.append(h('div', 'path', n.rel));
    if (n.flags && n.flags.length) {
      const ul = h('ul', 'flags');
      for (const f of n.flags) ul.append(h('li', null, f));
      cardEl.append(ul);
    }

    const act = h('div', 'actions');
    const bOpen = h('button', null, 'open');
    bOpen.disabled = !n.path || !!n.dir;
    bOpen.addEventListener('click', () => openFile(n));
    const bCopy = h('button', null, 'copy path');
    bCopy.disabled = !n.path;
    bCopy.addEventListener('click', () => copyPath(n, bCopy));
    const bFly = h('button', null, 'fly to');
    bFly.addEventListener('click', () => flyTo(n));
    act.append(bOpen, bCopy, bFly);
    cardEl.append(act);

    const nb = [...nbrs.get(n)].sort((a, b) => a.layer - b.layer || byLabel(a, b));
    if (nb.length) {
      cardEl.append(h('h4', null, 'linked (' + nb.length + ')'));
      const box = h('div', 'nbrs');
      for (const m of nb) {
        const b = h('button', 'chip');
        const s2 = h('span', 'sw');
        s2.style.background = fill(m);
        b.append(s2, document.createTextNode(m.label));
        b.title = KIND_LABEL[m.kind] + ' · ' + m.area;
        b.addEventListener('click', () => select(m, true));
        box.append(b);
      }
      cardEl.append(box);
    }
    cardEl.hidden = false;
  }

  async function copyPath(n, btn) {
    try {
      await navigator.clipboard.writeText(n.path);
      btn.textContent = 'copied';
    } catch (e) {
      btn.textContent = 'copy failed';
    }
    setTimeout(() => { btn.textContent = 'copy path'; }, 1200);
  }

  async function openFile(n) {
    if (!n.path || n.dir) return;
    const reader = $('#reader');
    $('#reader-path').textContent = n.rel || n.path;
    $('#reader-text').textContent = 'loading...';
    reader.hidden = false;
    try {
      const f = await fetchJSON('/api/file?src=' + encodeURIComponent(S.src) + '&id=' + encodeURIComponent(n.id));
      $('#reader-text').textContent = f.text + (f.truncated ? '\n\n[truncated at 512 KB]' : '');
    } catch (e) {
      $('#reader-text').textContent = 'could not read file: ' + e.message;
    }
    $('#reader-close').focus();
  }
  $('#reader-close').addEventListener('click', () => { $('#reader').hidden = true; });

  // -- header ----------------------------------------------------------------
  function renderStamp() {
    const el = $('#stamp');
    el.replaceChildren();
    if (!G) return;
    const m = G.meta;
    const built = new Date(m.built);
    el.append(document.createTextNode('built ' + fmtTime(built) + ' · ' + m.nodes + ' nodes, ' + m.links + ' links'));
    // Live state first: the stamp truncates from the right on narrow windows.
    const items = [];
    if (live && live.down) items.push(h('span', 'stale', '! server not answering since ' + fmtTime(live.down) + ', showing ' + fmtTime(built)));
    else if (live && live.error) {
      const s = h('span', 'stale', '! rebuild failed, showing the last good graph');
      s.title = live.error;
      items.push(s);
    }
    if (delta && Date.now() - delta.at < TUNE.live.noteMs) {
      const parts = [];
      if (delta.added.length) parts.push('+' + delta.added.length + ' new');
      if (delta.changed.length) parts.push(delta.changed.length + ' changed');
      if (delta.removed.length) parts.push(delta.removed.length + ' removed');
      if (parts.length) items.push(h('span', 'upd', 'updated ' + fmtTime(new Date(delta.at)) + ': ' + parts.join(', ')));
    }
    for (const it of items) el.append(document.createTextNode(' · '), it);
    if (m.last_snapshot) {
      const ls = new Date(m.last_snapshot);
      const age = Math.floor((Date.now() - ls.getTime()) / 86400000);
      el.append(document.createTextNode(' · '));
      const stale = TUNE.data.staleDays;
      const s = h('span', age > stale ? 'stale' : null,
        (age > stale ? '! snapshot ' + daysAgo(ls) : 'snapshot ' + (age < 1 ? fmtTime(ls) : daysAgo(ls))));
      s.title = 'Last snapshot commit ' + fmtDay(ls) + ' ' + fmtTime(ls);
      if (age > stale) s.title += ', older than ' + stale + ' days';
      el.append(s);
    }
    if (drawMs.length) {
      const med = drawMs.slice().sort((a, b) => a - b)[drawMs.length >> 1];
      el.append(document.createTextNode(' · draw ' + med.toFixed(1) + ' ms'));
    }
    if (G.meta.synthetic) {
      el.append(document.createTextNode(' · '));
      el.append(h('span', 'stale', 'synthetic data'));
    }
    el.title = el.textContent;
  }

  function syncToggles() {
    $('#t-names').setAttribute('aria-pressed', String(S.names));
    $('#t-motion').setAttribute('aria-pressed', String(S.motion));
    document.querySelectorAll('#colorby button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.color === S.colorBy)));
  }

  document.querySelectorAll('#views button').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
  document.querySelectorAll('#colorby button').forEach((b) => b.addEventListener('click', () => {
    S.colorBy = b.dataset.color;
    if (S.iso && (S.iso.dim === 'area' || S.iso.dim === 'health')) S.iso = null;
    syncToggles(); renderLegend(); if (S.sel) renderCard(); savePrefs(); dirty = true;
  }));
  $('#t-names').addEventListener('click', () => { S.names = !S.names; syncToggles(); savePrefs(); dirty = true; });
  $('#t-motion').addEventListener('click', () => { S.motion = !S.motion; syncToggles(); savePrefs(); dirty = true; });
  $('#t-fit').addEventListener('click', () => fit());
  $('#t-theme').addEventListener('click', () => {
    S.theme = S.theme === 'dark' ? 'light' : 'dark';
    applyTheme(); savePrefs();
  });
  function applyTheme() {
    document.documentElement.dataset.theme = S.theme;
    $('#t-theme').textContent = S.theme === 'dark' ? 'light' : 'dark';
    readTokens(); renderLegend(); if (S.sel) renderCard();
  }
  $('#t-full').addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen().catch(() => {});
  });
  $('#source').addEventListener('change', async (ev) => {
    S.src = ev.target.value;
    S.iso = null; S.sel = null; S.query = ''; $('#search').value = '';
    hideCard();
    nodes = [];
    try { await load(true); } catch (e) { showError(e); }
    savePrefs();
  });
  $('#search').addEventListener('input', (ev) => { S.query = ev.target.value.trim().toLowerCase(); dirty = true; });
  $('#search').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && S.query) {
      const score = (n) => (n.label.toLowerCase().includes(S.query) ? 1000 : 0) + n.deg;
      const m = nodes.filter(matchesQuery).sort((a, b) => score(b) - score(a))[0];
      if (m) select(m, true);
    } else if (ev.key === 'Escape') {
      ev.target.value = ''; S.query = ''; ev.target.blur(); dirty = true;
    }
  });

  document.addEventListener('keydown', (ev) => {
    if (ev.target instanceof HTMLInputElement || ev.target instanceof HTMLSelectElement) return;
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    if (ev.key === 'Escape') {
      if (!$('#reader').hidden) $('#reader').hidden = true;
      else if (S.sel) select(null);
      else if (S.iso || S.query) { S.iso = null; S.query = ''; $('#search').value = ''; renderLegend(); dirty = true; }
    } else if (ev.key === '/') { ev.preventDefault(); $('#search').focus(); }
    else if (ev.key >= '1' && ev.key <= '6') setView(VIEWS[+ev.key - 1]);
    else if (ev.key === 'f') fit();
    else if (ev.key === 'n') $('#t-names').click();
    else if (ev.key === 'm') $('#t-motion').click();
  });

  function resize() {
    const r = stage.getBoundingClientRect();
    const first = !W;
    W = Math.max(1, r.width); H = Math.max(1, r.height);
    dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    dirty = true;
    if (first && nodes.length) fit(0);
  }
  new ResizeObserver(resize).observe(stage);

  function showError(e) {
    const el = $('#empty');
    el.hidden = false;
    el.textContent = 'Could not load the graph: ' + e.message;
  }

  /* Console handle. bench() draws synchronously and forces a pixel readback,
     so Chrome's (GPU-accelerated) 2D rasterisation is included. */
  window.__brainmap2d = {
    bench(frames = 30) {
      if (S.view === 'orbit') projectAll();
      for (const n of nodes) { const [x, y] = target(n, performance.now()); n.x = x; n.y = y; }
      draw(1); ctx.getImageData(0, 0, 1, 1);
      const t = performance.now();
      for (let i = 0; i < frames; i++) draw(1);
      ctx.getImageData(0, 0, 1, 1);
      return +((performance.now() - t) / frames).toFixed(2);
    },
  };

  // -- boot ------------------------------------------------------------------
  async function boot() {
    const p = store.get();
    if (VIEWS.includes(p.view)) S.view = p.view;
    if (p.colorBy === 'area' || p.colorBy === 'health') S.colorBy = p.colorBy;
    if (typeof p.names === 'boolean') S.names = p.names;
    if (typeof p.motion === 'boolean') S.motion = p.motion;
    if (p.theme === 'light' || p.theme === 'dark') S.theme = p.theme;
    applyTheme();
    syncToggles();
    try {
      const sources = await fetchJSON('/api/sources');
      const sel = $('#source');
      for (const s of sources) {
        const o = h('option', null, s.label);
        o.value = s.key;
        sel.append(o);
      }
      if (sources.some((s) => s.key === p.src)) S.src = p.src;
      sel.value = S.src;
      resize();
      await load(true);
    } catch (e) {
      showError(e);
    }
    requestAnimationFrame(frame);
    live = follow();
    setInterval(renderStamp, 1000);
  }
  boot();
})();
