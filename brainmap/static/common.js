/* common.js - shared by the WebGL pages (/gpu, /3d): tokens and palette,
   area model, legend, card, reader, sources, header stamp, GPU detection.
   The canvas page (app.js) predates this and keeps its own copy. */
window.BM = (function () {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const KIND_LABEL = {
    root: 'root CLAUDE.md', doc: 'referenced file', index: 'MEMORY.md index',
    project: 'project', memory: 'hot fact', detail: 'cold detail', skill: 'skill',
  };
  const HEALTH = [
    { key: 'fresh', label: 'fresh', icon: '✓', tok: 'good', cls: 'st-good' },
    { key: 'stable', label: 'stable, never expires', icon: '✓', tok: 'good', cls: 'st-good' },
    { key: 'due', label: 'due within 25%', icon: '!', tok: 'warning', cls: 'st-warning' },
    { key: 'overdue', label: 'past half-life', icon: '✕', tok: 'critical', cls: 'st-critical' },
  ];

  function h(tag, cls, text) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = text;
    return el;
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  const prefs = {
    get(k) { try { return JSON.parse(localStorage.getItem('brainmap.' + k) || '{}'); } catch (e) { return {}; } },
    set(k, v) { try { localStorage.setItem('brainmap.' + k, JSON.stringify(v)); } catch (e) { /* private mode */ } },
  };

  function tokens() {
    const cs = getComputedStyle(document.documentElement);
    const g = (n) => cs.getPropertyValue(n).trim();
    return {
      surface: g('--surface'), ink: g('--ink'), ink2: g('--ink-2'), muted: g('--muted'),
      grid: g('--grid'), axis: g('--axis'), other: g('--other'),
      good: g('--good'), warning: g('--warning'), critical: g('--critical'),
      series: [1, 2, 3, 4, 5, 6, 7, 8].map((i) => g('--series-' + i)),
    };
  }

  // Same rules as the canvas page: core, global, skills, then by size; eight
  // categorical slots in that order, the rest share the neutral hue.
  function areaModel(nodes) {
    const counts = new Map();
    for (const n of nodes) counts.set(n.area, (counts.get(n.area) || 0) + 1);
    const rank = (a) => (a === 'core' ? 0 : a === 'global' ? 1 : a === 'skills' ? 2 : 3);
    const order = [...counts.keys()].sort((a, b) => rank(a) - rank(b) || counts.get(b) - counts.get(a) || a.localeCompare(b));
    const slot = new Map();
    let i = 0;
    for (const a of order) if (a !== 'core' && i < 8) slot.set(a, i++);
    return { order, slot, counts };
  }
  function colorOf(n, colorBy, model, tok) {
    if (colorBy === 'health') {
      const st = HEALTH.find((x) => x.key === n.health);
      return st ? tok[st.tok] : tok.other;
    }
    if (n.area === 'core') return tok.ink;
    const s = model.slot.get(n.area);
    return s == null ? tok.other : tok.series[s];
  }

  async function fetchJSON(url) {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(res.status + ' ' + res.statusText);
    return res.json();
  }

  async function sources(select, current) {
    const list = await fetchJSON('/api/sources');
    for (const s of list) {
      const o = h('option', null, s.label);
      o.value = s.key;
      select.append(o);
    }
    const key = list.some((s) => s.key === current) ? current : list[0].key;
    select.value = key;
    return key;
  }

  /* Which GPU is WebGL really running on? A software rasteriser (SwiftShader,
     llvmpipe, Microsoft Basic Render) means "WebGL" is on the CPU and is
     usually slower than Canvas 2D. */
  function gpuInfo() {
    try {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl2') || c.getContext('webgl');
      if (!gl) return { ok: false, renderer: 'WebGL unavailable', software: true };
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      const renderer = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
      const software = /swiftshader|llvmpipe|software|basic render/i.test(renderer);
      const lose = gl.getExtension('WEBGL_lose_context');
      if (lose) lose.loseContext();
      return { ok: true, renderer, software, webgl2: typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext };
    } catch (e) {
      return { ok: false, renderer: 'WebGL error: ' + e.message, software: true };
    }
  }
  function shortGpu(r) {
    const m = /ANGLE \([^,]*,\s*([^,(]+?)(?:\s*\(0x[0-9a-f]+\))?\s*(?:Direct3D|D3D|,)/i.exec(r);
    return (m ? m[1] : r).replace(/\s+/g, ' ').trim();
  }

  function banner(msg, kind) {
    const b = $('#banner');
    b.textContent = msg;
    b.className = 'banner ' + (kind || 'warn');
    b.hidden = false;
  }

  /* A driver reset (TDR on Windows) takes every WebGL context on the page
     with it. Say so instead of leaving a silently blank stage. */
  function watchContext(canvas, signal) {
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      banner('GPU context lost (driver reset or GPU hang). Reload the page to re-create it.', 'crit');
    }, { signal });
  }

  function stamp(el, meta, extra) {
    el.replaceChildren();
    const built = new Date(meta.built);
    const t = built.toTimeString().slice(0, 5);
    el.append(document.createTextNode('built ' + t + ' · ' + meta.nodes.toLocaleString() + ' nodes, ' +
      meta.links.toLocaleString() + ' links'));
    for (const x of extra || []) {
      el.append(document.createTextNode(' · '));
      el.append(x);
    }
  }

  function legend(el, nodes, model, colorBy, tok, iso, onIso) {
    el.replaceChildren();
    const item = (ul, dim, value, lead, label, count) => {
      const li = h('li');
      li.append(lead, h('span', 'name', label), h('span', 'n', count.toLocaleString()));
      if (iso && iso.dim === dim) li.classList.add(iso.value === value ? 'on' : 'off');
      li.addEventListener('click', () => onIso(iso && iso.dim === dim && iso.value === value ? null : { dim, value }));
      ul.append(li);
    };
    const section = (title, dim) => {
      const hd = h('h3', null, title);
      if (iso && iso.dim === dim) {
        const clr = h('button', null, 'clear');
        clr.addEventListener('click', () => onIso(null));
        hd.append(clr);
      }
      const ul = h('ul');
      el.append(hd, ul);
      return ul;
    };
    if (colorBy === 'area') {
      const ul = section('area', 'area');
      const shown = model.order.slice(0, 30);
      for (const a of shown) {
        const sw = h('span', 'sw');
        sw.style.background = colorOf({ area: a }, 'area', model, tok);
        item(ul, 'area', a, sw, a, model.counts.get(a));
      }
      if (model.order.length > shown.length) {
        ul.append(h('li', 'more', '+ ' + (model.order.length - shown.length) + ' more areas (neutral hue)'));
      }
    } else {
      const ul = section('review status', 'health');
      const counts = new Map();
      for (const n of nodes) counts.set(n.health || 'none', (counts.get(n.health || 'none') || 0) + 1);
      for (const st of HEALTH) {
        if (counts.get(st.key)) item(ul, 'health', st.key, h('span', 'icon ' + st.cls, st.icon), st.label, counts.get(st.key));
      }
      if (counts.get('none')) {
        const sw = h('span', 'sw');
        sw.style.background = tok.other;
        item(ul, 'health', 'none', sw, 'not a memory file', counts.get('none'));
      }
    }
  }
  function matchesIso(n, iso) {
    if (!iso) return true;
    if (iso.dim === 'area') return n.area === iso.value;
    if (iso.dim === 'health') return (n.health || 'none') === iso.value;
    return true;
  }

  function card(el, n, nbrs, o) {
    if (!n) { el.hidden = true; return; }
    el.replaceChildren();
    const x = h('button', 'x', '×');
    x.title = 'Close (Esc)';
    x.addEventListener('click', () => o.onSelect(null));
    el.append(x, h('h2', null, n.label));
    const chips = h('div', 'chips');
    chips.append(h('span', 'chip', KIND_LABEL[n.kind] || n.kind));
    const ac = h('span', 'chip');
    const sw = h('span', 'sw');
    sw.style.background = o.colorOf(n);
    ac.append(sw, document.createTextNode(n.area));
    chips.append(ac);
    if (n.type) chips.append(h('span', 'chip', n.type));
    if (n.tier && n.volatility) chips.append(h('span', 'chip', n.tier + ' · ' + n.volatility));
    el.append(chips);
    if (n.changed) el.append(h('div', 'meta', 'changed ' + n.changed.replace('T', ' ').slice(0, 16)));
    const st = HEALTH.find((s) => s.key === n.health);
    if (st) {
      let msg = st.label;
      if (n.health === 'overdue') msg = 'past ' + n.volatility + ' half-life by ' + n.overdue + ' d';
      else if (n.overdue != null) msg += ', review in ' + -n.overdue + ' d';
      const row = h('div', 'meta');
      row.append(h('span', st.cls, st.icon + ' '), document.createTextNode(msg));
      el.append(row);
    }
    if (n.note) el.append(h('p', 'note', n.note));
    if (n.rel) el.append(h('div', 'path', n.rel));
    if (n.flags && n.flags.length) {
      const ul = h('ul', 'flags');
      for (const f of n.flags) ul.append(h('li', null, f));
      el.append(ul);
    }
    const act = h('div', 'actions');
    const bOpen = h('button', null, 'open');
    bOpen.disabled = !n.path || !!n.dir;
    bOpen.addEventListener('click', () => openFile(o.src, n));
    const bCopy = h('button', null, 'copy path');
    bCopy.disabled = !n.path;
    bCopy.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(n.path); bCopy.textContent = 'copied'; } catch (e) { bCopy.textContent = 'copy failed'; }
      setTimeout(() => { bCopy.textContent = 'copy path'; }, 1200);
    });
    const bFly = h('button', null, 'fly to');
    bFly.addEventListener('click', () => o.onFly(n));
    act.append(bOpen, bCopy, bFly);
    el.append(act);
    if (nbrs.length) {
      el.append(h('h4', null, 'linked (' + nbrs.length + ')'));
      const box = h('div', 'nbrs');
      for (const m of nbrs.slice(0, 60)) {
        const b = h('button', 'chip');
        const s2 = h('span', 'sw');
        s2.style.background = o.colorOf(m);
        b.append(s2, document.createTextNode(m.label));
        b.addEventListener('click', () => o.onSelect(m, true));
        box.append(b);
      }
      if (nbrs.length > 60) box.append(h('span', 'chip', '+' + (nbrs.length - 60) + ' more'));
      el.append(box);
    }
    el.hidden = false;
  }

  async function openFile(src, n) {
    if (!n.path || n.dir) return;
    $('#reader-path').textContent = n.rel || n.path;
    $('#reader-text').textContent = 'loading...';
    $('#reader').hidden = false;
    try {
      const f = await fetchJSON('/api/file?src=' + encodeURIComponent(src) + '&id=' + encodeURIComponent(n.id));
      $('#reader-text').textContent = f.text + (f.truncated ? '\n\n[truncated at 512 KB]' : '');
    } catch (e) {
      $('#reader-text').textContent = 'could not read file: ' + e.message;
    }
    $('#reader-close').focus();
  }

  function theme(t) {
    document.documentElement.dataset.theme = t;
    const b = $('#t-theme');
    if (b) b.textContent = t === 'dark' ? 'light' : 'dark';
  }

  /* Frame-time meter: median of the last 30 samples, so one GC pause does not
     read as the steady state. */
  function meter() {
    const xs = [];
    return {
      push(ms) { xs.push(ms); if (xs.length > 30) xs.shift(); },
      get() {
        if (!xs.length) return null;
        const s = xs.slice().sort((a, b) => a - b);
        return s[s.length >> 1];
      },
    };
  }

  return { $, h, esc, KIND_LABEL, HEALTH, prefs, tokens, areaModel, colorOf, fetchJSON, sources,
    gpuInfo, shortGpu, banner, watchContext, stamp, legend, matchesIso, card, openFile, theme, meter };
})();
