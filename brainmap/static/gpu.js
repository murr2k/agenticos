/* gpu.js - the brain map on sigma.js (WebGL 2D) with graphology.
   Nodes and edges are drawn by the GPU; labels stay on a 2D canvas layer and
   are culled by sigma's label grid. Layout is ForceAtlas2 in a web worker. */
(function () {
  'use strict';
  const { $ } = BM;
  const { UndirectedGraph } = graphology;
  const { FA2Layout, layoutForceAtlas2 } = graphologyLibrary;
  const container = $('#graph');

  const saved = BM.prefs.get('gpu');
  const S = {
    src: saved.src || 'live', colorBy: saved.colorBy === 'health' ? 'health' : 'area',
    labels: saved.labels !== false, theme: saved.theme === 'light' ? 'light' : 'dark',
    iso: null, query: '', hover: null, sel: null,
  };
  let tok = {}, model = null, data = null, graph = null, renderer = null;
  let fa2 = null, fa2Timer = null, focus = new Set(), matches = null, t0 = 0, watch = null;
  const meter = BM.meter();
  const gpu = BM.gpuInfo();

  /* -- tuning -------------------------------------------------------------------
     Every speed, count, size and threshold on this page lives in this one
     block, so tuning is one number. Sizes are sigma's pixels at zoom 1;
     times are ms. Colours are CSS tokens in style.css. */
  const TUNE = Object.freeze({
    bands: {                        // node counts where behaviour changes
      small: 500,                   // below: bigger nodes, every label eligible
      dimEdges: 5000,               // above: edges in the fainter grid colour
      big: 10000,                   // above: smaller nodes and edges, stricter labels
      huge: 20000,                  // above: no hover highlight; hide edges and labels while moving
    },
    size: {
      base: 2, slope: 1.4, max: 16, // px = min(max, base + slope x sqrt(degree))
      bigScale: 0.7, smallScale: 1.8,
      rootMin: 10,
      edge: 0.7, edgeBig: 0.4, edgeFocus: 1.4,
    },
    seed: {
      radius: 14,                   // area centres on a circle of radius x sqrt(nodes)
      spread: 8,                    // each area's cloud spans spread x sqrt(area size)
      prng: 42,
    },
    labels: {
      size: 11, density: 0.6, gridPx: 90,
      threshold: 5, thresholdBig: 9, thresholdSmall: 0,   // min rendered node size for a label
      forceFocus: 80,               // always label a focus set smaller than this
      forceMatches: 60,             // and a search result set smaller than this
    },
    hover: { gapPx: 6, padPx: 4, cornerPx: 4, ringGapPx: 4, ringWidth: 1.5 },
    camera: {
      minRatio: 0.005, maxRatio: 20, stagePadPx: 40,
      flyRatio: 0.12, flyMs: 700, fitMs: 500,
    },
    layout: {                       // ForceAtlas2 in its worker
      barnesHutOver: 1500,
      stopMs: 4000, stopMsMid: 9000, stopMsBig: 30000,    // auto-stop after ...
      midOver: 2000, bigOver: 12000,                      // ... by node count
    },
  });

  const save = () => BM.prefs.set('gpu', { src: S.src, colorBy: S.colorBy, labels: S.labels, theme: S.theme });
  const colorOf = (n) => BM.colorOf(n, S.colorBy, model, tok);

  // -- graph -------------------------------------------------------------------
  function sizeFor(n, deg, big) {
    const Z = TUNE.size;
    const s = Math.min(Z.max, Z.base + Z.slope * Math.sqrt(deg)) *
      (big ? Z.bigScale : data.nodes.length < TUNE.bands.small ? Z.smallScale : 1);
    return n.kind === 'root' ? Math.max(Z.rootMin, s) : s;
  }

  /* Start each area as a cloud around its own point on a circle, so
     ForceAtlas2 refines a sane picture instead of untangling noise. */
  function seed(n, rnd) {
    const i = model.order.indexOf(n.area);
    const R = Math.sqrt(data.nodes.length) * TUNE.seed.radius;
    const a = (i / model.order.length) * Math.PI * 2;
    const c = n.area === 'core' ? [0, 0] : [R * Math.cos(a), R * Math.sin(a)];
    const spread = Math.sqrt(model.counts.get(n.area)) * TUNE.seed.spread;
    const r = spread * Math.sqrt(rnd()), t = rnd() * Math.PI * 2;
    return [c[0] + r * Math.cos(t), c[1] + r * Math.sin(t)];
  }
  function mulberry(seedv) {
    return function () {
      seedv |= 0; seedv = (seedv + 0x6d2b79f5) | 0;
      let t = Math.imul(seedv ^ (seedv >>> 15), 1 | seedv);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function buildGraph() {
    graph = new UndirectedGraph();
    const rnd = mulberry(TUNE.seed.prng);
    const big = data.nodes.length > TUNE.bands.big;
    // `type` is sigma's program selector, so the memory type stays inside raw.
    for (const n of data.nodes) {
      const [x, y] = seed(n, rnd);
      graph.addNode(n.id, { x, y, label: n.label, raw: n });
    }
    for (const l of data.links) {
      if (graph.hasNode(l.s) && graph.hasNode(l.t) && !graph.hasEdge(l.s, l.t)) graph.addEdge(l.s, l.t, { kind: l.kind, size: big ? TUNE.size.edgeBig : TUNE.size.edge });
    }
    graph.updateEachNodeAttributes((id, a) => {
      a.size = sizeFor(a.raw, graph.degree(id), big);
      a.color = colorOf(a.raw);
      return a;
    });
  }

  function recolor() {
    graph.updateEachNodeAttributes((id, a) => { a.color = colorOf(a.raw); return a; }, { attributes: ['color'] });
  }

  // -- rendering ----------------------------------------------------------------
  function drawHover(ctx, d, settings) {
    const size = settings.labelSize;
    ctx.font = '600 ' + size + 'px ' + settings.labelFont;
    const label = d.label || '';
    const w = ctx.measureText(label).width;
    const Hv = TUNE.hover, p = Hv.padPx;
    const x = d.x + d.size + Hv.gapPx, y = d.y;
    ctx.fillStyle = tok.surface;
    ctx.strokeStyle = tok.axis;
    ctx.lineWidth = 1;
    if (label) {
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(x - p, y - size / 2 - p, w + 2 * p, size + 2 * p, Hv.cornerPx);
      else ctx.rect(x - p, y - size / 2 - p, w + 2 * p, size + 2 * p);
      ctx.fill(); ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(d.x, d.y, d.size + Hv.ringGapPx, 0, Math.PI * 2);
    ctx.strokeStyle = tok.ink;
    ctx.lineWidth = Hv.ringWidth;
    ctx.stroke();
    ctx.fillStyle = tok.ink;
    ctx.textBaseline = 'middle';
    ctx.fillText(label, x, y + 0.5);
  }

  // Reducers run for every node and edge on each refresh, so the common case
  // (nothing highlighted) returns the stored attributes untouched.
  const idle = () => !S.iso && !focus.size && !matches;

  function nodeReducer(id, attr) {
    if (idle() && S.labels) return attr;
    const n = attr.raw;
    if (S.iso && !BM.matchesIso(n, S.iso)) return Object.assign({}, attr, { hidden: true });
    const res = Object.assign({}, attr);
    if (focus.size) {
      if (focus.has(id)) { res.zIndex = 2; res.forceLabel = focus.size < TUNE.labels.forceFocus; if (id === (S.hover || S.sel)) res.highlighted = true; }
      else { res.color = tok.axis; res.label = ''; res.zIndex = 0; }
    } else if (matches) {
      if (matches.has(id)) { res.zIndex = 2; res.forceLabel = matches.size < TUNE.labels.forceMatches; }
      else { res.color = tok.axis; res.label = ''; }
    }
    if (!S.labels && !res.forceLabel) res.label = '';
    return res;
  }
  function edgeReducer(id, attr) {
    if (idle()) return attr;
    const [s, t] = graph.extremities(id);
    if (S.iso && !(BM.matchesIso(graph.getNodeAttribute(s, 'raw'), S.iso) && BM.matchesIso(graph.getNodeAttribute(t, 'raw'), S.iso))) {
      return Object.assign({}, attr, { hidden: true });
    }
    const c = S.hover || S.sel;
    if (c) {
      if (s !== c && t !== c) return Object.assign({}, attr, { hidden: true });
      return Object.assign({}, attr, { color: colorOf(graph.getNodeAttribute(c, 'raw')), size: TUNE.size.edgeFocus, zIndex: 1 });
    }
    if (matches && !(matches.has(s) && matches.has(t))) return Object.assign({}, attr, { hidden: true });
    return attr;
  }

  function makeRenderer() {
    const n = graph.order;
    const B = TUNE.bands, Lb = TUNE.labels, C = TUNE.camera;
    renderer = new Sigma(graph, container, {
      nodeReducer, edgeReducer,
      zIndex: true,
      labelFont: 'system-ui, -apple-system, "Segoe UI", sans-serif',
      labelSize: TUNE.labels.size,
      labelWeight: '400',
      labelColor: { color: tok.ink2 },
      labelRenderedSizeThreshold: n > B.big ? Lb.thresholdBig : n < B.small ? Lb.thresholdSmall : Lb.threshold,
      labelDensity: Lb.density,
      labelGridCellSize: Lb.gridPx,
      defaultEdgeColor: n > B.dimEdges ? tok.grid : tok.axis,
      defaultNodeColor: tok.other,
      defaultDrawNodeHover: drawHover,
      hideEdgesOnMove: n > B.huge,
      hideLabelsOnMove: n > B.huge,
      minCameraRatio: C.minRatio,
      maxCameraRatio: C.maxRatio,
      stagePadding: C.stagePadPx,
    });
    renderer.on('enterNode', ({ node }) => setHover(node));
    renderer.on('leaveNode', () => setHover(null));
    renderer.on('clickNode', ({ node }) => select(node, false));
    renderer.on('clickStage', () => select(null));
    renderer.on('beforeRender', () => { t0 = performance.now(); });
    renderer.on('afterRender', () => meter.push(performance.now() - t0));
    // kill() releases these contexts on purpose; the watch must end first.
    watch = new AbortController();
    for (const c of container.querySelectorAll('canvas')) BM.watchContext(c, watch.signal);
  }

  function setFocus() {
    const c = S.hover || S.sel;
    focus = new Set();
    if (c) { focus.add(c); graph.forEachNeighbor(c, (m) => focus.add(m)); }
  }
  function setHover(id) {
    // Above ~20k nodes a highlight pass costs a few hundred ms; keep hover to
    // the label and highlight on click only.
    if (graph.order > TUNE.bands.huge) return;
    S.hover = id;
    setFocus();
    renderer.refresh({ skipIndexation: true });
  }
  function select(id, fly) {
    S.sel = id;
    setFocus();
    renderer.refresh({ skipIndexation: true });
    const n = id ? graph.getNodeAttribute(id, 'raw') : null;
    const nb = id ? graph.neighbors(id).map((m) => graph.getNodeAttribute(m, 'raw')).sort((a, b) => a.layer - b.layer || a.label.localeCompare(b.label)) : [];
    BM.card($('#card'), n, nb, {
      src: S.src, colorOf,
      onSelect: (m, f) => select(m ? m.id : null, f),
      onFly: (m) => flyTo(m.id),
    });
    if (id && fly) flyTo(id);
  }
  function flyTo(id) {
    const d = renderer.getNodeDisplayData(id);
    if (d) renderer.getCamera().animate({ x: d.x, y: d.y, ratio: TUNE.camera.flyRatio }, { duration: TUNE.camera.flyMs });
  }

  // -- layout -----------------------------------------------------------------------
  function stopLayout() {
    if (fa2) { fa2.stop(); fa2.kill(); fa2 = null; }
    clearTimeout(fa2Timer);
    $('#t-layout').setAttribute('aria-pressed', 'false');
  }
  function startLayout() {
    stopLayout();
    const n = graph.order;
    const F = TUNE.layout;
    const settings = Object.assign(layoutForceAtlas2.inferSettings(graph), { barnesHutOptimize: n > F.barnesHutOver });
    fa2 = new FA2Layout(graph, { settings });
    fa2.start();
    $('#t-layout').setAttribute('aria-pressed', 'true');
    fa2Timer = setTimeout(stopLayout, n < F.midOver ? F.stopMs : n < F.bigOver ? F.stopMsMid : F.stopMsBig);
  }

  // -- ui ---------------------------------------------------------------------------
  function renderLegend() {
    BM.legend($('#legend'), data.nodes, model, S.colorBy, tok, S.iso, (iso) => {
      S.iso = iso; renderLegend(); renderer.refresh();
    });
  }
  function renderStamp() {
    const extra = [];
    const g = BM.h('span', gpu.software ? 'warn' : null,
      (gpu.software ? '! software GL: ' : 'GPU ') + BM.shortGpu(gpu.renderer));
    g.title = gpu.renderer + (gpu.software ? '. WebGL is running on the CPU here.' : '');
    extra.push(g);
    const ms = meter.get();
    if (ms != null) extra.push(document.createTextNode('render ' + ms.toFixed(1) + ' ms'));
    if (data.meta.synthetic) extra.push(BM.h('span', 'warn', 'synthetic data'));
    BM.stamp($('#stamp'), data.meta, extra);
  }
  function syncToggles() {
    $('#t-labels').setAttribute('aria-pressed', String(S.labels));
    document.querySelectorAll('#colorby button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.color === S.colorBy)));
  }

  let loadSeq = 0;
  async function load() {
    const my = ++loadSeq;
    stopLayout();
    if (renderer) { watch.abort(); renderer.kill(); renderer = null; }
    S.iso = null; S.sel = null; S.hover = null; focus = new Set(); matches = null;
    $('#card').hidden = true;
    $('#empty').hidden = false;
    $('#empty').textContent = 'loading...';
    let fresh;
    try {
      fresh = await BM.fetchJSON('/api/brain?src=' + encodeURIComponent(S.src));
    } catch (e) {
      if (my === loadSeq) $('#empty').textContent = 'Could not load the graph: ' + e.message;
      return;
    }
    // A newer load started while this one was fetching; drop the stale graph.
    if (my !== loadSeq) return;
    data = fresh;
    $('#empty').hidden = data.nodes.length > 0;
    $('#empty').textContent = 'No memory files found in this source.';
    model = BM.areaModel(data.nodes);
    buildGraph();
    makeRenderer();
    renderLegend();
    renderStamp();
    startLayout();
  }

  document.querySelectorAll('#colorby button').forEach((b) => b.addEventListener('click', () => {
    S.colorBy = b.dataset.color; S.iso = null;
    syncToggles(); recolor(); renderLegend(); save();
    if (S.sel) select(S.sel);
  }));
  $('#t-labels').addEventListener('click', () => { S.labels = !S.labels; syncToggles(); save(); renderer.refresh({ skipIndexation: true }); });
  $('#t-layout').addEventListener('click', () => (fa2 ? stopLayout() : startLayout()));
  $('#t-fit').addEventListener('click', () => renderer.getCamera().animatedReset({ duration: TUNE.camera.fitMs }));
  $('#t-theme').addEventListener('click', () => {
    S.theme = S.theme === 'dark' ? 'light' : 'dark';
    BM.theme(S.theme); tok = BM.tokens(); save();
    renderer.setSetting('labelColor', { color: tok.ink2 });
    renderer.setSetting('defaultEdgeColor', graph.order > TUNE.bands.dimEdges ? tok.grid : tok.axis);
    recolor(); renderLegend();
  });
  $('#source').addEventListener('change', (ev) => { S.src = ev.target.value; save(); load(); });
  $('#search').addEventListener('input', (ev) => {
    S.query = ev.target.value.trim().toLowerCase();
    matches = null;
    if (S.query) {
      matches = new Set();
      for (const n of data.nodes) if ((n.label + ' ' + (n.note || '') + ' ' + n.area).toLowerCase().includes(S.query)) matches.add(n.id);
    }
    renderer.refresh({ skipIndexation: true });
  });
  $('#search').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && matches && matches.size) {
      const best = [...matches].sort((a, b) =>
        (graph.getNodeAttribute(b, 'label').toLowerCase().includes(S.query) ? 1e6 : 0) + graph.degree(b) -
        (graph.getNodeAttribute(a, 'label').toLowerCase().includes(S.query) ? 1e6 : 0) - graph.degree(a))[0];
      select(best, true);
    } else if (ev.key === 'Escape') {
      ev.target.value = ''; S.query = ''; matches = null; ev.target.blur(); renderer.refresh({ skipIndexation: true });
    }
  });
  $('#reader-close').addEventListener('click', () => { $('#reader').hidden = true; });
  document.addEventListener('keydown', (ev) => {
    if (ev.target instanceof HTMLInputElement || ev.target instanceof HTMLSelectElement) return;
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    if (ev.key === 'Escape') {
      if (!$('#reader').hidden) $('#reader').hidden = true;
      else if (S.sel) select(null);
      else if (S.iso) { S.iso = null; renderLegend(); renderer.refresh(); }
    } else if (ev.key === '/') { ev.preventDefault(); $('#search').focus(); }
    else if (ev.key === 'f') $('#t-fit').click();
  });

  /* Console handle. bench() re-renders synchronously and waits on
     gl.finish() for every WebGL layer, so it counts GPU time too. */
  window.__brainmapgpu = {
    get renderer() { return renderer; },
    bench(frames = 30) {
      const gls = [...container.querySelectorAll('canvas')]
        .map((c) => c.getContext('webgl2') || c.getContext('webgl')).filter(Boolean);
      const t = performance.now();
      for (let i = 0; i < frames; i++) { renderer.refresh(); gls.forEach((g) => g.finish()); }
      return +((performance.now() - t) / frames).toFixed(2);
    },
  };

  async function boot() {
    BM.theme(S.theme);
    tok = BM.tokens();
    syncToggles();
    if (!gpu.ok) BM.banner('WebGL is not available in this browser, so this page cannot render. The canvas page still works.', 'crit');
    else if (gpu.software) BM.banner('WebGL is running on a software rasteriser (' + BM.shortGpu(gpu.renderer) + '), so the "GPU" work is on the CPU. Expect it to be slower than the canvas page.');
    try {
      S.src = await BM.sources($('#source'), S.src);
    } catch (e) {
      $('#empty').hidden = false;
      $('#empty').textContent = 'Could not reach the server: ' + e.message;
      return;
    }
    await load();
    setInterval(() => { if (data) renderStamp(); }, 1000);
  }
  boot();
})();
