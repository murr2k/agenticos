/* orbit.js - the brain map as an orbital disc: three.js r183 (vendored ES
   modules), instanced, so one draw call per node kind and one for all links.

   The layout is polar and deterministic. The root sits at the centre, skills
   on an inner ring, then the memory band, where each area owns a sector
   filled with arc rows (a parliament-chart fill: the area's hub badge on the
   inner edge, hot facts by degree on the inner rows, cold detail outermost).
   Files the root references sit on an outer ring and snapshot runs tick
   round the rim, today at 12 o'clock. "top" looks straight down for the flat
   rings view; "stack" lifts each tier onto its own plane. */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const BM = window.BM;
const { $ } = BM;
const host = $('#graph');
const stage = $('#stage');

const saved = BM.prefs.get('orbit');
const S = {
  src: saved.src || 'live', colorBy: saved.colorBy === 'health' ? 'health' : 'area',
  theme: saved.theme === 'light' ? 'light' : 'dark',
  top: !!saved.top, stack: !!saved.stack, names: !!saved.names,
  glow: saved.glow !== false, motion: saved.motion !== false,
  iso: null, query: '', hover: null, sel: null,
};
const save = () => BM.prefs.set('orbit', {
  src: S.src, colorBy: S.colorBy, theme: S.theme, top: S.top, stack: S.stack,
  names: S.names, glow: S.glow, motion: S.motion,
});

/* -- tuning -----------------------------------------------------------------------------
   Every speed, count, size and threshold on this page lives in this one block,
   so tuning is one number. Distances are world units unless marked px; times are
   ms. Colours are CSS tokens in style.css, not here. */
const TUNE = Object.freeze({
  layout: {
    spacingMin: 10,               // dot spacing for large graphs
    spacingMax: 22,               // cap for small graphs, so labels have room
    spacingRefCount: 300,         // spacing = min x sqrt(ref / band nodes), clamped
    arc: 0.72,                    // spacing along an arc row, x spacing
    row: 1.35,                    // pitch between arc rows, x spacing; arc x row ~ 1
                                  // keeps density while making rows read as arcs
    sectorExponent: 0.8,          // sector width grows as (area size - 1)^this
    sectorGapMax: 0.05,           // rad between sectors, or ...
    sectorGapShare: 0.4,          // ... share x PI / areas, whichever is smaller
    rinMin: 110,                  // inner radius of the memory band
    rinPerArea: 1.2,              // x spacing per area around the inner ring
    rinPad: 18,
    bandDepthMin: 70,             // target band radius at least rin + this
    bandSlack: 1.08,              // headroom on the packed band radius
    bandEdgeMin: 40,              // band outer edge at least rin + this
    spacingShrink: 0.98,          // safety factor when an area must pack tighter
    hubInset: 16,                 // hub sits this far inside the band
    skillRingMin: 45,
    skillRingFrac: 0.55,          // skill ring radius = max(min, frac x rin)
    refGap: 40,                   // band edge to references ring
    runGap: 36,                   // references ring to runs ring
    rimGap: 44,                   // runs ring to rim
    flatY: [3, 1.5, 0, -1.5],     // flat-mode height by layer (root, 1, hot, cold)
    tierY: [1.45, 0.95, 0.45, 0], // stack-mode height by layer, x stack height
    stackFrac: 0.22,              // stack height = frac x target band radius
    ringDrop: 0.5,                // rings sit this far under their tier
    glowDrop: 2,                  // glow sprites sit this far under their tier
  },
  size: {
    root: 9,                      // pick radius; the root draws as an outline
    rootHex: 11,                  // root outline circumradius
    projectBase: 4, projectSlope: 0.35, projectMax: 7,      // base + slope x sqrt(degree)
    hubIndexBase: 4, hubIndexSlope: 0.3, hubIndexMax: 6.5,  // an index that is its area's hub
    index: 3,
    skill: 2.6,
    doc: 3.4,
    dotBase: 1.3, dotSlope: 0.5, dotMax: 4.2,               // hot facts
    dotOfSpacing: 0.36,           // and never more than this x the area's spacing
    coldScale: 0.85,              // cold detail relative to hot
  },
  look: {
    pixelRatioMax: 2,
    bloomStrength: 0.55,
    bloomRadius: 0.4,
    bloomThreshold: 0.18,         // above the neutral hue, so only saturated areas glow
    linkOpacityMax: 0.28,
    linkOpacityMin: 0.03,
    linkOpacityRef: 2000,         // opacity = max x sqrt(ref / links), clamped
    hotOpacity: 0.95,             // focus links
    glowOpacityDark: 0.11,
    glowOpacityRootDark: 0.07,
    glowOpacityLight: 0.08,
    glowDimmed: 0.25,             // glow multiplier for areas outside the focus
    glowScale: 2.6,               // sprite size = scale x (rms spread + pad)
    glowPad: 14,
    rootGlowSize: 70,
    ring: { skills: 0.5, memory: 0.55, bandEdge: 0.25, references: 0.5, runs: 0.4, rim: 0.35 },
    bandEdgePad: 8,               // faint ring just outside the band
    tickOpacity: 0.9,
  },
  runs: {
    days: 120,                    // span of the runs ring
    tickBase: 4, tickPerRun: 5, tickMax: 26,                // length = base + min(max, perRun x runs)
  },
  camera: {
    fov: 45,
    tiltDeg: 55,                  // polar angle of the tilted view
    damping: 0.08,
    autoRotateSpeed: 0.35,
    fitPad: 24,                   // framed radius = rim + pad
    fitTop: 1.04,                 // vertical framing factor, top view
    fitTilt: 0.8,                 // vertical framing factor, tilted view
    fitStackGain: 0.4,            // extra vertical room per unit of stack height
    fitWidth: 1.02,               // horizontal framing factor
    fitTargetStack: 0.45,         // look-at height as a fraction of stack height
    fitMs: 900,
    flyMin: 70, flyFrac: 0.3,     // fly-to distance = max(min, frac x rim)
    flyMs: 1100,
    stackMs: 900,
  },
  labels: {
    badgeAreas: 30,               // biggest areas that get a badge (global always does)
    maxNames: 400,                // "names" labels, top by degree
    ringPad: 10,                  // ring names sit this far outside their ring
    runsPad: 30,
    rootOffset: 20,               // root name below the outline
    hubLift: 3,                   // badge height above its hub
    ringLift: 2,                  // ring name height above its ring
    nameLift: 2,                  // name height above its dot
    badgeCharPx: 7, badgePadPx: 26, badgeAnchorPx: 8,       // declutter box estimates
    nameCharPx: 5.6, namePadPx: 6,
    boxHalfPx: 8,
  },
  pick: {
    minPx: 7,                     // pick radius at least this ...
    padPx: 4,                     // ... or projected radius + pad
    clickMovePx: 5,               // a press that moved further is a drag, not a click
    tipNoteChars: 150,
  },
  frame: {
    legendPx: 250, cardPx: 360,   // panels the disc is centred away from ...
    wideMinPx: 900,               // ... on viewports at least this wide
  },
});
let spacing = TUNE.layout.spacingMin;   // set per graph by layout()

let tok = {}, model = null, data = null, byId = new Map(), adj = new Map();
let L = null, world = null, meshes = {}, linkLines = null, hotLines = null;
let rings = [], glows = [], labels = [], names = [];
let active = null;                  // Set of node ids in focus, or null
let stackE = S.stack ? 1 : 0, stackTween = null, camTween = null;
let dirty = true, projDirty = true, proj = null, loadSeq = 0;
let W = 1, H = 1, pointer = null, downAt = null;
let frames = 0, fps = 0, fpsT = performance.now(), calls = 0;
const gpu = BM.gpuInfo();

// -- renderer, camera, controls, post-processing ------------------------------
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, TUNE.look.pixelRatioMax));
renderer.info.autoReset = false;
host.append(renderer.domElement);
const labelRenderer = new CSS2DRenderer();
labelRenderer.domElement.className = 'css2d';
host.append(labelRenderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(TUNE.camera.fov, 1, 1, 400000);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = TUNE.camera.damping;
controls.autoRotateSpeed = TUNE.camera.autoRotateSpeed;
controls.addEventListener('change', () => { dirty = true; projDirty = true; });
controls.addEventListener('start', () => { camTween = null; });

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256),
  TUNE.look.bloomStrength, TUNE.look.bloomRadius, TUNE.look.bloomThreshold);
composer.addPass(bloom);
composer.addPass(new OutputPass());

const watch = new AbortController();
BM.watchContext(renderer.domElement, watch.signal);

const GLOW_TEX = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.3, 'rgba(255,255,255,0.4)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
})();

const bloomOn = () => S.glow && S.theme === 'dark';
// Core (root, referenced files) in secondary ink: pure white blooms to a blob.
const colorOf = (n) => (n.area === 'core' && S.colorBy === 'area' ? tok.ink2 : BM.colorOf(n, S.colorBy, model, tok));
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const deg = (n) => (adj.get(n.id) || []).length;

// -- layout ---------------------------------------------------------------------
function nodeSize(n, areaSpacing) {
  const d = deg(n), Z = TUNE.size;
  switch (n.kind) {
    case 'root': return Z.root;
    case 'project': return Math.min(Z.projectMax, Z.projectBase + Z.projectSlope * Math.sqrt(d));
    case 'index': return n.hub ? Math.min(Z.hubIndexMax, Z.hubIndexBase + Z.hubIndexSlope * Math.sqrt(d)) : Z.index;
    case 'skill': return Z.skill;
    case 'doc': return Z.doc;
    default: {
      const s = Math.min(Z.dotMax, Z.dotBase + Z.dotSlope * Math.sqrt(d), Z.dotOfSpacing * areaSpacing);
      return n.kind === 'detail' ? s * Z.coldScale : s;
    }
  }
}

function layout() {
  const nodes = data.nodes;
  const bandKinds = new Set(['project', 'index', 'memory', 'detail']);
  const byArea = new Map();
  for (const n of nodes) {
    n.hub = false;
    if (bandKinds.has(n.kind)) {
      if (!byArea.has(n.area)) byArea.set(n.area, []);
      byArea.get(n.area).push(n);
    }
  }
  const areas = model.order.filter((a) => byArea.has(a));
  const hubs = new Map();
  for (const a of areas) {
    const arr = byArea.get(a);
    const hub = arr.find((n) => n.kind === 'project') || arr.find((n) => n.kind === 'index') ||
      arr.slice().sort((x, y) => deg(y) - deg(x))[0];
    hub.hub = true;
    hubs.set(a, hub);
  }

  const T = TUNE.layout, ARC = T.arc, ROW = T.row;
  const N = [...byArea.values()].reduce((s, v) => s + v.length, 0);
  // Small graphs spread out so labels have room; large ones pack at the minimum.
  spacing = Math.min(T.spacingMax, Math.max(T.spacingMin, T.spacingMin * Math.sqrt(T.spacingRefCount / Math.max(1, N))));
  const gap = Math.min(T.sectorGapMax, (T.sectorGapShare * Math.PI) / Math.max(1, areas.length));
  const span = Math.PI * 2 - gap * areas.length;
  const rin = Math.max(T.rinMin, (areas.length * spacing * T.rinPerArea) / (Math.PI * 2) + T.rinPad);
  const rout = Math.max(rin + T.bandDepthMin, Math.sqrt(rin * rin + (2 * ROW * ARC * spacing * spacing * N) / span) * T.bandSlack);

  // Sector width grows as a power of area size: big areas get wider and, packed
  // into the same band, denser; small areas stay a tight cluster by their badge.
  const w = areas.map((a) => Math.pow(Math.max(1, byArea.get(a).length - 1), T.sectorExponent));
  const total = w.reduce((s, x) => s + x, 0);
  const sectors = new Map();
  let a0 = -Math.PI / 2 + gap / 2;
  areas.forEach((a, i) => {
    const da = (span * w[i]) / total;
    sectors.set(a, [a0, a0 + da]);
    a0 += da + gap;
  });

  const place = (n, r, ang) => { n.px = r * Math.cos(ang); n.pz = r * Math.sin(ang); n.ang = ang; n.rad = r; };
  const rank = { index: 0, project: 0, memory: 1, detail: 2 };
  const outer = new Map();
  for (const a of areas) {
    const [s0, s1] = sectors.get(a);
    const da = s1 - s0, mid = (s0 + s1) / 2;
    const hub = hubs.get(a);
    place(hub, rin - T.hubInset, mid);
    hub.size = nodeSize(hub, spacing);
    const items = byArea.get(a).filter((n) => n !== hub)
      .sort((x, y) => rank[x.kind] - rank[y.kind] || deg(y) - deg(x) || x.label.localeCompare(y.label));
    // Shrink the spacing only when the sector cannot hold the area in the band.
    const cap = (da * (rout * rout - rin * rin)) / (2 * ROW * ARC * spacing * spacing);
    const s = items.length > cap ? spacing * Math.sqrt(cap / items.length) * T.spacingShrink : spacing;
    let j = 0, k = 0;
    while (k < items.length) {
      const r = rin + (j + 0.5) * s * ROW;
      const c = Math.max(1, Math.floor((da * r) / (s * ARC)));
      const m = Math.min(c, items.length - k);
      // Even rows sit at quarter slots and odd rows at three-quarter slots, so
      // neighbouring rows are offset by half a slot and never line up radially.
      const off = j % 2 ? 0.75 : 0.25;
      for (let q = 0; q < m; q++) {
        const ang = m === c ? s0 + ((q + off) * da) / c
          : mid + (q - (m - 1) / 2 + off - 0.5) * ((s * ARC) / r);
        const n = items[k + q];
        place(n, r, ang);
        n.size = nodeSize(n, s);
      }
      k += m;
      j++;
    }
    outer.set(a, rin + j * s * ROW);
  }

  const rSk = Math.max(T.skillRingMin, rin * T.skillRingFrac);
  const skills = nodes.filter((n) => n.kind === 'skill');
  skills.forEach((n, i) => { place(n, rSk, -Math.PI / 2 + ((i + 0.5) * Math.PI * 2) / skills.length); n.size = nodeSize(n); });
  const bandOuter = Math.max(rin + T.bandEdgeMin, ...outer.values());
  const rRef = bandOuter + T.refGap;
  const docs = nodes.filter((n) => n.kind === 'doc');
  docs.forEach((n, i) => { place(n, rRef, -Math.PI / 2 + ((i + 0.5) * Math.PI * 2) / docs.length); n.size = nodeSize(n); });
  for (const n of nodes) if (n.kind === 'root') { place(n, 0, 0); n.size = nodeSize(n); }
  const rRun = rRef + T.runGap;
  const rRim = rRun + T.rimGap;

  const stackH = T.stackFrac * rout;
  for (const n of nodes) {
    n.yFlat = T.flatY[n.layer] ?? 0;
    n.yStack = (T.tierY[n.layer] ?? 0) * stackH;
  }
  L = { rin, rout: bandOuter, rSk, rRef, rRun, rRim, stackH, sectors, hubs, outer, areas };
}

// -- scene construction ---------------------------------------------------------
const GEOMETRY = {
  root: () => new THREE.CylinderGeometry(1, 1, 0.5, 6),
  project: () => new THREE.CylinderGeometry(1, 1, 0.8, 6),
  index: () => new THREE.BoxGeometry(1.4, 1.4, 1.4),
  memory: () => new THREE.SphereGeometry(1, 14, 10),
  detail: () => new THREE.OctahedronGeometry(1.25),
  skill: () => new THREE.TetrahedronGeometry(1.5),
  doc: () => new THREE.DodecahedronGeometry(1.2),
};

function dispose() {
  for (const o of labels.concat(names)) o.removeFromParent();
  labels = []; names = [];
  if (world) {
    world.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
    scene.remove(world);
  }
  world = null; meshes = {}; rings = []; glows = []; linkLines = null; hotLines = null;
}

function ringLine(r, layer, opacity) {
  const pts = [];
  for (let i = 0; i < 256; i++) {
    const a = (i / 256) * Math.PI * 2;
    pts.push(r * Math.cos(a), 0, r * Math.sin(a));
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  const line = new THREE.LineLoop(g, new THREE.LineBasicMaterial({ transparent: true, opacity, depthWrite: false }));
  line.userData.layer = layer;
  world.add(line);
  rings.push(line);
  return line;
}

function css2d(el, x, y, z, layer) {
  const o = new CSS2DObject(el);
  o.position.set(x, y, z);
  o.userData = { layer, x, z, dy: y };
  world.add(o);
  labels.push(o);
  return o;
}

function build() {
  dispose();
  world = new THREE.Group();
  scene.add(world);
  const nodes = data.nodes;

  const byKind = new Map();
  for (const n of nodes) {
    if (!byKind.has(n.kind)) byKind.set(n.kind, []);
    byKind.get(n.kind).push(n);
  }
  for (const [kind, arr] of byKind) {
    const mesh = new THREE.InstancedMesh((GEOMETRY[kind] || GEOMETRY.memory)(), new THREE.MeshBasicMaterial({ color: 0xffffff }), arr.length);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;     // instance positions move with "stack"
    arr.forEach((n, i) => { n.mesh = mesh; n.ix = i; });
    mesh.setColorAt(0, new THREE.Color(1, 1, 1));   // allocates instanceColor
    world.add(mesh);
    meshes[kind] = mesh;
  }

  const lg = new THREE.BufferGeometry();
  lg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(data.links.length * 6), 3).setUsage(THREE.DynamicDrawUsage));
  lg.setAttribute('color', new THREE.BufferAttribute(new Float32Array(data.links.length * 6), 3));
  // Additive lines stack: fade them as their number grows so 100k links read
  // as a haze rather than saturating to white.
  const K = TUNE.look;
  const linkOpacity = Math.max(K.linkOpacityMin, Math.min(K.linkOpacityMax,
    K.linkOpacityMax * Math.sqrt(K.linkOpacityRef / Math.max(1, data.links.length))));
  linkLines = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({
    vertexColors: true, transparent: true, opacity: linkOpacity, depthWrite: false,
  }));
  linkLines.frustumCulled = false;
  world.add(linkLines);
  hotLines = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: K.hotOpacity, depthWrite: false }));
  hotLines.frustumCulled = false;
  world.add(hotLines);

  // Rings and their names at 12 o'clock (-z is up in the top view).
  const ringLabel = (r, text, layer) => {
    const el = BM.h('div', 'ringlabel', text);
    css2d(el, 0, 0, -r - TUNE.labels.ringPad, layer);
  };
  if (byKind.has('skill')) { ringLine(L.rSk, 2, K.ring.skills); ringLabel(L.rSk, 'skills', 2); }
  ringLine(L.rin, 2, K.ring.memory);
  ringLabel(L.rin, 'memory', 2);
  ringLine(L.rout + K.bandEdgePad, 3, K.ring.bandEdge);
  if (byKind.has('doc')) { ringLine(L.rRef, 1, K.ring.references); ringLabel(L.rRef, 'references', 1); }
  ringLine(L.rRim, 3, K.ring.rim);

  // Runs: one radial tick per day over the last TUNE.runs.days days, today at
  // 12 o'clock and time running backwards counter-clockwise.
  const runs = new Map((data.activity || []).map((d) => [d.day, d]));
  const DAYS = TUNE.runs.days;
  if (runs.size) {
    ringLine(L.rRun, 3, K.ring.runs);
    ringLabel(L.rRun + TUNE.labels.runsPad, 'runs · ' + DAYS + ' d', 3);
    const pts = [];
    const today = new Date();
    for (let d = 0; d < DAYS; d++) {
      const day = new Date(today.getFullYear(), today.getMonth(), today.getDate() - d);
      const key = day.getFullYear() + '-' + String(day.getMonth() + 1).padStart(2, '0') + '-' + String(day.getDate()).padStart(2, '0');
      const r = runs.get(key);
      if (!r) continue;
      const a = -Math.PI / 2 - (d / DAYS) * Math.PI * 2;
      const len = TUNE.runs.tickBase + Math.min(TUNE.runs.tickMax, r.runs * TUNE.runs.tickPerRun);
      pts.push(L.rRun * Math.cos(a), 0, L.rRun * Math.sin(a), (L.rRun + len) * Math.cos(a), 0, (L.rRun + len) * Math.sin(a));
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    const ticks = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ transparent: true, opacity: K.tickOpacity }));
    ticks.userData.layer = 3;
    ticks.userData.series = true;
    world.add(ticks);
    rings.push(ticks);
  }

  // Area glow: an additive sprite per area centred on its cloud, biggest first.
  const clouds = L.areas.map((a) => {
    const members = data.nodes.filter((n) => n.area === a && n.px != null && n.layer >= 1);
    const cx = members.reduce((s, n) => s + n.px, 0) / members.length;
    const cz = members.reduce((s, n) => s + n.pz, 0) / members.length;
    const spread = Math.sqrt(members.reduce((s, n) => s + (n.px - cx) ** 2 + (n.pz - cz) ** 2, 0) / members.length);
    return { a, cx, cz, spread, count: members.length };
  }).filter((c) => model.slot.has(c.a))     // neutral-hued areas get no glow
    .sort((x, y) => y.count - x.count);
  for (const c of clouds) {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: GLOW_TEX, transparent: true, depthWrite: false }));
    sp.position.set(c.cx, 0, c.cz);
    sp.scale.setScalar(K.glowScale * (c.spread + K.glowPad));
    sp.userData = { area: c.a, layer: 2 };
    world.add(sp);
    glows.push(sp);
  }
  const rootNode = nodes.find((n) => n.kind === 'root');
  if (rootNode) {
    const hex = [];
    for (let i = 0; i < 6; i++) {
      const a = Math.PI / 6 + (i * Math.PI) / 3;
      hex.push(TUNE.size.rootHex * Math.cos(a), 0, TUNE.size.rootHex * Math.sin(a));
    }
    const hg = new THREE.BufferGeometry();
    hg.setAttribute('position', new THREE.Float32BufferAttribute(hex, 3));
    const outline = new THREE.LineLoop(hg, new THREE.LineBasicMaterial({ transparent: true, opacity: 1 }));
    outline.userData = { layer: 0, root: true };
    world.add(outline);
    rings.push(outline);
    const rl = css2d(BM.h('div', 'rootlabel', rootNode.label), 0, 0, TUNE.labels.rootOffset, 0);
    rl.userData.node = rootNode;
    rl.userData.below = true;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: GLOW_TEX, transparent: true, depthWrite: false }));
    sp.scale.setScalar(K.rootGlowSize);
    sp.userData = { area: 'core', layer: 0, root: true };
    world.add(sp);
    glows.push(sp);
  }

  // Hub badges: the biggest areas, always including global.
  const badged = new Set(L.areas.slice().sort((a, b) => model.counts.get(b) - model.counts.get(a))
    .slice(0, TUNE.labels.badgeAreas));
  badged.add('global');
  for (const a of L.areas) {
    if (!badged.has(a)) continue;
    const hub = L.hubs.get(a);
    const el = BM.h('div', 'hub');
    const inner = BM.h('span');
    const dot = BM.h('i', null, a === 'global' ? 'G' : a.replace(/^[^A-Za-z0-9]+/, '').charAt(0).toUpperCase());
    dot.dataset.area = a;
    inner.append(dot, BM.h('b', null, a), BM.h('small', null, String(model.counts.get(a))));
    el.append(inner);
    // As in the reference, the badge sits at the area's inner edge and is
    // the hub: its mesh is hidden, but it still picks. Declutter handles
    // crowding.
    const o = css2d(el, hub.px, 0, hub.pz, hub.layer);
    o.userData.node = hub;
    hub.badged = true;
  }
  if (S.names) buildNames();
  applyTheme();
  applyPositions();
}

function buildNames() {
  for (const o of names) o.removeFromParent();
  names = [];
  const pick = data.nodes.slice().sort((a, b) => deg(b) - deg(a)).slice(0, TUNE.labels.maxNames);
  for (const n of pick) {
    if (n.hub) continue;
    const o = new CSS2DObject(BM.h('div', 'nm', n.label));
    o.userData.node = n;
    world.add(o);
    names.push(o);
  }
  applyPositions();
}

// -- positions, colours, theme ----------------------------------------------------
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _p = new THREE.Vector3();
const _c = new THREE.Color();

function applyPositions() {
  const e = ease(stackE);
  const T = TUNE.layout, Lb = TUNE.labels;
  const yOf = (flat, layer) => flat + ((T.tierY[layer] ?? 0) * L.stackH - flat) * e;
  for (const n of data.nodes) {
    n.y = n.yFlat + (n.yStack - n.yFlat) * e;
    _p.set(n.px, n.y, n.pz);
    _s.setScalar(n.badged || n.kind === 'root' ? 1e-4 : n.size);
    _m.compose(_p, _q, _s);
    n.mesh.setMatrixAt(n.ix, _m);
  }
  for (const k in meshes) meshes[k].instanceMatrix.needsUpdate = true;
  const pos = linkLines.geometry.attributes.position.array;
  data.links.forEach((l, i) => {
    const a = byId.get(l.s), b = byId.get(l.t), o = i * 6;
    pos[o] = a.px; pos[o + 1] = a.y; pos[o + 2] = a.pz;
    pos[o + 3] = b.px; pos[o + 4] = b.y; pos[o + 5] = b.pz;
  });
  linkLines.geometry.attributes.position.needsUpdate = true;
  for (const r of rings) r.position.y = r.userData.root ? yOf(T.flatY[0], 0) : yOf(0, r.userData.layer) - T.ringDrop;
  for (const g of glows) g.position.y = yOf(0, g.userData.layer) - T.glowDrop;
  for (const o of labels) {
    if (o.userData.node) { o.position.y = o.userData.node.y + (o.userData.below ? 0 : Lb.hubLift); continue; }
    o.position.y = yOf(0, o.userData.layer) + Lb.ringLift;
  }
  for (const o of names) {
    const n = o.userData.node;
    o.position.set(n.px, n.y + n.size + Lb.nameLift, n.pz);
  }
  if (active) buildHot();
  projDirty = true;
  declutterDue = true;
  dirty = true;
}

function recolor() {
  const dim = new THREE.Color(tok.axis);
  for (const n of data.nodes) {
    const on = !active || active.has(n.id);
    n.mesh.setColorAt(n.ix, on ? _c.set(colorOf(n)) : dim);
  }
  for (const k in meshes) meshes[k].instanceColor.needsUpdate = true;
  const col = linkLines.geometry.attributes.color.array;
  const off = new THREE.Color(S.theme === 'dark' ? '#000000' : tok.grid);
  data.links.forEach((l, i) => {
    const on = !active || (active.has(l.s) && active.has(l.t));
    const a = byId.get(l.s), b = byId.get(l.t);
    const c = on ? _c.set(colorOf(b.layer > a.layer || a.area === 'core' ? b : a)) : off;
    col[i * 6] = col[i * 6 + 3] = c.r;
    col[i * 6 + 1] = col[i * 6 + 4] = c.g;
    col[i * 6 + 2] = col[i * 6 + 5] = c.b;
  });
  linkLines.geometry.attributes.color.needsUpdate = true;
  const areasOn = active ? new Set([...active].map((id) => byId.get(id).area)) : null;
  for (const g of glows) {
    const on = !areasOn || g.userData.root || areasOn.has(g.userData.area);
    g.material.color.set(g.userData.root ? tok.ink : BM.colorOf({ area: g.userData.area }, 'area', model, tok));
    const K = TUNE.look;
    g.material.opacity = (S.theme === 'dark' ? (g.userData.root ? K.glowOpacityRootDark : K.glowOpacityDark)
      : K.glowOpacityLight) * (on ? 1 : K.glowDimmed);
    g.visible = S.glow;
  }
  for (const o of labels) {
    const dot = o.element.querySelector('i');
    if (dot) dot.style.background = BM.colorOf({ area: dot.dataset.area }, 'area', model, tok);
  }
  buildHot();
  dirty = true;
}

function buildHot() {
  const c = S.hover || S.sel;
  const pts = [], cols = [];
  if (c) {
    const cc = new THREE.Color(colorOf(c));
    for (const [m] of adj.get(c.id) || []) {
      const b = byId.get(m);
      const bc = new THREE.Color(colorOf(b));
      pts.push(c.px, c.y, c.pz, b.px, b.y, b.pz);
      cols.push(cc.r, cc.g, cc.b, bc.r, bc.g, bc.b);
    }
  }
  hotLines.geometry.dispose();
  hotLines.geometry = new THREE.BufferGeometry();
  hotLines.geometry.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  hotLines.geometry.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
}

function applyTheme() {
  scene.background = new THREE.Color(tok.surface);
  const additive = S.theme === 'dark' ? THREE.AdditiveBlending : THREE.NormalBlending;
  linkLines.material.blending = additive;
  hotLines.material.blending = THREE.NormalBlending;
  for (const g of glows) g.material.blending = additive;
  for (const r of rings) r.material.color.set(r.userData.series ? tok.series[0] : r.userData.root ? tok.ink : tok.axis);
  for (const m of [linkLines.material, ...glows.map((g) => g.material)]) m.needsUpdate = true;
  bloom.enabled = bloomOn();
  recolor();
}

// -- focus, selection, camera -------------------------------------------------------
function setActive() {
  const c = S.hover || S.sel;
  if (c) {
    active = new Set([c.id, ...(adj.get(c.id) || []).map(([m]) => m)]);
  } else if (S.query || S.iso) {
    active = new Set();
    for (const n of data.nodes) {
      if (S.iso && !BM.matchesIso(n, S.iso)) continue;
      if (S.query && !(n.label + ' ' + (n.note || '') + ' ' + n.area).toLowerCase().includes(S.query)) continue;
      active.add(n.id);
    }
  } else {
    active = null;
  }
  recolor();
}

function select(n, fly) {
  S.sel = n || null;
  setActive();
  const nb = n ? (adj.get(n.id) || []).map(([m]) => byId.get(m)).sort((a, b) => a.layer - b.layer || a.label.localeCompare(b.label)) : [];
  BM.card($('#card'), n, nb, {
    src: S.src, colorOf,
    onSelect: (m, f) => select(m ? byId.get(m.id) : null, f),
    onFly: (m) => flyTo(byId.get(m.id)),
  });
  viewOffset();
  if (n && fly) flyTo(n);
}

function tween(toTarget, toPos, ms) {
  if (document.hidden || !ms) {
    controls.target.copy(toTarget);
    camera.position.copy(toPos);
    camTween = null;
    controls.update();
    dirty = projDirty = true;
    return;
  }
  camTween = { t0: performance.now(), ms, fT: controls.target.clone(), tT: toTarget, fP: camera.position.clone(), tP: toPos };
}

function flyTo(n) {
  const target = new THREE.Vector3(n.px, n.y, n.pz);
  const dir = camera.position.clone().sub(controls.target).normalize();
  const C = TUNE.camera;
  tween(target, target.clone().add(dir.multiplyScalar(Math.max(C.flyMin, L.rRim * C.flyFrac))), C.flyMs);
}

function fit(ms = TUNE.camera.fitMs) {
  if (!L) return;
  const C = TUNE.camera;
  const R = L.rRim + C.fitPad;
  const t = Math.tan((camera.fov * Math.PI) / 360);
  const vert = S.top ? C.fitTop : C.fitTilt + C.fitStackGain * ease(stackE) * (L.stackH / R);
  const D = Math.max((R * vert) / t, (R * C.fitWidth) / (t * camera.aspect));
  const polar = S.top ? 0.0001 : (C.tiltDeg * Math.PI) / 180;
  const y0 = ease(stackE) * L.stackH * C.fitTargetStack;
  tween(new THREE.Vector3(0, y0, 0), new THREE.Vector3(0, y0 + D * Math.cos(polar), D * Math.sin(polar)), ms);
}

// Keep the disc centred in the space the legend and card leave free.
function viewOffset() {
  declutterDue = true;
  const F = TUNE.frame;
  const left = W > F.wideMinPx ? F.legendPx : 0;
  const right = W > F.wideMinPx && !$('#card').hidden ? F.cardPx : 0;
  camera.setViewOffset(W, H, (right - left) / 2, 0, W, H);
  camera.updateProjectionMatrix();
  dirty = projDirty = true;
}

// -- picking: nearest node in screen space, cached until the camera moves ------------
const _v = new THREE.Vector3();
function projectAll() {
  const n = data.nodes.length;
  if (!proj || proj.length !== n * 3) proj = new Float32Array(n * 3);
  const k = (H / 2) / Math.tan((camera.fov * Math.PI) / 360);
  data.nodes.forEach((nd, i) => {
    _v.set(nd.px, nd.y, nd.pz);
    const d = _v.distanceTo(camera.position);
    _v.project(camera);
    proj[i * 3] = ((_v.x + 1) / 2) * W;
    proj[i * 3 + 1] = ((1 - _v.y) / 2) * H;
    proj[i * 3 + 2] = _v.z < 1 ? Math.max(TUNE.pick.minPx, (nd.size * k) / d + TUNE.pick.padPx) : -1;
  });
  projDirty = false;
}
function pick(x, y) {
  if (projDirty) projectAll();
  let best = null, bd = Infinity;
  for (let i = 0; i < data.nodes.length; i++) {
    const r = proj[i * 3 + 2];
    if (r < 0) continue;
    const dx = proj[i * 3] - x, dy = proj[i * 3 + 1] - y, d = dx * dx + dy * dy;
    if (d < r * r && d < bd) { bd = d; best = data.nodes[i]; }
  }
  return best;
}

function onHover() {
  if (!pointer || !data) return;
  const n = pick(pointer.x, pointer.y);
  const tip = $('#tip');
  if (n !== S.hover) {
    S.hover = n;
    setActive();
    renderer.domElement.style.cursor = n ? 'pointer' : '';
  }
  if (!n) { tip.hidden = true; return; }
  tip.replaceChildren(BM.h('b', null, n.label),
    BM.h('span', null, (BM.KIND_LABEL[n.kind] || n.kind) + ' · ' + n.area));
  const max = TUNE.pick.tipNoteChars;
  if (n.note) tip.append(BM.h('p', null, n.note.length > max ? n.note.slice(0, max - 3) + '...' : n.note));
  tip.hidden = false;
  const tw = tip.offsetWidth, th = tip.offsetHeight;
  let x = pointer.x + 14, y = pointer.y + 14;
  if (x + tw > W - 8) x = pointer.x - tw - 14;
  if (y + th > H - 8) y = pointer.y - th - 14;
  tip.style.left = Math.max(8, x) + 'px';
  tip.style.top = Math.max(8, y) + 'px';
}

const el = renderer.domElement;
el.addEventListener('pointermove', (e) => {
  const r = el.getBoundingClientRect();
  pointer = { x: e.clientX - r.left, y: e.clientY - r.top, pending: true };
});
el.addEventListener('pointerleave', () => {
  pointer = null; $('#tip').hidden = true;
  if (S.hover) { S.hover = null; setActive(); }
});
el.addEventListener('pointerdown', (e) => { downAt = { x: e.clientX, y: e.clientY }; });
el.addEventListener('pointerup', (e) => {
  if (!downAt || !data) return;
  const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
  downAt = null;
  if (moved > TUNE.pick.clickMovePx) return;
  const r = el.getBoundingClientRect();
  const n = pick(e.clientX - r.left, e.clientY - r.top);
  select(n && n === S.sel ? null : n, false);
});
el.addEventListener('dblclick', (e) => {
  const r = el.getBoundingClientRect();
  const n = pick(e.clientX - r.left, e.clientY - r.top);
  if (n) { select(n, true); BM.openFile(S.src, n); }
});

// -- label declutter ------------------------------------------------------------------
/* CSS2D labels know nothing about each other. When the camera settles, place
   them greedily in priority order (hub badges by area size, then node names
   by degree) and hide any whose estimated box would overlap one already
   placed. CSS2DRenderer rewrites style.display every frame, so visibility is
   driven through Object3D.visible. */
const _w = new THREE.Vector3();
let declutterDue = true;
function declutter() {
  declutterDue = false;
  const Lb = TUNE.labels;
  const items = [];
  for (const o of labels) {
    if (!o.element.classList.contains('hub')) continue;
    // Badges extend to the right of their anchor (the circle is on the hub).
    items.push({ o, pri: 1e6 + (model.counts.get(o.element.querySelector('i').dataset.area) || 0),
      w: o.element.textContent.length * Lb.badgeCharPx + Lb.badgePadPx, left: Lb.badgeAnchorPx });
  }
  for (const o of names) items.push({ o, pri: deg(o.userData.node), w: o.element.textContent.length * Lb.nameCharPx + Lb.namePadPx });
  items.sort((a, b) => b.pri - a.pri);
  const boxes = [];
  for (const it of items) {
    it.o.getWorldPosition(_w);
    _w.project(camera);
    if (_w.z > 1) { it.o.visible = false; continue; }
    const x = ((_w.x + 1) / 2) * W, y = ((1 - _w.y) / 2) * H;
    const x0 = it.left != null ? x - it.left : x - it.w / 2;
    const b = [x0, y - Lb.boxHalfPx, x0 + it.w, y + Lb.boxHalfPx];
    const hit = boxes.some((q) => b[0] < q[2] && b[2] > q[0] && b[1] < q[3] && b[3] > q[1]);
    it.o.visible = !hit;
    if (!hit) boxes.push(b);
  }
}

// -- render loop ----------------------------------------------------------------------
function renderNow() {
  renderer.info.reset();
  if (bloomOn()) composer.render(); else renderer.render(scene, camera);
  labelRenderer.render(scene, camera);
  calls = renderer.info.render.calls;
}

renderer.setAnimationLoop((now) => {
  if (!world) return;
  if (camTween) {
    const t = Math.min(1, (now - camTween.t0) / camTween.ms);
    const e = ease(t);
    controls.target.lerpVectors(camTween.fT, camTween.tT, e);
    camera.position.lerpVectors(camTween.fP, camTween.tP, e);
    dirty = projDirty = true;
    if (t >= 1) camTween = null;
  }
  if (stackTween) {
    const t = Math.min(1, (now - stackTween.t0) / TUNE.camera.stackMs);
    stackE = stackTween.from + (stackTween.to - stackTween.from) * t;
    applyPositions();
    if (t >= 1) stackTween = null;
  }
  controls.autoRotate = S.motion && !S.sel && !camTween;
  if (controls.update()) { dirty = projDirty = true; declutterDue = true; }
  if (camTween || stackTween) declutterDue = true;
  if (declutterDue && dirty) declutter();
  if (pointer && pointer.pending) { pointer.pending = false; onHover(); }
  if (dirty) {
    renderNow();
    frames++;
    dirty = false;
  }
  if (now - fpsT >= 1000) { fps = Math.round((frames * 1000) / (now - fpsT)); frames = 0; fpsT = now; }
});

// -- ui -------------------------------------------------------------------------------
function renderLegend() {
  BM.legend($('#legend'), data.nodes, model, S.colorBy, tok, S.iso, (iso) => {
    S.iso = iso; renderLegend(); setActive();
  });
}
function renderStamp() {
  if (!data) return;
  const extra = [];
  const g = BM.h('span', gpu.software ? 'warn' : null, (gpu.software ? '! software GL: ' : 'GPU ') + BM.shortGpu(gpu.renderer));
  g.title = gpu.renderer;
  extra.push(g);
  extra.push(document.createTextNode(document.hidden ? 'paused (tab hidden)' : fps ? fps + ' fps' : 'idle'));
  extra.push(document.createTextNode(calls + ' draw calls'));
  if (data.meta.synthetic) extra.push(BM.h('span', 'warn', 'synthetic data'));
  BM.stamp($('#stamp'), data.meta, extra);
}
function syncToggles() {
  for (const [id, on] of [['#t-top', S.top], ['#t-stack', S.stack], ['#t-names', S.names], ['#t-glow', S.glow], ['#t-motion', S.motion]]) {
    $(id).setAttribute('aria-pressed', String(on));
  }
  document.querySelectorAll('#colorby button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.color === S.colorBy)));
}

function resize() {
  W = Math.max(1, stage.clientWidth);
  H = Math.max(1, stage.clientHeight);
  renderer.setSize(W, H);
  labelRenderer.setSize(W, H);
  composer.setSize(W, H);
  camera.aspect = W / H;
  viewOffset();
}

async function load() {
  const my = ++loadSeq;
  S.iso = null; S.sel = null; S.hover = null; active = null;
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
  byId = new Map(data.nodes.map((n) => [n.id, n]));
  data.links = data.links.filter((l) => byId.has(l.s) && byId.has(l.t));
  adj = new Map(data.nodes.map((n) => [n.id, []]));
  for (const l of data.links) { adj.get(l.s).push([l.t, l]); adj.get(l.t).push([l.s, l]); }
  layout();
  build();
  renderLegend();
  viewOffset();
  fit(0);
  renderStamp();
}

document.querySelectorAll('#colorby button').forEach((b) => b.addEventListener('click', () => {
  S.colorBy = b.dataset.color; S.iso = null;
  syncToggles(); save(); renderLegend(); setActive();
  if (S.sel) select(S.sel);
}));
$('#t-top').addEventListener('click', () => { S.top = !S.top; syncToggles(); save(); fit(); });
$('#t-stack').addEventListener('click', () => {
  S.stack = !S.stack; syncToggles(); save();
  stackTween = { t0: performance.now(), from: stackE, to: S.stack ? 1 : 0 };
  if (document.hidden) { stackE = stackTween.to; stackTween = null; applyPositions(); }
});
$('#t-names').addEventListener('click', () => {
  S.names = !S.names; syncToggles(); save();
  if (S.names) buildNames(); else { for (const o of names) o.removeFromParent(); names = []; dirty = true; }
});
$('#t-glow').addEventListener('click', () => { S.glow = !S.glow; syncToggles(); save(); bloom.enabled = bloomOn(); recolor(); });
$('#t-motion').addEventListener('click', () => { S.motion = !S.motion; syncToggles(); save(); });
$('#t-fit').addEventListener('click', () => fit());
$('#t-theme').addEventListener('click', () => {
  S.theme = S.theme === 'dark' ? 'light' : 'dark';
  BM.theme(S.theme); tok = BM.tokens(); save();
  if (world) { applyTheme(); renderLegend(); }
});
$('#source').addEventListener('change', (ev) => { S.src = ev.target.value; save(); load(); });
$('#search').addEventListener('input', (ev) => { S.query = ev.target.value.trim().toLowerCase(); setActive(); });
$('#search').addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && S.query && data) {
    const score = (n) => (n.label.toLowerCase().includes(S.query) ? 1e6 : 0) + deg(n);
    const hits = data.nodes.filter((n) => (n.label + ' ' + (n.note || '') + ' ' + n.area).toLowerCase().includes(S.query));
    if (hits.length) select(hits.sort((a, b) => score(b) - score(a))[0], true);
  } else if (ev.key === 'Escape') {
    ev.target.value = ''; S.query = ''; ev.target.blur(); setActive();
  }
});
$('#reader-close').addEventListener('click', () => { $('#reader').hidden = true; });
document.addEventListener('keydown', (ev) => {
  if (ev.target instanceof HTMLInputElement || ev.target instanceof HTMLSelectElement) return;
  if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
  if (ev.key === 'Escape') {
    if (!$('#reader').hidden) $('#reader').hidden = true;
    else if (S.sel) select(null);
    else if (S.iso) { S.iso = null; renderLegend(); setActive(); }
  } else if (ev.key === '/') { ev.preventDefault(); $('#search').focus(); }
  else if (ev.key === 'f') fit();
  else if (ev.key === 't') $('#t-top').click();
  else if (ev.key === 's') $('#t-stack').click();
  else if (ev.key === 'n') $('#t-names').click();
  else if (ev.key === 'm') $('#t-motion').click();
});
new ResizeObserver(resize).observe(stage);

/* Console handle. bench() renders synchronously and waits on gl.finish(), so
   it measures real CPU + GPU cost per frame, bloom included when it is on. */
window.__brainmaporbit = {
  get renderer() { return renderer; },
  get camera() { return camera; },
  bench(frames = 30) {
    const gl = renderer.getContext();
    renderNow(); gl.finish();
    const t = performance.now();
    for (let i = 0; i < frames; i++) renderNow();
    gl.finish();
    return { ms: +((performance.now() - t) / frames).toFixed(2), calls };
  },
};

async function boot() {
  BM.theme(S.theme);
  tok = BM.tokens();
  syncToggles();
  resize();
  if (!gpu.ok) { BM.banner('WebGL is not available in this browser, so this page cannot render. The canvas page still works.', 'crit'); return; }
  if (gpu.software) BM.banner('WebGL is running on a software rasteriser (' + BM.shortGpu(gpu.renderer) + '), so the "GPU" work is on the CPU. Expect it to be slow.');
  try {
    S.src = await BM.sources($('#source'), S.src);
  } catch (e) {
    $('#empty').hidden = false;
    $('#empty').textContent = 'Could not reach the server: ' + e.message;
    return;
  }
  await load();
  setInterval(renderStamp, 1000);
}
boot();
