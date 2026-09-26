/* 3d.js - the brain map in real 3D: 3d-force-graph on three.js (WebGL).
   Layout is d3-force-3d on the main thread; nodes are meshes, links are
   GL lines. An optional "shells" force pulls each memory tier onto its own
   sphere, the real-3D version of the canvas page's 2.5D orbit. */
(function () {
  'use strict';
  const { $ } = BM;
  const el = $('#graph');
  const stage = $('#stage');

  const saved = BM.prefs.get('3d');
  const S = {
    src: saved.src || 'live', colorBy: saved.colorBy === 'health' ? 'health' : 'area',
    shells: saved.shells !== false, motion: saved.motion !== false,
    theme: saved.theme === 'light' ? 'light' : 'dark',
    iso: null, query: '', hover: null, sel: null,
  };

  /* -- tuning -------------------------------------------------------------------
     Every speed, count, size and threshold on this page lives in this one
     block, so tuning is one number. Distances are three.js world units; times
     are ms. Colours are CSS tokens in style.css. */
  const TUNE = Object.freeze({
    bands: {                        // node counts where behaviour changes
      warmupUnder: 3000,            // below: pre-run the layout before the first frame
      big: 5000,                    // above: coarser spheres, fainter links, stronger ...
      banner: 8000,                 // above: explain the draw-call limit
      huge: 20000,                  // above: coarsest, no hover restyling
    },
    distance: { import: 40, loads: 18, index: 22, lists: 50, skill: 40, ref: 35, scope: 60, detail: 12, related: 30 },
    distanceDefault: 30,
    shells: {
      base: 38,                     // outer shell radius = base x cbrt(nodes)
      radii: [0, 0.4, 0.78, 1],     // shell radius by layer, x the outer radius
      strength: 0.12,
    },
    node: {
      rootVal: 30, valPerLink: 0.8, // sphere volume value = 1 + perLink x degree
      relSize: 3, relSizeHuge: 2,
      resolution: 12, resolutionBig: 6, resolutionHuge: 4,
      opacity: 0.95,
    },
    link: {
      opacity: 0.28, opacityBig: 0.14, opacityHuge: 0.08,
      hotWidth: 0.8,
      particles: 2, particlesMaxLinks: 200, particleWidth: 1.6, particleSpeed: 0.006,
    },
    sim: {
      charge: -60, chargeBig: -25, chargeHuge: -12,
      velocityDecay: 0.3,
      warmupTicks: 120,
      cooldownMs: 12000, cooldownBigMs: 18000, cooldownHugeMs: 25000,
    },
    camera: {
      fitTicks: 40,                 // first fit after this many layout ticks
      fitMs: 700, fitStopMs: 900, fitPadPx: 40,
      flyDistance: 90, flyMs: 1200,
      autoRotateSpeed: 0.5,
    },
  });
  let tok = {}, model = null, data = null, G = null, byId = new Map(), adj = new Map();
  let focus = new Set(), hotLinks = new Set(), matches = null, moved = false, watch = null, ticks = 0;
  const gpu = BM.gpuInfo();
  let fps = null;

  const save = () => BM.prefs.set('3d', { src: S.src, colorBy: S.colorBy, shells: S.shells, motion: S.motion, theme: S.theme });
  const colorOf = (n) => BM.colorOf(n, S.colorBy, model, tok);
  const size = () => data.nodes.length;

  /* Pull each node toward the sphere of its tier. Radii scale with the cube
     root of the node count so the shells stay apart as the graph grows. */
  function shellForce() {
    let nodes = [];
    function force(alpha) {
      if (!S.shells) return;
      const Sh = TUNE.shells;
      const base = Sh.base * Math.cbrt(nodes.length);
      const R = Sh.radii.map((f) => f * base);
      for (const n of nodes) {
        const r = Math.hypot(n.x, n.y, n.z) || 1e-6;
        const k = (((R[n.layer] || base) - r) / r) * Sh.strength * alpha;
        n.vx += n.x * k; n.vy += n.y * k; n.vz += n.z * k;
      }
    }
    force.initialize = (ns) => { nodes = ns; };
    return force;
  }

  function nodeColor(n) {
    if (focus.size) return focus.has(n.id) ? colorOf(n) : tok.axis;
    if (matches) return matches.has(n.id) ? colorOf(n) : tok.axis;
    return colorOf(n);
  }
  function tooltip(n) {
    return '<b>' + BM.esc(n.label) + '</b><span>' + BM.esc((BM.KIND_LABEL[n.kind] || n.kind) + ' · ' + n.area) + '</span>';
  }
  function visible(n) { return BM.matchesIso(n, S.iso); }
  const endId = (x) => (typeof x === 'object' ? x.id : x);

  function restyle() {
    // Re-setting an accessor makes the library re-evaluate it for every object.
    G.nodeColor(G.nodeColor())
      .linkWidth(G.linkWidth())
      .linkColor(G.linkColor())
      .linkDirectionalParticles(G.linkDirectionalParticles());
  }

  function setFocus() {
    const c = S.hover || S.sel;
    focus = new Set();
    hotLinks = new Set();
    if (c) {
      focus.add(c.id);
      for (const [m, l] of adj.get(c.id) || []) { focus.add(m); hotLinks.add(l); }
    }
  }

  function make() {
    const n = size();
    const B = TUNE.bands, Nd = TUNE.node, Lk = TUNE.link, Sm = TUNE.sim;
    const big = n > B.big, huge = n > B.huge;
    const nodes = data.nodes.map((d) => Object.assign({}, d));
    byId = new Map(nodes.map((d) => [d.id, d]));
    const links = data.links.filter((l) => byId.has(l.s) && byId.has(l.t))
      .map((l) => ({ source: l.s, target: l.t, kind: l.kind }));
    adj = new Map(nodes.map((d) => [d.id, []]));
    for (const l of links) { adj.get(l.source).push([l.target, l]); adj.get(l.target).push([l.source, l]); }
    for (const d of nodes) d.val = d.kind === 'root' ? Nd.rootVal : 1 + adj.get(d.id).length * Nd.valPerLink;
    const root = byId.get('root');
    if (root) { root.fx = 0; root.fy = 0; root.fz = 0; }

    G = new ForceGraph3D(el, { controlType: 'orbit' })
      .width(stage.clientWidth).height(stage.clientHeight)
      .backgroundColor(tok.surface)
      .showNavInfo(false)
      .nodeId('id')
      .nodeLabel(tooltip)
      .nodeVal('val')
      .nodeRelSize(huge ? Nd.relSizeHuge : Nd.relSize)
      .nodeResolution(huge ? Nd.resolutionHuge : big ? Nd.resolutionBig : Nd.resolution)
      .nodeOpacity(Nd.opacity)
      .nodeColor(nodeColor)
      .nodeVisibility(visible)
      .linkVisibility((l) => visible(l.source.id ? l.source : byId.get(endId(l.source))) &&
        visible(l.target.id ? l.target : byId.get(endId(l.target))))
      .linkColor((l) => (hotLinks.has(l) ? colorOf(S.hover || S.sel) : tok.muted))
      .linkOpacity(huge ? Lk.opacityHuge : big ? Lk.opacityBig : Lk.opacity)
      .linkWidth((l) => (hotLinks.has(l) ? Lk.hotWidth : 0))
      .linkDirectionalParticles((l) => (hotLinks.has(l) && hotLinks.size < Lk.particlesMaxLinks ? Lk.particles : 0))
      .linkDirectionalParticleWidth(Lk.particleWidth)
      .linkDirectionalParticleSpeed(Lk.particleSpeed)
      // Off: 3d-force-graph 1.80's drag-end handler calls OrbitControls'
      // private _onPointerCancel, which throws under the bundled three r183
      // and swallows the click that ended the drag.
      .enableNodeDrag(false)
      .cooldownTime(huge ? Sm.cooldownHugeMs : big ? Sm.cooldownBigMs : Sm.cooldownMs)
      .d3VelocityDecay(Sm.velocityDecay)
      .onNodeHover((node) => {
        el.style.cursor = node ? 'pointer' : '';
        if (huge) return;       // re-styling 20k+ objects per hover is not worth it
        S.hover = node || null;
        setFocus();
        restyle();
      })
      .onNodeClick((node) => select(node, true))
      .onBackgroundClick(() => select(null))
      .warmupTicks(n < B.warmupUnder ? Sm.warmupTicks : 0)
      // Fit once the layout has had some ticks to spread out (ticks, not a
      // timer: the library defers setup to the next animation frame), and
      // again when it freezes, unless the user has taken the camera.
      .onEngineTick(() => { if (++ticks === TUNE.camera.fitTicks && !moved) fit(TUNE.camera.fitMs); })
      .onEngineStop(() => { if (!moved) fit(TUNE.camera.fitStopMs); })
      .graphData({ nodes, links });

    G.d3Force('shell', shellForce());
    G.d3Force('charge').strength(huge ? Sm.chargeHuge : big ? Sm.chargeBig : Sm.charge);
    G.d3Force('link').distance((l) => TUNE.distance[l.kind] || TUNE.distanceDefault);
    const ctl = G.controls();
    ctl.autoRotate = S.motion;
    ctl.autoRotateSpeed = TUNE.camera.autoRotateSpeed;
    ctl.addEventListener('start', () => { moved = true; });
    watch = new AbortController();
    BM.watchContext(G.renderer().domElement, watch.signal);
  }

  // A background tab gets no animation frames, so a camera tween would stall
  // part-way; jump instead.
  function fit(ms) {
    G.zoomToFit(document.hidden ? 0 : ms, TUNE.camera.fitPadPx, visible);
  }

  function select(node, fly) {
    S.sel = node || null;
    setFocus();
    restyle();
    const nb = node ? adj.get(node.id).map(([m]) => byId.get(m)).sort((a, b) => a.layer - b.layer || a.label.localeCompare(b.label)) : [];
    BM.card($('#card'), node, nb, {
      src: S.src, colorOf,
      onSelect: (m, f) => select(m ? byId.get(m.id) : null, f),
      onFly: (m) => flyTo(byId.get(m.id)),
    });
    if (node && fly) flyTo(node);
    G.controls().autoRotate = S.motion && !S.sel;
  }
  function flyTo(n) {
    const dist = TUNE.camera.flyDistance;
    const r = Math.hypot(n.x, n.y, n.z);
    const pos = r < 1 ? { x: 0, y: 0, z: dist } : { x: n.x * (1 + dist / r), y: n.y * (1 + dist / r), z: n.z * (1 + dist / r) };
    G.cameraPosition(pos, { x: n.x, y: n.y, z: n.z }, TUNE.camera.flyMs);
  }

  // -- ui ---------------------------------------------------------------------------
  function renderLegend() {
    BM.legend($('#legend'), data.nodes, model, S.colorBy, tok, S.iso, (iso) => {
      S.iso = iso; renderLegend();
      G.nodeVisibility(G.nodeVisibility()).linkVisibility(G.linkVisibility());
    });
  }
  function renderStamp() {
    const extra = [];
    const g = BM.h('span', gpu.software ? 'warn' : null, (gpu.software ? '! software GL: ' : 'GPU ') + BM.shortGpu(gpu.renderer));
    g.title = gpu.renderer;
    extra.push(g);
    if (document.hidden) extra.push(document.createTextNode('paused (tab hidden)'));
    else if (fps != null) extra.push(document.createTextNode(fps + ' fps'));
    if (data.meta.synthetic) extra.push(BM.h('span', 'warn', 'synthetic data'));
    BM.stamp($('#stamp'), data.meta, extra);
  }
  function syncToggles() {
    $('#t-shells').setAttribute('aria-pressed', String(S.shells));
    $('#t-motion').setAttribute('aria-pressed', String(S.motion));
    document.querySelectorAll('#colorby button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.color === S.colorBy)));
  }

  // Frames actually presented per second: the library renders every frame,
  // so a slow GPU or a heavy scene shows up here directly.
  (function countFrames() {
    let frames = 0, last = performance.now();
    (function tick(now) {
      frames++;
      if (now - last >= 1000) { fps = Math.round((frames * 1000) / (now - last)); frames = 0; last = now; }
      requestAnimationFrame(tick);
    })(last);
  })();

  let loadSeq = 0;
  async function load() {
    const my = ++loadSeq;
    if (G) { watch.abort(); G.pauseAnimation(); G._destructor(); el.replaceChildren(); G = null; }
    S.iso = null; S.sel = null; S.hover = null; focus = new Set(); hotLinks = new Set(); matches = null; moved = false; ticks = 0;
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
    $('#banner').hidden = true;
    if (data.nodes.length > TUNE.bands.banner) {
      BM.banner('3d-force-graph draws one mesh per node and one line per link, so draw calls, not the GPU, ' +
        'set the frame rate: about 90 ms a frame at 10k nodes on an RTX 2070. The webgl 2d page is built for this size.');
    }
    make();
    renderLegend();
    renderStamp();
  }

  document.querySelectorAll('#colorby button').forEach((b) => b.addEventListener('click', () => {
    S.colorBy = b.dataset.color; S.iso = null;
    syncToggles(); renderLegend(); save(); restyle();
    if (S.sel) select(S.sel);
  }));
  $('#t-shells').addEventListener('click', () => { S.shells = !S.shells; syncToggles(); save(); G.d3ReheatSimulation(); });
  $('#t-motion').addEventListener('click', () => { S.motion = !S.motion; syncToggles(); save(); G.controls().autoRotate = S.motion && !S.sel; });
  $('#t-fit').addEventListener('click', () => fit(TUNE.camera.fitMs));
  $('#t-theme').addEventListener('click', () => {
    S.theme = S.theme === 'dark' ? 'light' : 'dark';
    BM.theme(S.theme); tok = BM.tokens(); save();
    G.backgroundColor(tok.surface); restyle(); renderLegend();
  });
  $('#source').addEventListener('change', (ev) => { S.src = ev.target.value; save(); load(); });
  $('#search').addEventListener('input', (ev) => {
    S.query = ev.target.value.trim().toLowerCase();
    matches = null;
    if (S.query) {
      matches = new Set();
      for (const n of data.nodes) if ((n.label + ' ' + (n.note || '') + ' ' + n.area).toLowerCase().includes(S.query)) matches.add(n.id);
    }
    restyle();
  });
  $('#search').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && matches && matches.size) {
      const score = (id) => (byId.get(id).label.toLowerCase().includes(S.query) ? 1e6 : 0) + adj.get(id).length;
      select(byId.get([...matches].sort((a, b) => score(b) - score(a))[0]), true);
    } else if (ev.key === 'Escape') {
      ev.target.value = ''; S.query = ''; matches = null; ev.target.blur(); restyle();
    }
  });
  $('#reader-close').addEventListener('click', () => { $('#reader').hidden = true; });
  document.addEventListener('keydown', (ev) => {
    if (ev.target instanceof HTMLInputElement || ev.target instanceof HTMLSelectElement) return;
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    if (ev.key === 'Escape') {
      if (!$('#reader').hidden) $('#reader').hidden = true;
      else if (S.sel) select(null);
      else if (S.iso) { S.iso = null; renderLegend(); G.nodeVisibility(G.nodeVisibility()).linkVisibility(G.linkVisibility()); }
    } else if (ev.key === '/') { ev.preventDefault(); $('#search').focus(); }
    else if (ev.key === 'f') $('#t-fit').click();
  });
  new ResizeObserver(() => { if (G) G.width(stage.clientWidth).height(stage.clientHeight); }).observe(stage);

  async function boot() {
    BM.theme(S.theme);
    tok = BM.tokens();
    syncToggles();
    if (!gpu.ok) { BM.banner('WebGL is not available in this browser, so this page cannot render. The canvas page still works.', 'crit'); return; }
    if (gpu.software) BM.banner('WebGL is running on a software rasteriser (' + BM.shortGpu(gpu.renderer) + '), so the "GPU" work is on the CPU. Expect it to be slower than the canvas page.');
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
  /* Console handle. bench() renders synchronously and waits on gl.finish(),
     so it measures real CPU + GPU cost per frame even in a throttled tab. */
  window.__brainmap3d = {
    get graph() { return G; },
    bench(frames = 30) {
      const r = G.renderer(), gl = r.getContext();
      r.render(G.scene(), G.camera()); gl.finish();
      const t = performance.now();
      for (let i = 0; i < frames; i++) r.render(G.scene(), G.camera());
      gl.finish();
      return +((performance.now() - t) / frames).toFixed(2);
    },
  };
  boot();
})();
