/*
 * Galaxy Graph — an Obsidian plugin (plain JavaScript, no build step).
 *
 * Arranges the global graph view into a spiral galaxy:
 *   - every MOC is the bright star at the base of its own spiral arm
 *   - the notes that belong to that MOC sit along the arm, in the MOC's colour
 *   - the note that links to your MOCs (e.g. "Home") is the galactic core
 *   - notes linked to nothing drift in a faint halo outside the disc
 *
 * Nothing is animated continuously and nothing is redrawn per frame by this
 * plugin: the glow behind the arms is one static picture that Obsidian's own
 * renderer pans and zooms together with the graph.
 */
'use strict';

const obsidian = require('obsidian');
const { Plugin, PluginSettingTab, Setting } = obsidian;

const TAU = Math.PI * 2;
const GOLDEN = 0.6180339887498949;
const GOLDEN_ANGLE = 2.399963229728653;

const DEFAULTS = {
  enabled: true,
  switchButton: true,    // a small on/off button in the corner of the graph view
  layout: true,          // arrange the global graph into a galaxy
  animate: true,         // glide notes into place instead of jumping
  mocText: 'MOC',        // a note with this word in its name is a MOC
  mocTag: 'moc',         // ...or a note with this tag
  centerNote: '',        // blank = work it out automatically
  pitch: 17,             // how open the spiral is, in degrees
  spread: 1,             // spacing between notes
  glow: 0.8,             // strength of the arm glow (0 = off)
  links: 0.5,            // how visible link lines are (0 = hidden)
  background: true,
  stars: true,
  names: true,           // note names get a thin dark edge and a readable size on sharp screens
  armLabels: true,
  legend: true,
  legendCollapsed: null,  // null = decide by screen width (collapsed on a phone)
};

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const frac = (v) => v - Math.floor(v);
const smooth = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Small deterministic random generator (mulberry32). */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Van der Corput sequence: 0, 1/2, 1/4, 3/4, 1/8 ... used to spread arms evenly by size. */
function vdc(n) {
  let v = 0, d = 0.5;
  while (n) {
    if (n & 1) v += d;
    n >>= 1;
    d /= 2;
  }
  return v;
}

function mixRgb(a, b, t) {
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
  return (Math.round(ar + (br - ar) * t) << 16) | (Math.round(ag + (bg - ag) * t) << 8) | Math.round(ab + (bb - ab) * t);
}

function hslRgb(h, s, l) {
  s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return (Math.round(f(0) * 255) << 16) | (Math.round(f(8) * 255) << 8) | Math.round(f(4) * 255);
}

const cssHex = (c) => '#' + (c & 0xffffff).toString(16).padStart(6, '0');
const cssRgba = (c, a) => `rgba(${(c >> 16) & 255},${(c >> 8) & 255},${c & 255},${a})`;

function parseColor(v) {
  if (typeof v !== 'string') return null;
  const m = v.trim().match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  return parseInt(h, 16);
}

const basename = (id) => {
  const s = String(id);
  const cut = s.lastIndexOf('/');
  return (cut >= 0 ? s.slice(cut + 1) : s).replace(/\.md$/i, '');
};

/** Matches `text` only as a whole word, so "MOC" does not match "Democracy". */
function wordRegex(text) {
  const t = (text || '').trim();
  if (!t) return null;
  const esc = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  try {
    return new RegExp('(^|[^\\p{L}\\p{N}])' + esc + 's?(?=$|[^\\p{L}\\p{N}])', 'iu');
  } catch (e) {
    return new RegExp('(^|[^A-Za-z0-9])' + esc + 's?(?=$|[^A-Za-z0-9])', 'i');
  }
}

/** For an all-capitals word such as MOC, also accept it glued on in CamelCase: "PoliticsMOC". */
function camelRegex(text) {
  const t = (text || '').trim();
  if (!t || t !== t.toUpperCase() || t === t.toLowerCase()) return null;
  return new RegExp('([a-z0-9])' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![a-z])');
}

/** "Politics MOC" -> "Politics". */
function stripWord(name, re, camel) {
  if (!re) return name;
  let s = name.replace(new RegExp(re.source, re.flags.replace('g', '') + 'g'), '$1');
  if (camel) s = s.replace(new RegExp(camel.source, 'g'), '$1');
  s = s.replace(/\(\s*\)|\[\s*\]/g, ' ').replace(/\s{2,}/g, ' ');
  s = s.replace(/^[\s\-–—_:|·,;]+|[\s\-–—_:|·,;]+$/g, '');
  return s || name;
}

const HOME_RE = /^\W*\d*\W*(home|index|start|dashboard|hub|main|root|contents|readme)\b/i;

/* ------------------------------------------------------------------ */
/* Colours                                                             */
/* ------------------------------------------------------------------ */

// The galaxy is laid out with generous gaps so note names have room once you zoom in;
// notes are drawn a little larger to match, so they still read as stars from far out.
const NODE_GAIN = 1.35;

// Ordered so that neighbours contrast: arms next to each other never look alike.
const PALETTE = [0x78b4ff, 0xffd479, 0xff8fb3, 0x5fe0c2, 0xb49cff, 0xff9e6e, 0xa5e36e, 0xe88df2, 0x62d4f5, 0xffc59e];
const COL = { core: 0xfff2d8, bulge: 0xf0dcae, halo: 0x8388a6, bg: 0x12111f, white: 0xffffff, grey: 0x8a8ca6 };

// Note names. A thin dark edge keeps them readable over the glow. On a sharp screen Obsidian draws
// names only a few points tall, so they are brought up to `px` CSS pixels (never by more than `max`
// times), as far as each name has room. The galaxy is laid out so that a name whose letters are
// `em` times the gap between notes tall does not touch its neighbours' names.
const NAME = { edge: '#0b0a15', edgeWidth: 4, px: 11, max: 2, em: 0.157 };

// Notes are drawn larger when zoomed out; the layout allows for it.
const VIS = 1.8;

function paletteColor(i) {
  if (i < PALETTE.length) return PALETTE[i];
  return hslRgb((i * 137.508 + 20) % 360, 78, 72);
}

/* ------------------------------------------------------------------ */
/* The galaxy model: who belongs where, and where everything sits      */
/* ------------------------------------------------------------------ */

/**
 * @param G { ids: string[], types: string[], weights: number[], edges: number[] (pairs), index: Map }
 * @param o { isMoc(id), name(id), label(id), color(id), centerId, pitchDeg, spread, sizeMult, maxArms, labels }
 */
function buildModel(G, o) {
  const N = G.ids.length, ids = G.ids, types = G.types;
  const sizeMult = clamp(o.sizeMult || 1, 0.3, 4);
  const s = 140 * clamp(o.spread || 1, 0.5, 2.5) * (0.55 + 0.45 * sizeMult); // base distance between notes

  /* ---- adjacency ---- */
  const out = new Array(N), inn = new Array(N), nbr = new Array(N);
  for (let i = 0; i < N; i++) { out[i] = []; inn[i] = []; }
  const seenEdge = new Set();
  const E = G.edges;
  for (let e = 0; e + 1 < E.length; e += 2) {
    const a = E[e], b = E[e + 1];
    if (a === b || a < 0 || b < 0 || a >= N || b >= N) continue;
    const key = a * N + b;
    if (seenEdge.has(key)) continue;
    seenEdge.add(key);
    out[a].push(b);
    inn[b].push(a);
  }
  const deg = new Int32Array(N);
  for (let i = 0; i < N; i++) {
    const set = new Set(out[i]);
    for (const v of inn[i]) set.add(v);
    nbr[i] = Array.from(set);
    deg[i] = set.size;
  }

  const isNote = (i) => !types[i] || types[i] === 'focused';
  const isTag = (i) => types[i] === 'tag';

  /* ---- node sizes, as Obsidian draws them ---- */
  const size = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const w = G.weights && Number.isFinite(G.weights[i]) ? G.weights[i] : deg[i];
    size[i] = clamp(3 * Math.sqrt(w + 1), 8, 30);
  }

  /* ---- which notes are MOCs, and which one is the centre ---- */
  let mocs = [];
  for (let i = 0; i < N; i++) if (isNote(i) && o.isMoc(ids[i])) mocs.push(i);

  /** The note that ties a set of hubs together: it links to most of them (a Home note, typically). */
  const findCore = (hubs) => {
    const set = new Set(hubs);
    let found = -1, best = -1;
    for (let i = 0; i < N; i++) {
      if (!isNote(i)) continue;
      let adj = 0, fwd = 0;
      for (const v of nbr[i]) if (set.has(v)) adj++;
      if (adj < 2) continue;
      for (const v of out[i]) if (set.has(v)) fwd++;
      const others = hubs.length - (set.has(i) ? 1 : 0);
      const need = Math.max(2, Math.ceil(others * 0.5));
      const homeish = HOME_RE.test(o.name(ids[i]));
      if (!(fwd >= need || (homeish && adj >= need))) continue;
      const score = adj * 1000 + fwd * 10 + (homeish ? 500 : 0) + Math.min(deg[i], 9);
      if (score > best || (score === best && cmp(ids[i], ids[found]) < 0)) { best = score; found = i; }
    }
    return found;
  };

  let core = -1;
  if (o.centerId != null && G.index.has(o.centerId)) core = G.index.get(o.centerId);
  if (core < 0 && mocs.length >= 2) core = findCore(mocs);
  if (core >= 0) mocs = mocs.filter((m) => m !== core);

  const maxArms = o.maxArms || 8;

  /** Breadth-first tree from one note; used when there are no MOCs to go on. */
  function promote(root) {
    const par = new Int32Array(N).fill(-1), dep = new Int32Array(N).fill(-1), order = [root];
    dep[root] = 0;
    for (let h = 0; h < order.length; h++) {
      const u = order[h];
      if (isTag(u) && u !== root) continue;
      for (const v of nbr[u]) if (dep[v] < 0) { dep[v] = dep[u] + 1; par[v] = u; order.push(v); }
    }
    const sub = new Int32Array(N).fill(1);
    for (let h = order.length - 1; h > 0; h--) sub[par[order[h]]] += sub[order[h]];
    const kids = order.filter((v) => par[v] === root && isNote(v));
    kids.sort((a, b) => sub[b] - sub[a] || deg[b] - deg[a] || cmp(ids[a], ids[b]));
    const need = Math.max(3, Math.ceil(order.length * 0.04));
    const picked = kids.filter((v) => sub[v] >= need).slice(0, maxArms);
    return picked.length >= 2 ? picked : [];
  }

  let seeds = mocs.slice();
  let auto = false;
  if (seeds.length === 1 && core < 0) { core = seeds[0]; seeds = []; }
  if (!seeds.length) {
    // No MOCs to go on: use the notes that are unusually well connected instead.
    auto = true;
    let sum = 0, cnt = 0;
    for (let i = 0; i < N; i++) if (isNote(i) && deg[i] > 0) { sum += deg[i]; cnt++; }
    const thr = Math.max(4, Math.ceil((cnt ? sum / cnt : 0) * 2.5));
    let hubs = [];
    for (let i = 0; i < N; i++) if (isNote(i) && deg[i] >= thr) hubs.push(i);
    hubs.sort((a, b) => deg[b] - deg[a] || cmp(ids[a], ids[b]));
    hubs = hubs.slice(0, 14);
    if (core < 0 && hubs.length >= 2) core = findCore(hubs);
    if (core < 0 && hubs.length === 1) core = hubs[0];
    if (core >= 0) {
      // every sizeable branch hanging off the centre becomes an arm
      seeds = promote(core);
      if (seeds.length < 2) {
        const near = new Set(nbr[core]);
        seeds = hubs.filter((h) => h !== core && near.has(h)).slice(0, maxArms);
        if (seeds.length < 2) seeds = [];
      }
    } else if (hubs.length >= 2) {
      const keep = [];
      for (const h of hubs) if (!keep.some((k) => nbr[k].includes(h))) keep.push(h); // skip hubs that hang off a bigger one
      seeds = keep.slice(0, maxArms);
      if (seeds.length === 1) { core = seeds[0]; seeds = promote(core); }
    }
  }

  /* ---- give every note to its nearest MOC ---- */
  const S = seeds.length;
  const grp = new Int32Array(N).fill(-1);    // seed number, -2 = around the core, -1 = unlinked
  const depth = new Int32Array(N).fill(-1);
  const parent = new Int32Array(N).fill(-1);
  const seedRank = new Map();
  seeds.slice().sort((a, b) => cmp(ids[a], ids[b])).forEach((m, k) => seedRank.set(seeds.indexOf(m), k));

  let frontier = [];
  seeds.forEach((m, k) => { grp[m] = k; depth[m] = 0; frontier.push(m); });
  if (core >= 0) { grp[core] = -2; depth[core] = 0; frontier.push(core); }
  for (let d = 0; frontier.length; d++) {
    const votes = new Map();
    frontier.sort((a, b) => a - b);
    for (const u of frontier) {
      if (isTag(u)) continue; // tags join a group but never pull other notes into it
      const g = grp[u];
      const cast = (v, w) => {
        if (depth[v] >= 0) return;
        let m = votes.get(v);
        if (!m) votes.set(v, (m = new Map()));
        let c = m.get(g);
        if (!c) m.set(g, (c = { w: 0, p: u }));
        c.w += w;
        if (deg[u] > deg[c.p] || (deg[u] === deg[c.p] && u < c.p)) c.p = u;
      };
      for (const v of out[u]) cast(v, 2);
      for (const v of inn[u]) cast(v, 1);
    }
    const next = [];
    for (const v of Array.from(votes.keys()).sort((a, b) => a - b)) {
      const m = votes.get(v);
      let bg = null, bw = -1, bp = -1;
      for (const [g, c] of m) {
        if (g === -2) continue; // a MOC always beats "linked from the core"
        if (c.w > bw || (c.w === bw && seedRank.get(g) < seedRank.get(bg))) { bg = g; bw = c.w; bp = c.p; }
      }
      if (bg === null) { bg = -2; bp = m.get(-2).p; }
      grp[v] = bg; parent[v] = bp; depth[v] = d + 1;
      next.push(v);
    }
    frontier = next;
  }

  /* ---- order the notes of each group so related notes sit together ---- */
  const kids = new Array(N).fill(null);
  const reached = [];
  for (let i = 0; i < N; i++) {
    if (depth[i] >= 0) reached.push(i);
    if (parent[i] >= 0) (kids[parent[i]] || (kids[parent[i]] = [])).push(i);
  }
  reached.sort((a, b) => depth[b] - depth[a]);
  const sub = new Int32Array(N).fill(1);
  for (const i of reached) if (parent[i] >= 0) sub[parent[i]] += sub[i];
  const kidCmp = (a, b) => sub[b] - sub[a] || deg[b] - deg[a] || cmp(ids[a], ids[b]);
  const subtree = (root) => {
    const res = [], stack = [root];
    while (stack.length) {
      const u = stack.pop();
      if (u !== root) res.push(u);
      const k = kids[u];
      if (k) { k.sort(kidCmp); for (let j = k.length - 1; j >= 0; j--) stack.push(k[j]); }
    }
    return res;
  };

  let segs = [];
  let bulge = [];
  if (S) {
    segs = seeds.map((m) => ({ moc: m, members: subtree(m), name: o.label(ids[m]), id: ids[m] }));
    if (core >= 0) bulge = subtree(core);
  } else if (core >= 0) {
    // One hub and nothing else to go on: split its notes into a few arms.
    const all = subtree(core);
    const n = all.length;
    const k = n < 14 ? 2 : n < 60 ? 3 : n < 200 ? 4 : 5;
    for (let j = 0; j < k; j++) {
      const part = all.slice(Math.round((j * n) / k), Math.round(((j + 1) * n) / k));
      if (part.length) segs.push({ moc: -1, members: part, name: '', id: 'arm' + j });
    }
  }

  const M = { N, ids, s, auto, core, mode: 'spiral' };
  M.pos = new Float64Array(N * 2);
  M.color = new Int32Array(N);
  M.seg = new Int32Array(N).fill(-3);      // segment number, -2 = core/bulge, -3 = halo
  M.role = new Uint8Array(N);              // 0 note, 1 MOC, 2 core
  M.rad = new Float32Array(N);             // roughly how big the node is drawn, in graph units
  M.sizeK = new Float32Array(N).fill(NODE_GAIN);
  M.sizeMin = new Float32Array(N);
  const setPos = (i, x, y) => { M.pos[i * 2] = x; M.pos[i * 2 + 1] = y; };

  if (!segs.length) {
    // Nothing is linked into a structure: fall back to one arm per top-level folder.
    const groups = new Map();
    for (let i = 0; i < N; i++) {
      if (i === core) continue;
      const id = String(ids[i]), cut = id.indexOf('/');
      const f = types[i] === 'tag' ? 'Tags' : cut > 0 ? id.slice(0, cut) : '';
      if (!groups.has(f)) groups.set(f, []);
      groups.get(f).push(i);
    }
    const byImportance = (a, b) => deg[b] - deg[a] || cmp(ids[a], ids[b]);
    if (groups.size >= 2) {
      for (const [f, list] of groups) segs.push({ moc: -1, members: list.sort(byImportance), name: f || 'Notes', id: 'folder:' + f });
    } else if (N - (core >= 0 ? 1 : 0) >= 2) {
      const all = Array.from(groups.values())[0].sort(byImportance);
      const k = all.length < 14 ? 2 : all.length < 60 ? 3 : 4;
      for (let j = 0; j < k; j++) {
        const part = all.filter((_, x) => x % k === j);
        if (part.length) segs.push({ moc: -1, members: part, name: '', id: 'arm' + j });
      }
    }
  }
  if (!segs.length) return discModel(M, G, o, deg, size, sizeMult, types, nbr, s);

  /* ---- arms: biggest groups get their own arm, spread evenly round the disc ---- */
  // Start from the order used last time, so the galaxy does not reshuffle whenever one MOC
  // gains a note; a group only overtakes its neighbour once it is clearly bigger.
  const hint = new Map((o.rank || []).map((id, i) => [id, i]));
  const bySize = (a, b) => b.members.length - a.members.length || cmp(a.name, b.name) || cmp(a.id, b.id);
  segs.sort((a, b) => {
    const ha = hint.has(a.id), hb = hint.has(b.id);
    if (ha && hb) return hint.get(a.id) - hint.get(b.id);
    if (ha !== hb) return ha ? -1 : 1;
    return bySize(a, b);
  });
  for (let pass = 0; pass < segs.length; pass++) {
    let moved = false;
    for (let i = 1; i < segs.length; i++) {
      if (segs[i].members.length > segs[i - 1].members.length * 1.25 + 2) {
        const t = segs[i]; segs[i] = segs[i - 1]; segs[i - 1] = t;
        moved = true;
      }
    }
    if (!moved) break;
  }
  M.rank = segs.map((sg) => sg.id);
  const K = Math.min(maxArms, segs.length);
  const arms = [];
  for (let k = 0; k < K; k++) arms.push({ segs: [segs[k]], total: segs[k].members.length + 1 });
  for (let k = K; k < segs.length; k++) {
    let t = arms[0];
    for (const a of arms) if (a.total < t.total) t = a;
    t.segs.push(segs[k]);
    t.total += segs[k].members.length + 2;
  }
  arms.forEach((a, i) => { a.key = vdc(i); });
  arms.sort((a, b) => a.key - b.key);

  const segList = [];
  for (const a of arms) for (const sg of a.segs) { sg.idx = segList.length; segList.push(sg); }
  // A MOC keeps the colour it was first given; new MOCs take the first colour not in use.
  const savedColors = o.colors || {};
  const usedColors = new Set();
  for (const sg of segList) {
    const c = savedColors[sg.id];
    if (Number.isInteger(c) && c >= 0) { sg.ci = c; usedColors.add(c); }
  }
  let nextColor = 0;
  for (const a of arms) {
    for (const sg of a.segs) {
      if (sg.ci === undefined) {
        while (usedColors.has(nextColor)) nextColor++;
        sg.ci = nextColor;
        usedColors.add(nextColor);
      }
      const custom = sg.moc >= 0 ? o.color(ids[sg.moc]) : null;
      sg.color = custom != null ? custom : paletteColor(sg.ci);
      if (sg.moc >= 0) { M.seg[sg.moc] = sg.idx; M.role[sg.moc] = 1; M.sizeK[sg.moc] = 1.12 * NODE_GAIN; M.sizeMin[sg.moc] = 15 * NODE_GAIN; }
      for (const m of sg.members) M.seg[m] = sg.idx;
    }
  }
  if (core >= 0) {
    let biggest = 0;
    for (const sg of segList) if (sg.moc >= 0) biggest = Math.max(biggest, size[sg.moc] * M.sizeK[sg.moc], M.sizeMin[sg.moc]);
    M.seg[core] = -2; M.role[core] = 2; M.sizeK[core] = 1.25 * NODE_GAIN;
    M.sizeMin[core] = Math.max(22 * NODE_GAIN, biggest * 1.12);
  }
  for (const i of bulge) M.seg[i] = -2;
  for (let i = 0; i < N; i++) M.rad[i] = Math.max(size[i] * M.sizeK[i], M.sizeMin[i]) * sizeMult * VIS;

  /* ---- geometry ---- */
  const pitch = (clamp((o.pitchDeg || 17) + Math.max(0, K - 6) * 1.5, 8, 34) * Math.PI) / 180;
  const b = Math.tan(pitch), cosp = Math.cos(pitch), c = 1 / Math.sin(pitch);
  const q = Math.exp((TAU * b) / K) - 1;

  // the core and the notes that hang directly off it
  if (core >= 0) setPos(core, 0, 0);
  const sb = 0.84 * s;
  const coreRad = core >= 0 ? M.rad[core] : 0;
  const first = Math.max(1.2 * s, coreRad + 0.75 * s);
  const c0 = (first / sb) * (first / sb);
  bulge.forEach((i, k) => {
    const rr = sb * Math.sqrt(k + c0), a = k * GOLDEN_ANGLE + 0.7;
    setPos(i, rr * Math.cos(a), rr * Math.sin(a));
  });
  const rb = bulge.length ? sb * Math.sqrt(bulge.length - 1 + c0) : 0;

  // radius of the ring the MOCs sit on
  let r0 = Math.max(1.75 * s, rb ? rb + 1.15 * s : 0, coreRad ? coreRad + 1.5 * s : 0);
  if (K >= 2) r0 = Math.max(r0, (0.8 * s) / Math.sin(Math.PI / K));
  r0 = Math.max(r0, (0.95 * s) / (q * cosp));

  const bandW = (r) => Math.min(0.56 * r * q * cosp, 0.4 * r);
  const theta0 = -Math.PI / 2;
  /** Point at distance L along an arm's centre line, pushed `lat` sideways. */
  const armPoint = (theta, L, lat) => {
    const r = r0 + L / c;
    const phi = theta + Math.log(r / r0) / b;
    const cf = Math.cos(phi), sf = Math.sin(phi);
    return [r * cf + (cf + b * sf) * cosp * lat, r * sf + (sf - b * cf) * cosp * lat, r, phi];
  };

  arms.forEach((arm, j) => { arm.theta = theta0 + (TAU * j) / K; });
  /** Place one arm's notes; `stretch` widens the gaps between them. Returns the arm's length. */
  const layArm = (arm, stretch) => {
    let L = 0, k = 0, last = 0;
    arm.segs.forEach((sg, si) => {
      if (sg.moc >= 0) {
        if (si > 0) L += 0.9 * s;
        sg.L0 = L;
        const p = armPoint(arm.theta, L, 0);
        setPos(sg.moc, p[0], p[1]);
        last = L;
        L += Math.max(1.2 * s, M.rad[sg.moc] + 0.85 * s);
      } else {
        sg.L0 = L;
      }
      for (const m of sg.members) {
        const r = r0 + L / c;
        const h = Math.max(0, (bandW(r) - 0.9 * s) / 2);
        const lanes = 1 + (2 * h) / (0.82 * s);
        // Neighbours along the arm sit on opposite sides of its centre line, so their names
        // (written underneath) land on different rows instead of on top of each other.
        const fr = frac(++k * GOLDEN + 0.11);
        const mag = h > 0.2 * s ? 0.3 + 0.7 * fr : 0.75 + 0.25 * fr;
        let lat = (k % 2 ? 1 : -1) * mag * Math.max(h, 0.2 * s), Lj = L;
        const wide = smooth(1.7, 3.2, lanes);
        if (wide > 0) {
          // a broad arm: scatter the notes like a star field instead of ruling them into rows
          const hs = hashStr(String(ids[m]));
          lat = lerp(lat, (2 * frac(hs / 4099) - 1) * h, wide);
          Lj = Math.max(0, L + (frac(hs / 65537 + 0.37) - 0.5) * 0.9 * s * wide);
        }
        const p = armPoint(arm.theta, Lj, lat);
        setPos(m, p[0], p[1]);
        last = L;
        L += (stretch * s) / lanes;
      }
      sg.L1 = last;
    });
    arm.Lend = last;
    arm.stretch = stretch;
    return last;
  };

  const sweepOf = (L) => Math.log((r0 + L / c) / r0) / b;
  const SWEEP_MIN = 3.6;   // the longest arm should wind at least ~205 degrees
  const STRETCH_MAX = 10;  // ...but never space notes more than this many times the normal gap
  let Lmax = 0;
  for (const arm of arms) Lmax = Math.max(Lmax, layArm(arm, 1));
  let st0 = 1;
  if (Lmax > 0 && sweepOf(Lmax) < SWEEP_MIN) {
    const want = (r0 * Math.exp(b * SWEEP_MIN) - r0) * c;
    st0 = clamp(want / Lmax, 1, 2.4);
  }
  if (st0 > 1.02) { Lmax = 0; for (const arm of arms) Lmax = Math.max(Lmax, layArm(arm, st0)); }
  // Smaller groups are spread out along their arm, so every arm reaches towards the rim
  // and its name (written at the tip) sits right beside its last note.
  for (const arm of arms) {
    let st = st0;
    for (let it = 0; it < 3; it++) {
      if (arm.Lend >= Lmax * 0.97 || arm.Lend <= 0) break;
      const next = Math.min(STRETCH_MAX, st * (Lmax / arm.Lend));
      if (next <= st * 1.01) break;
      st = next;
      layArm(arm, st);
    }
  }
  const sweepNotes = sweepOf(Lmax);
  const sweepHaze = Math.max(sweepNotes + 0.22, 3.5);
  const Rout = r0 * Math.exp(b * sweepHaze);
  const Lout = (Rout - r0) * c;

  /* ---- nudge apart anything that still overlaps ---- */
  const fixed = new Uint8Array(N);
  if (core >= 0) fixed[core] = 1;
  for (const sg of segList) if (sg.moc >= 0) fixed[sg.moc] = 1;
  const placedList = [];
  for (let i = 0; i < N; i++) if (M.seg[i] !== -3) placedList.push(i);
  relax(M.pos, M.rad, fixed, placedList, s);
  // Names are written under the notes. Notes that sit level with a close neighbour are nudged up
  // or down so that each name gets a row of its own.
  const box = o.names === false ? null : nameBoxes(M, G, o);
  const em = NAME.em * s;
  if (box) {
    const home = homeRows(M.pos, N);
    for (let round = 0; round < 5; round++) {
      if (!spreadNames(M.pos, box, fixed, placedList, em, 0.6 * s, home)) break;
      relax(M.pos, M.rad, fixed, placedList, s);
    }
  }
  // broad arms can reach a little past the nominal rim; the halo and the fit must clear them
  let rimNotes = 0;
  for (const i of placedList) rimNotes = Math.max(rimNotes, Math.hypot(M.pos[i * 2], M.pos[i * 2 + 1]));

  /* ---- halo: everything that is linked to nothing in the galaxy ---- */
  const comps = [];
  {
    const mark = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
      if (M.seg[i] !== -3 || mark[i]) continue;
      const comp = [i];
      mark[i] = 1;
      for (let h = 0; h < comp.length; h++) {
        for (const v of nbr[comp[h]]) if (!mark[v] && M.seg[v] === -3) { mark[v] = 1; comp.push(v); }
      }
      comps.push(comp);
    }
    comps.sort((a, b) => b.length - a.length || cmp(ids[a[0]], ids[b[0]]));
  }
  let haloN = 0, haloOuter = 0;
  if (comps.length) {
    // The rim is divided into one stretch between each pair of arm names. Linked notes stay
    // side by side, and the groups are shared out evenly round the galaxy.
    const sectors = [];
    for (let j = 0; j < K; j++) sectors.push([]);
    const load = new Int32Array(K);
    for (const comp of comps) {
      let j = 0;
      for (let t = 1; t < K; t++) if (load[t] < load[j]) j = t;
      for (const i of comp) sectors[j].push(i);
      load[j] += comp.length + 1;
      haloN += comp.length;
    }
    const tip0 = theta0 + sweepHaze, step = 1.2 * s;
    let longest = 0;
    for (const arm of arms) longest = Math.max(longest, arm.segs.map((sg) => sg.name).join(' · ').length);
    const labelHalf = o.labels ? Math.min(longest, 30) * 0.37 * 0.045 * Rout + 0.9 * s : 0;
    sectors.forEach((list, j) => {
      let ring = Math.max(Rout + 0.6 * s, rimNotes + 0.85 * s), idx = 0;
      while (idx < list.length) {
        const win = o.labels ? clamp(labelHalf / ring, 0.12, (Math.PI / K) * 0.72) : 0;
        const arc = TAU / K - 2 * win;
        const n = Math.min(Math.max(1, Math.floor((arc * ring) / step)), list.length - idx);
        const from = tip0 + (TAU * j) / K + win + (arc - ((n - 1) * step) / ring) / 2;
        for (let k = 0; k < n; k++) {
          const i = list[idx++];
          const rr = ring + (frac(hashStr(String(ids[i])) / 977) - 0.5) * 0.5 * s;
          const ang = from + (k * step) / ring;
          setPos(i, rr * Math.cos(ang), rr * Math.sin(ang));
        }
        if (ring > haloOuter) haloOuter = ring;
        ring += 1.3 * s;
      }
    });
  }

  let haloFar = 0;
  if (haloN) {
    if (box) {
      // the unlinked notes round the rim get rows of their own too; everything else stays put
      const still = new Uint8Array(N), everyone = [];
      for (let i = 0; i < N; i++) { everyone.push(i); if (M.seg[i] !== -3) still[i] = 1; }
      spreadNames(M.pos, box, still, everyone, em, 0.4 * s, homeRows(M.pos, N));
    }
    for (let i = 0; i < N; i++) if (M.seg[i] === -3) haloFar = Math.max(haloFar, Math.hypot(M.pos[i * 2], M.pos[i * 2 + 1]));
  }
  M.room = box ? nameRoom(M.pos, box, em) : null;

  /* ---- colours ---- */
  for (let i = 0; i < N; i++) {
    const t = types[i];
    const si = M.seg[i];
    let col;
    if (i === core) col = COL.core;
    else if (si >= 0) {
      const base = segList[si].color;
      if (M.role[i] === 1) col = mixRgb(base, COL.white, 0.42);
      else if (t === 'unresolved') col = mixRgb(base, COL.bg, 0.3);
      else if (t === 'attachment') col = mixRgb(base, COL.grey, 0.4);
      else if (t === 'tag') col = mixRgb(base, COL.white, 0.3);
      else col = mixRgb(base, COL.bg, clamp((depth[i] - 1) * 0.1, 0, 0.3));
    } else if (si === -2) col = t === 'unresolved' ? mixRgb(COL.bulge, COL.bg, 0.3) : COL.bulge;
    else col = t === 'unresolved' ? mixRgb(COL.halo, COL.bg, 0.3) : COL.halo;
    M.color[i] = col;
  }

  /* ---- what the painter, labels and legend need ---- */
  M.arms = arms;
  M.segs = segList;
  M.geo = { r0, b, c, q, cosp, K, theta0, sweepHaze, Rout, Lout, Rnotes: r0 + Lmax / c };
  M.bandW = bandW;
  M.armPoint = armPoint;
  M.bulgeN = bulge.length;
  M.haloN = haloN;
  M.Rfit = Math.max(Rout + 0.35 * s, rimNotes + 0.5 * s, haloN ? Math.max(haloOuter + 0.6 * s, haloFar + 0.35 * s) : 0);
  // The glow picture must reach past the widest part of the arms, or its edge would show.
  const reach = Rout + 1.25 * (0.5 * bandW(Rout) + 0.62 * s) + 0.2 * s;
  M.extent = Math.min(Math.max(reach, haloN ? haloOuter + 0.9 * s : 0), reach * 1.7) / 0.92;
  M.tips = arms.map((arm) => {
    const p = armPoint(arm.theta, Lout, 0);
    return {
      x: p[0], y: p[1], ux: Math.cos(p[3]), uy: Math.sin(p[3]),
      text: arm.segs.map((sg) => sg.name).filter(Boolean).join(' · '),
      color: arm.segs[arm.segs.length - 1].color,
    };
  });
  M.legend = segList
    .filter((sg) => sg.name)
    .map((sg) => ({ seg: sg.idx, name: sg.name, color: sg.color, count: sg.members.length }))
    .sort((a, b) => b.count - a.count || cmp(a.name, b.name));
  if (haloN) M.legend.push({ seg: -3, name: 'Unlinked', color: COL.halo, count: haloN });
  return M;
}

/** Fallback when the vault has no MOCs and no hubs: one big sunflower disc, coloured by folder. */
function discModel(M, G, o, deg, size, sizeMult, types, nbr, s) {
  const N = M.N, ids = M.ids;
  M.mode = 'disc';
  const order = [];
  for (let i = 0; i < N; i++) order.push(i);
  const folder = (id) => { const k = String(id).indexOf('/'); return k > 0 ? String(id).slice(0, k) : ''; };
  order.sort((a, b) => deg[b] - deg[a] || cmp(ids[a], ids[b]));
  const folders = Array.from(new Set(ids.map(folder))).sort();
  const sp = 0.92 * s;
  let R = 0;
  order.forEach((i, k) => {
    const rr = sp * Math.sqrt(k + 0.6), a = k * GOLDEN_ANGLE;
    M.pos[i * 2] = rr * Math.cos(a);
    M.pos[i * 2 + 1] = rr * Math.sin(a);
    R = rr;
    const base = paletteColor(folders.indexOf(folder(ids[i])));
    M.color[i] = types[i] === 'unresolved' ? mixRgb(base, COL.bg, 0.55) : base;
    M.seg[i] = -2;
    M.rad[i] = size[i] * NODE_GAIN * sizeMult * VIS;
  });
  M.room = null;
  if (o.names !== false && N > 1) {
    const box = nameBoxes(M, G, o), none = new Uint8Array(N), em = NAME.em * s, home = homeRows(M.pos, N);
    for (let round = 0; round < 5; round++) {
      if (!spreadNames(M.pos, box, none, order, em, 0.6 * s, home)) break;
      relax(M.pos, M.rad, none, order, s);
    }
    M.room = nameRoom(M.pos, box, em);
    R = 0;
    for (let i = 0; i < N; i++) R = Math.max(R, Math.hypot(M.pos[i * 2], M.pos[i * 2 + 1]));
  }
  M.arms = [];
  M.segs = [];
  M.geo = { r0: Math.max(s, R * 0.25), K: 0, Rout: R + s, Lout: 0, sweepHaze: 0 };
  M.bulgeN = N;
  M.haloN = 0;
  M.Rfit = R + 1.2 * s;
  M.extent = (M.Rfit + 0.6 * s) / 0.92;
  M.tips = [];
  M.legend = [];
  return M;
}

/** Push apart nodes that sit too close; fixed nodes (MOCs, core) never move. */
function relax(pos, rad, fixed, list, s) {
  const n = list.length;
  if (n < 2) return;
  const base = 0.74 * s, pad = 0.2 * s;
  let maxRad = 0;
  for (const i of list) if (rad[i] > maxRad) maxRad = rad[i];
  const cell = Math.max(base, 2 * maxRad + pad);
  const anchor = new Float64Array(n * 2);
  list.forEach((i, k) => { anchor[k * 2] = pos[i * 2]; anchor[k * 2 + 1] = pos[i * 2 + 1]; });
  for (let it = 0; it < 8; it++) {
    const grid = new Map();
    for (let k = 0; k < n; k++) {
      const i = list[k];
      const key = Math.floor(pos[i * 2] / cell) * 73856093 ^ Math.floor(pos[i * 2 + 1] / cell) * 19349663;
      const bucket = grid.get(key);
      if (bucket) bucket.push(i); else grid.set(key, [i]);
    }
    let moved = false;
    for (let k = 0; k < n; k++) {
      const i = list[k];
      const gx = Math.floor(pos[i * 2] / cell), gy = Math.floor(pos[i * 2 + 1] / cell);
      for (let ax = -1; ax <= 1; ax++) {
        for (let ay = -1; ay <= 1; ay++) {
          const bucket = grid.get((gx + ax) * 73856093 ^ (gy + ay) * 19349663);
          if (!bucket) continue;
          for (const j of bucket) {
            if (j <= i) continue;
            let dx = pos[j * 2] - pos[i * 2], dy = pos[j * 2 + 1] - pos[i * 2 + 1];
            const need = Math.max(base, rad[i] + rad[j] + pad);
            let d2 = dx * dx + dy * dy;
            if (d2 >= need * need) continue;
            let d = Math.sqrt(d2);
            if (d < 1e-6) { const a = ((i * 7919 + j * 104729) % 628) / 100; dx = Math.cos(a); dy = Math.sin(a); d = 1; }
            const push = (need - d) * 0.5;
            const ux = dx / d, uy = dy / d;
            const fi = fixed[i], fj = fixed[j];
            if (fi && fj) continue;
            const wi = fi ? 0 : fj ? 2 : 1, wj = fj ? 0 : fi ? 2 : 1;
            pos[i * 2] -= ux * push * wi; pos[i * 2 + 1] -= uy * push * wi;
            pos[j * 2] += ux * push * wj; pos[j * 2 + 1] += uy * push * wj;
            moved = true;
          }
        }
      }
    }
    if (!moved) break;
    if (it < 5) {
      for (let k = 0; k < n; k++) {
        const i = list[k];
        if (fixed[i]) continue;
        pos[i * 2] += (anchor[k * 2] - pos[i * 2]) * 0.05;
        pos[i * 2 + 1] += (anchor[k * 2 + 1] - pos[i * 2 + 1]) * 0.05;
      }
    }
  }
}

/* ---- room for names ---- */

const NARROW = "iljtfrI.,:;'!|()[]-";

/** Rough width and height of a note's name in ems, with a little air round it. Obsidian wraps long names. */
function nameEms(text) {
  const t = String(text == null ? '' : text);
  let w = 0;
  for (let k = 0; k < t.length; k++) {
    const c = t.charCodeAt(k);
    if (c >= 0x2e80) w += 1;                                                        // full-width scripts
    else if (c === 32) w += 0.28;
    else if (c === 77 || c === 87 || c === 109 || c === 119 || c === 64) w += 0.86; // M W m w @
    else if (c >= 65 && c <= 90) w += 0.67;                                         // capitals
    else if (c >= 48 && c <= 57) w += 0.6;                                          // digits
    else if (NARROW.indexOf(t[k]) >= 0) w += 0.31;
    else w += 0.55;
  }
  w *= 1.03;
  const lines = Math.max(1, Math.ceil(w / 20));
  // the drawing library sets lines 1.57 ems apart, and a little air is left above the next name
  return [Math.min(w, 21) + 0.8, 1.57 * lines + 0.05];
}

/** For every note: the width and height of its name in ems, and how far below the note's middle it is written. */
function nameBoxes(M, G, o) {
  const N = M.N, w = new Float32Array(N), h = new Float32Array(N), top = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const e = nameEms((G.texts && G.texts[i]) || o.name(M.ids[i]));
    w[i] = e[0];
    h[i] = e[1];
    top[i] = M.rad[i] / VIS;
  }
  let wmax = 1, hmax = 1, deep = 0;
  for (let i = 0; i < N; i++) { if (w[i] > wmax) wmax = w[i]; if (h[i] > hmax) hmax = h[i]; if (top[i] > deep) deep = top[i]; }
  return { w, h, top, tall: hmax, deep, reach: Math.max(wmax, hmax) };
}

/**
 * Calls fn(i, j) once for every pair of listed notes whose names could touch at a letter size of
 * `em`, allowing for either note to move up or down by `slack`.
 */
function namePairs(pos, box, list, em, slack, fn) {
  const cell = em * box.reach + 2 * slack + 1;
  const grid = new Map();
  for (const i of list) {
    const key = Math.floor(pos[i * 2] / cell) * 73856093 ^ Math.floor((pos[i * 2 + 1] + box.top[i]) / cell) * 19349663;
    const bucket = grid.get(key);
    if (bucket) bucket.push(i); else grid.set(key, [i]);
  }
  const seen = new Int32Array(9);
  for (const i of list) {
    const gx = Math.floor(pos[i * 2] / cell), gy = Math.floor((pos[i * 2 + 1] + box.top[i]) / cell);
    let ns = 0;
    for (let ax = -1; ax <= 1; ax++) {
      for (let ay = -1; ay <= 1; ay++) {
        const key = (gx + ax) * 73856093 ^ (gy + ay) * 19349663;
        let dup = false;
        for (let k = 0; k < ns; k++) if (seen[k] === key) { dup = true; break; }
        if (dup) continue;
        seen[ns++] = key;
        const bucket = grid.get(key);
        if (!bucket) continue;
        for (const j of bucket) if (j > i) fn(i, j);
      }
    }
  }
}

// How far (in note radii) a name is kept above the middle of the star beneath it.
const STAR = 1.6;

/** The height every note starts at, before any nudging. */
function homeRows(pos, N) {
  const home = new Float64Array(N);
  for (let i = 0; i < N; i++) home[i] = pos[i * 2 + 1];
  return home;
}

/**
 * Two names run into each other when their notes are nearly level and close side by side. Such notes
 * are nudged up and down (never more than `limit` from `home`) until each name has a row of its own.
 * Returns true if anything moved.
 */
function spreadNames(pos, box, fixed, list, em, limit, home) {
  if (list.length < 2) return false;
  const { w, h, top } = box;
  // Notes only move up and down here, so the pairs that sit close enough side by side are found once.
  const pairs = [], side = [];
  const tall = em * box.tall + STAR * box.deep + 4 + 2 * limit;
  namePairs(pos, box, list, em, limit + STAR * box.deep, (i, j) => {
    if (fixed[i] && fixed[j]) return;
    const dx = Math.abs(pos[j * 2] - pos[i * 2]);
    if (dx >= (em * (w[i] + w[j])) / 2) return;
    if (Math.abs(pos[j * 2 + 1] + top[j] - pos[i * 2 + 1] - top[i]) >= tall) return;
    pairs.push(i, j);
    side.push(dx);
  });
  if (!pairs.length) return false;
  const movers = Array.from(new Set(pairs)).filter((i) => !fixed[i]);
  let any = false;
  for (let it = 0; it < 40; it++) {
    let moved = false;
    for (let p = 0; p < pairs.length; p += 2) {
      const i = pairs[p], j = pairs[p + 1];
      const dy = pos[j * 2 + 1] + top[j] - (pos[i * 2 + 1] + top[i]); // j's name starts this far below i's
      const up = dy >= 0 ? i : j, low = dy >= 0 ? j : i;
      let need = em * h[up];
      // the upper name should not run across the star of the note below it either
      if (side[p >> 1] < (em * w[up]) / 2 + top[low]) need += STAR * top[low] + 4;
      const gap = need - Math.abs(dy);
      if (gap <= 0.01 * em) continue;                                 // already on rows of their own
      const dir = dy >= 0 ? 1 : -1, push = gap * 0.5 + 0.01 * em;
      const fi = fixed[i], fj = fixed[j];
      const wi = fi ? 0 : fj ? 2 : 1, wj = fj ? 0 : fi ? 2 : 1;
      pos[i * 2 + 1] -= dir * push * wi;
      pos[j * 2 + 1] += dir * push * wj;
      moved = true;
    }
    if (!moved) break;
    any = true;
    for (const i of movers) pos[i * 2 + 1] = clamp(pos[i * 2 + 1], home[i] - limit, home[i] + limit);
  }
  return any;
}

/**
 * How much room each note's name has: the largest letter size (in graph units) at which it touches
 * no neighbour's name. Never more than `em`, the size the galaxy is laid out for.
 */
function nameRoom(pos, box, em) {
  const { w, h, top } = box;
  const N = w.length, room = new Float32Array(N).fill(em), all = [];
  for (let i = 0; i < N; i++) all.push(i);
  namePairs(pos, box, all, em, 0, (i, j) => {
    const dx = Math.abs(pos[j * 2] - pos[i * 2]);
    const dy = pos[j * 2 + 1] + top[j] - (pos[i * 2 + 1] + top[i]);
    const q = Math.max(Math.abs(dy) / (dy >= 0 ? h[i] : h[j]), (2 * dx) / (w[i] + w[j]));
    if (q < room[i]) room[i] = q;
    if (q < room[j]) room[j] = q;
  });
  return room;
}

function modelDigest(M) {
  let h = M.N | 0;
  for (let i = 0; i < M.N; i++) {
    h = (Math.imul(h, 31) + Math.round(M.pos[i * 2] * 4)) | 0;
    h = (Math.imul(h, 31) + Math.round(M.pos[i * 2 + 1] * 4)) | 0;
    h = (Math.imul(h, 31) + M.color[i]) | 0;
  }
  for (const sg of M.segs) h = (Math.imul(h, 31) + hashStr(sg.name + sg.color + ':' + sg.members.length)) | 0;
  return h + ':' + Math.round(M.Rfit) + ':' + M.mode;
}

/* ------------------------------------------------------------------ */
/* Painting the glow: one static picture of the whole galaxy           */
/* ------------------------------------------------------------------ */

function makeStamp(doc, color) {
  const S = 64;
  const cv = doc.createElement('canvas');
  cv.width = cv.height = S;
  const c = cv.getContext('2d');
  const g = c.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  const stops = [[0, 1], [0.12, 0.86], [0.28, 0.58], [0.45, 0.33], [0.62, 0.16], [0.8, 0.05], [1, 0]];
  for (const [t, a] of stops) g.addColorStop(t, cssRgba(color, a));
  c.fillStyle = g;
  c.fillRect(0, 0, S, S);
  return cv;
}

/**
 * Draws the soft light of the galaxy (arms, core, dust, a halo round each
 * note) into a canvas. `T` is the canvas size in pixels.
 */
function paintHaze(M, T, doc) {
  const cv = doc.createElement('canvas');
  cv.width = cv.height = T;
  const ctx = cv.getContext('2d');
  if (!ctx) return null;
  const E = M.extent, k = T / (2 * E);
  const stamps = new Map();
  const stamp = (color) => {
    let st = stamps.get(color);
    if (!st) stamps.set(color, (st = makeStamp(doc, color)));
    return st;
  };
  ctx.globalCompositeOperation = 'lighter';
  /** One soft dot: world position, world radius, colour, strength. */
  const dab = (x, y, rad, color, alpha) => {
    if (!(alpha > 0.004) || !(rad > 0)) return;
    const R = rad * k;
    ctx.globalAlpha = alpha > 1 ? 1 : alpha;
    ctx.drawImage(stamp(color), (x + E) * k - R, (y + E) * k - R, 2 * R, 2 * R);
  };
  const g = M.geo, s = M.s;
  let rand = rng(0x9e3779b9);

  /* disc and core */
  dab(0, 0, g.Rout * 1.08, 0x3b4698, 0.1);
  dab(0, 0, g.Rout * 0.62, 0x4a4fa8, 0.08);
  dab(0, 0, g.r0 * 1.5, 0xffcf96, 0.2);
  dab(0, 0, g.r0 * 0.95, 0xffe2b8, 0.26);
  dab(0, 0, g.r0 * 0.45, 0xfff6e6, 0.3);

  if (M.mode === 'spiral') {
    /* the arms */
    M.arms.forEach((arm) => {
      rand = rng(hashStr('arm:' + arm.segs[0].id)); // each arm keeps its own pattern, whatever else changes
      const ph1 = rand() * TAU, ph2 = rand() * TAU, ph3 = rand() * TAU;
      const colorAt = (L) => {
        const sg = arm.segs;
        let col = sg[0].color;
        for (let i = 1; i < sg.length; i++) {
          const t = smooth(sg[i].L0 - 1.6 * s, sg[i].L0 + 0.4 * s, L);
          if (t > 0) col = t >= 1 ? sg[i].color : mixRgb(col, sg[i].color, t);
        }
        return col;
      };
      const Lstart = -0.2 * g.r0 * g.c;
      let L = Lstart;
      while (L < g.Lout) {
        const r = g.r0 + L / g.c;
        const half = 0.5 * M.bandW(r) + 0.62 * s;
        const dL = Math.max(3 / k, 0.3 * half);
        const fadeIn = smooth(0.8 * g.r0, 1.08 * g.r0, r);
        const tip = 1 - smooth(0.84, 1, L / g.Lout);
        const past = L - arm.Lend - 1.2 * s;
        const filled = past <= 0 ? 1 : lerp(1, 0.5, smooth(0, 3 * s, past));
        const n1 = 0.5 + 0.5 * Math.sin(L / (2.6 * s) + ph1) * Math.sin(L / (6.1 * s) + ph2);
        const n2 = Math.sin(L / (3.7 * s) + ph3);
        const a = 0.2 * fadeIn * tip * filled * (0.62 + 0.6 * n1);
        const p = M.armPoint(arm.theta, L, n2 * 0.22 * half);
        const col = colorAt(L);
        const per = (a * dL) / (0.9 * half);
        dab(p[0], p[1], half * 1.25, col, per);
        dab(p[0], p[1], half * 0.55, mixRgb(col, COL.white, 0.3), per * 0.9);
        L += dL;
      }
      /* dust: small soft stars scattered along the arm */
      const count = Math.round(clamp((g.Lout / s) * 7, 60, 900));
      for (let i = 0; i < count; i++) {
        const u = Math.pow(rand(), 0.9);
        const Ld = lerp(-0.1 * g.r0 * g.c, g.Lout * 0.97, u);
        const r = g.r0 + Ld / g.c;
        const half = 0.5 * M.bandW(r) + 0.6 * s;
        const gauss = (rand() + rand() + rand() - 1.5) / 1.5;
        const p = M.armPoint(arm.theta, Ld, gauss * half * 1.1);
        const past = Ld - arm.Lend - 1.2 * s;
        const filled = past <= 0 ? 1 : lerp(1, 0.45, smooth(0, 3 * s, past));
        const tip = 1 - smooth(0.86, 1, Ld / g.Lout);
        const b = rand();
        const col = mixRgb(colorAt(Ld), COL.white, b < 0.5 ? 0.35 : 0.7);
        dab(p[0], p[1], (1.6 + 3.2 * b * b * b) / k, col, (0.12 + 0.5 * rand() * rand()) * filled * tip);
      }
    });
  }

  /* warm dust in the core, and a thin scatter of field stars across the disc */
  rand = rng(0x51ed270b);
  const coreDust = Math.round(clamp(g.r0 * 0.5, 40, 220));
  for (let i = 0; i < coreDust; i++) {
    const rr = g.r0 * 0.9 * Math.sqrt(-Math.log(1 - rand() * 0.95)) * 0.6, a = rand() * TAU;
    dab(rr * Math.cos(a), rr * Math.sin(a), (1.5 + 2.4 * rand()) / k, rand() < 0.5 ? 0xfff0d2 : 0xffd9a8, 0.1 + 0.35 * rand() * rand());
  }
  const field = Math.round(clamp(g.Rout / 5, 80, 420));
  for (let i = 0; i < field; i++) {
    const rr = E * 0.98 * Math.sqrt(rand()), a = rand() * TAU;
    dab(rr * Math.cos(a), rr * Math.sin(a), (1.3 + 2 * rand()) / k, rand() < 0.6 ? 0xcfd6ff : 0xfff1dd, 0.06 + 0.22 * rand() * rand());
  }

  /* a soft halo of light round every note, so the notes read as stars */
  for (let i = 0; i < M.N; i++) {
    const x = M.pos[i * 2], y = M.pos[i * 2 + 1];
    if (Math.abs(x) > E || Math.abs(y) > E) continue;
    const si = M.seg[i], role = M.role[i];
    const col = role === 2 ? COL.core : si >= 0 ? M.segs[si].color : si === -2 ? COL.bulge : COL.halo;
    const r = M.rad[i];
    if (role === 2) { dab(x, y, r * 6.5, col, 0.26); dab(x, y, r * 3.2, COL.white, 0.3); }
    else if (role === 1) { dab(x, y, r * 5.2, col, 0.26); dab(x, y, r * 2.6, mixRgb(col, COL.white, 0.5), 0.3); }
    else dab(x, y, r * 3.6, col, si === -3 ? 0.1 : 0.2);
  }
  /* fade everything out towards the border so the picture can never show a hard edge */
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'destination-in';
  const mask = ctx.createRadialGradient(T / 2, T / 2, 0, T / 2, T / 2, T / 2);
  mask.addColorStop(0, 'rgba(0,0,0,1)');
  mask.addColorStop(0.9, 'rgba(0,0,0,1)');
  mask.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = mask;
  ctx.fillRect(0, 0, T, T);
  ctx.globalCompositeOperation = 'source-over';
  return cv;
}

/* ------------------------------------------------------------------ */
/* Talking to Obsidian's graph view                                    */
/* ------------------------------------------------------------------ */

/** Find the drawing library Obsidian uses for the graph. */
function pixiOf(r) {
  try {
    const el = r.containerEl;
    const win = (el && el.ownerDocument && el.ownerDocument.defaultView) || window;
    const P = win.PIXI || window.PIXI;
    if (P && P.Sprite && P.Texture && typeof P.Texture.from === 'function') return P;
    // Fall back to the classes of objects Obsidian has already made.
    const res = {};
    const link = (r.links || []).find((l) => l && l.line && l.line.texture);
    const node = (r.nodes || []).find((n) => n && n.text && n.text.texture);
    if (link) { res.Sprite = link.line.constructor; res.Texture = link.line.texture.constructor; }
    if (node) {
      res.Text = node.text.constructor;
      if (!res.Sprite) { res.Sprite = Object.getPrototypeOf(res.Text); res.Texture = node.text.texture.constructor; }
    }
    if (res.Sprite && res.Texture && typeof res.Texture.from === 'function') return res;
  } catch (e) { /* fall through */ }
  return null;
}

/** True once PixiJS has destroyed a display object (or its texture). */
function pixiGone(o) {
  if (!o || o._destroyed === true || o.destroyed === true) return true;
  const tex = o.texture;
  return tex === null || (!!tex && (tex.destroyed === true || tex.baseTexture === null));
}

/** Size of the drawing surface in the units Obsidian pans and zooms in. */
function screenOf(r) {
  try {
    const scr = r.px && r.px.renderer && r.px.renderer.screen;
    if (scr && scr.width > 20 && scr.height > 20) {
      const view = r.px.view;
      const cssW = (view && view.clientWidth) || r.width || scr.width;
      return { w: scr.width, h: scr.height, cssPer: cssW / scr.width };
    }
  } catch (e) { /* fall through */ }
  const dpr = window.devicePixelRatio || 1;
  if (r.width > 20 && r.height > 20) return { w: r.width * dpr, h: r.height * dpr, cssPer: 1 / dpr };
  return null;
}

function graphSignature(r) {
  const nodes = r.nodes, links = r.links || [];
  let h = Math.imul(nodes.length, 73856093) ^ Math.imul(links.length, 19349663);
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    let nh = n.__gxh;
    if (nh === undefined || n.__gxt !== n.type) {
      nh = hashStr(n.id + '\u0000' + (n.type || ''));
      n.__gxh = nh;
      n.__gxt = n.type;
    }
    h = (Math.imul(h, 31) + nh) | 0;
  }
  for (let i = 0; i < links.length; i++) {
    const l = links[i];
    const a = l.source ? l.source.__gxh | 0 : 0, b = l.target ? l.target.__gxh | 0 : 0;
    h = (Math.imul(h, 31) + Math.imul(a, 7) + b) | 0;
  }
  return h;
}

function extractGraph(r) {
  const nodes = r.nodes.slice();
  const index = new Map();
  const ids = [], types = [], weights = [], texts = [];
  nodes.forEach((n, i) => {
    index.set(n.id, i);
    ids.push(n.id);
    types.push(n.type || '');
    weights.push(typeof n.weight === 'number' ? n.weight : NaN);
    let text = null; // the name exactly as Obsidian writes it under the note
    try { if (typeof n.getDisplayText === 'function') text = n.getDisplayText(); } catch (e) { /* use the file name */ }
    texts.push(typeof text === 'string' && text ? text : null);
  });
  const edges = [];
  if (Array.isArray(r.links) && r.links.length) {
    for (const l of r.links) {
      const a = l.source ? index.get(l.source.id) : undefined;
      const b = l.target ? index.get(l.target.id) : undefined;
      if (a !== undefined && b !== undefined) edges.push(a, b);
    }
  } else {
    nodes.forEach((n, a) => {
      if (!n.forward) return;
      for (const t in n.forward) { const b = index.get(t); if (b !== undefined) edges.push(a, b); }
    });
  }
  return { nodes, ids, types, weights, texts, edges, index };
}

const reducedMotion = () => {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; }
};

/* ---- wrappers placed on Obsidian's graph node class ---- */

function wrapFill(orig) {
  return function () {
    const o = orig.apply(this, arguments);
    const g = this.__gx;
    if (!g || !o || this.type === 'focused') return o;
    const r = this.renderer;
    let hl = null;
    try { hl = r && (typeof r.getHighlightNode === 'function' ? r.getHighlightNode() : r.highlightNode); } catch (e) { /* ignore */ }
    if (hl === this) return o; // keep Obsidian's own colour for the note under the pointer
    const c = g.c;
    c.rgb = g.rgb;
    c.a = (typeof o.a === 'number' ? o.a : 1) * g.fade;
    return c;
  };
}

function wrapSize(orig) {
  return function () {
    const v = orig.apply(this, arguments);
    const g = this.__gx;
    if (!g || !(g.k > 0) || g.k === 1) return v;
    const m = (this.renderer && this.renderer.fNodeSizeMult) || 1;
    return Math.max(v * g.k, g.min * m);
  };
}

function wrapRender(orig) {
  return function () {
    const g = this.__gx, r = this.renderer;
    const ctl = g && g.ctl;
    if (!ctl || !r || typeof r.textAlpha !== 'number') return orig.apply(this, arguments);
    const f = ctl.nameAlpha(g, r);
    let res;
    if (f >= 1) res = orig.apply(this, arguments);
    else {
      const saved = r.textAlpha;
      r.textAlpha = saved * f; // a name stays hidden until there is room for it and it is big enough to read
      try { res = orig.apply(this, arguments); } finally { r.textAlpha = saved; }
    }
    try {
      const t = this.text;
      if (t && t.scale) {
        if (t.style !== g.styled) edgeText(g, t, r); // a new name, or Obsidian has given it a new style
        if (ctl.namesOn && t.visible !== false) {
          const sx = t.scale.x;
          if (sx !== g.ts) {
            // Obsidian has just set the name's size: adjust it once. A size this plugin wrote is never
            // adjusted again, so the effect cannot build up from one frame to the next.
            let hl = null;
            try { hl = typeof r.getHighlightNode === 'function' ? r.getHighlightNode() : r.highlightNode; } catch (e) { /* ignore */ }
            const k = ctl.labelGain(r, t, sx, g, hl === this);
            g.ts0 = sx;
            g.ts = sx * k;
            if (k !== 1) t.scale.set(g.ts);
          }
        }
      }
    } catch (e) { /* the name stays as Obsidian drew it */ }
    return res;
  };
}

/** Give a note's name a thin dark edge so it stays readable over the glow. Runs once per label style. */
function edgeText(g, t, r) {
  const s = t.style;
  g.styled = s; // remembered, so this runs when the style object changes and not on every frame
  if (!s || typeof s !== 'object') return;
  const fs = typeof s.fontSize === 'number' ? s.fontSize : parseFloat(s.fontSize);
  g.fpx = fs > 0 ? fs : 14;
  if (!g.ctl || !g.ctl.namesOn) return;
  // a dark edge suits light names; dark names on a light theme are left alone
  const c = r.colors && r.colors.text;
  const rgb = c && typeof c.rgb === 'number' ? c.rgb : 0xdcdff5;
  if (0.299 * ((rgb >> 16) & 255) + 0.587 * ((rgb >> 8) & 255) + 0.114 * (rgb & 255) < 150) return;
  try {
    if (!s.__gx0) s.__gx0 = [s.stroke, s.strokeThickness, s.lineJoin];
    s.stroke = NAME.edge;
    s.strokeThickness = NAME.edgeWidth;
    s.lineJoin = 'round';
  } catch (e) { /* leave the name as Obsidian drew it */ }
}

/** Put a note's name back exactly as Obsidian drew it. */
function plainText(n) {
  const g = n.__gx, t = n.text;
  if (!g) return;
  try {
    if (t && !pixiGone(t)) {
      const s = t.style, o = s && s.__gx0;
      if (o) { s.stroke = o[0]; s.strokeThickness = o[1]; s.lineJoin = o[2]; delete s.__gx0; }
      if (g.ts !== undefined && g.ts0 > 0 && t.scale && t.scale.x === g.ts) t.scale.set(g.ts0);
    }
  } catch (e) { /* ignore */ }
  g.styled = null;
  g.ts = undefined;
}

/* ---- wrapper placed on Obsidian's graph link class ---- */

const LINK = { same: 1.3, hub: 0.25, off: 0.3 };

function wrapLinkRender(orig) {
  return function () {
    const res = orig.apply(this, arguments);
    const g = this.__gx, line = this.line;
    if (!g || !line) return res;
    const r = this.renderer;
    let hl = null;
    try { hl = r && (typeof r.getHighlightNode === 'function' ? r.getHighlightNode() : r.highlightNode); } catch (e) { /* ignore */ }
    if (hl && (hl === this.source || hl === this.target)) { g.last = NaN; return res; } // leave highlighted links to Obsidian
    if (g.rgb >= 0) line.tint = g.rgb;
    // Only scale a value Obsidian has just written, so the effect can never build up frame after frame.
    if (line.alpha !== g.last) g.last = line.alpha = Math.min(1, line.alpha * g.dim);
    return res;
  };
}

/* ------------------------------------------------------------------ */
/* One controller per open graph view                                  */
/* ------------------------------------------------------------------ */

class GraphController {
  constructor(plugin, view) {
    this.plugin = plugin;
    this.view = view;
    this.isGlobal = view.getViewType() === 'graph';
    this.sig = null;
    this.digest = null;
    this.model = null;
    this.layoutOn = false;
    this.pinned = false;
    this.broken = false;
    this.strikes = 0;
    this.errors = 0;
    this.metaSeen = -1;
    this.mocSig = 0;
    this.anim = null;
    this.sprite = null;
    this.spriteFor = null;
    this.labels = [];
    this.labelsFor = null;
    this.legendEl = null;
    this.legendFor = null;
    this.fit = null;
    this.needFit = false;
    this.spot = null;
    this.seenRenderer = null;
    this.sceneOff = false;      // set if the glow or arm names cannot be drawn in this Obsidian
    this.sceneFails = 0;
    this.remakes = [];          // times the glow had to be rebuilt without the galaxy changing
    this.lastError = '';
    this.userInput = 0;
    this.inputEl = null;
    this.onInput = () => { this.userInput = Date.now(); };
    this.namesOn = false;       // note names get their dark edge and readable size in this view
    this.cssPer = 1;            // CSS pixels per screen unit (0.5 on an iPad)
    this._naS = NaN;
    this._naOwn = 1;
    this._lgS = NaN;
    this._lgP = null;
    this._lgK = 1;
  }

  get renderer() { return this.view.renderer; }

  tick() {
    const p = this.plugin, r = this.renderer;
    if (!r || !Array.isArray(r.nodes)) return;
    if (r !== this.seenRenderer) {
      // Obsidian made a new renderer for this view: start afresh
      this.seenRenderer = r;
      this.stopAnim();
      this.sig = null; this.digest = null; this.pinned = false; this.fit = null;
      this.strikes = 0; this.broken = false;
    }
    const el = this.view.contentEl;
    if (!el.classList.contains('galaxy-graph-host')) el.classList.add('galaxy-graph-host');
    if (!el.isConnected || el.clientWidth < 2 || el.clientHeight < 2) return; // tab not showing
    p.patchPrototypes(r);

    if (p.metaVersion !== this.metaSeen) {
      this.metaSeen = p.metaVersion;
      this.mocSig = this.isGlobal ? p.mocSignature(r) : p.metaVersion;
    }
    const sig = graphSignature(r) + '|' + p.settingsVersion + '|' + (r.fNodeSizeMult || 1) + '|' + this.mocSig;
    if (sig !== this.sig) {
      this.sig = sig;
      this.rebuild(r);
    } else if (this.layoutOn && !this.broken) {
      this.watch(r);
    }
    if (this.isGlobal) {
      this.listen(el);
      if (this.layoutOn && this.model) {
        this.ensureFit(r);
        if (!this.sceneOff) {
          try { this.ensureScene(r); } catch (e) {
            this.fail(e);
            if (++this.sceneFails >= 3) { this.sceneOff = true; this.dropScene(r); }
          }
        }
      } else {
        this.dropScene(r);
      }
      try { this.ensureLegend(); } catch (e) { this.fail(e); }
    }
  }

  /** Note when the reader touches the graph, so the camera is never taken from them. */
  listen(el) {
    if (this.inputEl === el) return;
    this.unlisten();
    this.inputEl = el;
    for (const type of ['pointerdown', 'wheel', 'touchstart']) el.addEventListener(type, this.onInput, { capture: true, passive: true });
  }

  unlisten() {
    const el = this.inputEl;
    this.inputEl = null;
    if (!el) return;
    for (const type of ['pointerdown', 'wheel', 'touchstart']) el.removeEventListener(type, this.onInput, { capture: true });
  }

  /* ---------------- model ---------------- */

  rebuild(r) {
    const p = this.plugin, st = p.settings;
    if (!this.isGlobal) {
      // Local graphs keep their normal layout and simply share the galaxy's colours.
      const colors = p.vaultColors();
      for (const n of r.nodes) {
        p.patchNode(n);
        const c = colors.get(n.id);
        if (c === undefined) { delete n.__gx; continue; }
        const g = n.__gx || (n.__gx = { c: { a: 1, rgb: 0 } });
        g.rgb = c; g.fade = 1; g.min = 0; g.k = 1; g.ctl = null; g.has = false; g.seg = -9;
      }
      if (typeof r.changed === 'function') r.changed();
      return;
    }
    const G = extractGraph(r);
    G.sizeMult = r.fNodeSizeMult || 1;
    const M = buildModel(G, p.modelOptions(G));
    p.remember(M, true);
    const digest = modelDigest(M);
    const changed = digest !== this.digest;
    const wasOn = this.layoutOn;
    this.model = M;
    this.digest = digest;
    this.layoutOn = !!st.layout && G.nodes.length > 0;
    if (this.spot !== null && !M.legend.some((e) => e.seg === this.spot)) this.spot = null;
    const names = this.layoutOn && !!st.names, namesFlip = names !== this.namesOn;
    this.namesOn = names;
    this._lgS = NaN;
    this._naS = NaN;
    const scr0 = screenOf(r);
    if (scr0) this.cssPer = scr0.cssPer;

    const moving = [];
    G.nodes.forEach((n, i) => {
      p.patchNode(n);
      const g = n.__gx || (n.__gx = { c: { a: 1, rgb: 0 } });
      if (namesFlip) plainText(n); // names are dressed again on the next frame if they should be
      g.rgb = M.color[i];
      g.k = this.layoutOn ? M.sizeK[i] : 1;
      g.min = this.layoutOn ? M.sizeMin[i] : 0;
      g.seg = M.seg[i];
      g.fade = this.spot === null || g.seg === this.spot ? 1 : 0.14;
      g.ctl = this.layoutOn ? this : null;
      g.tx = M.pos[i * 2];
      g.ty = M.pos[i * 2 + 1];
      g.q = M.room ? M.room[i] : Infinity; // the largest letter size this note's name has room for, in graph units
      g.has = this.layoutOn;
      if (this.layoutOn) moving.push(n);
    });

    // links inside one arm take that arm's colour; the fan of links out of each MOC is toned down
    for (const l of r.links || []) {
      const a = l.source ? G.index.get(l.source.id) : undefined;
      const b = l.target ? G.index.get(l.target.id) : undefined;
      if (a === undefined || b === undefined) { delete l.__gx; continue; }
      const g = l.__gx || (l.__gx = {});
      const sa = M.seg[a], sb = M.seg[b];
      g.last = NaN;
      g.seg = sa === sb ? sa : -9;
      if (sa >= 0 && sa === sb) {
        g.rgb = M.segs[sa].color;
        g.base = !this.layoutOn ? 1 : M.role[a] === 1 || M.role[b] === 1 ? LINK.hub : LINK.same;
      } else {
        g.rgb = -1;
        g.base = 1;
      }
      g.dim = g.base * (this.spot === null || g.seg === this.spot ? 1 : LINK.off);
    }

    if (this.layoutOn && !this.broken) {
      if (changed || !this.pinned) {
        const first = !this.pinned;
        this.pinned = true;
        const cap = obsidian.Platform && obsidian.Platform.isMobile ? 320 : 900;
        const animate = st.animate && !reducedMotion() && moving.length <= cap && !document.hidden;
        if (!this.fit) this.needFit = true;
        else if (Math.abs(M.Rfit / this.fit.R - 1) > 0.03) {
          // the galaxy changed size: show all of it again, unless you have zoomed in yourself
          if (this.cameraUntouched(r)) this.needFit = true;
          else this.fitNow(r, null, true);
        }
        if (this.needFit) this.ensureFit(r);
        this.move(r, moving, animate ? (first ? 1300 : 700) : 0, first);
      }
    } else if (wasOn) {
      this.release(r);
    }
    if (typeof r.changed === 'function') r.changed();
  }

  /* ---------------- positions ---------------- */

  /** Tell Obsidian's layout engine to hold a note at a fixed position. */
  pin(r, node, x, y) {
    r.worker.postMessage({ forceNode: { id: node.id, x, y } });
  }

  move(r, nodes, duration, swirl) {
    const w = r.worker;
    if (!w || typeof w.postMessage !== 'function') { this.broken = true; return; }
    this.stopAnim();
    if (!duration) {
      for (const n of nodes) {
        const g = n.__gx;
        this.pin(r, n, g.tx, g.ty);
        n.x = g.tx;
        n.y = g.ty;
      }
      w.postMessage({ run: true, alpha: 0.05 });
      r.changed();
      return;
    }
    const items = nodes.map((n) => {
      const g = n.__gx;
      const x0 = Number.isFinite(n.x) ? n.x : 0, y0 = Number.isFinite(n.y) ? n.y : 0;
      const it = { n, g, x0, y0, polar: false };
      if (swirl) {
        // spiral outwards, every note turning the same way, so the galaxy "forms"
        it.polar = true;
        it.r0 = Math.hypot(x0, y0); it.r1 = Math.hypot(g.tx, g.ty);
        const a0 = Math.atan2(y0, x0), a1 = Math.atan2(g.ty, g.tx);
        let da = a1 - a0;
        while (da < 0.4) da += TAU;
        while (da > 0.4 + TAU) da -= TAU;
        it.a1 = a1; it.da = da;
      }
      return it;
    });
    const win = this.view.contentEl.ownerDocument.defaultView || window;
    const now = () => (win.performance ? win.performance.now() : Date.now());
    const anim = { t0: now(), raf: 0, win, swirl: !!swirl };
    const step = () => {
      if (this.anim !== anim) return;
      const t = Math.min(1, (now() - anim.t0) / duration);
      const e = 1 - Math.pow(1 - t, 3);
      try {
        w.postMessage({ run: true, alpha: 0.3 });
        for (const it of items) {
          if (r.dragNode === it.n) continue;
          let x, y;
          if (t >= 1) { x = it.g.tx; y = it.g.ty; }
          else if (it.polar) {
            const rr = lerp(it.r0, it.r1, e), a = it.a1 - it.da * (1 - e);
            x = rr * Math.cos(a); y = rr * Math.sin(a);
          } else { x = lerp(it.x0, it.g.tx, e); y = lerp(it.y0, it.g.ty, e); }
          this.pin(r, it.n, x, y);
          if (t >= 1) { it.n.x = x; it.n.y = y; }
        }
        if (t >= 1) w.postMessage({ alpha: 0.01 }); // let Obsidian's layout engine wind down quickly
        if (swirl && this.sprite && !pixiGone(this.sprite)) this.sprite.alpha = this.glowAlpha() * e;
        r.changed();
      } catch (err) {
        this.anim = null;
        this.fail(err);
        return;
      }
      if (t < 1) anim.raf = win.requestAnimationFrame(step);
      else this.anim = null;
    };
    this.anim = anim;
    anim.raf = win.requestAnimationFrame(step);
  }

  stopAnim() {
    const a = this.anim;
    if (!a) return;
    this.anim = null;
    try { a.win.cancelAnimationFrame(a.raf); } catch (e) { /* ignore */ }
  }

  /** Put back any note that has drifted (for example after being dragged). */
  watch(r) {
    if (this.anim) return;
    const drag = r.dragNode;
    let strays = null;
    for (const n of r.nodes) {
      const g = n.__gx;
      if (!g || !g.has || n === drag) continue;
      const dx = n.x - g.tx, dy = n.y - g.ty;
      if (!(dx * dx + dy * dy <= 1)) (strays || (strays = [])).push(n);
    }
    if (!strays) { this.strikes = 0; return; }
    if (++this.strikes > 14) {
      // Obsidian is not honouring pinned positions; stop fighting it.
      this.broken = true;
      console.warn('Galaxy Graph: could not hold notes in place, layout switched off for this view.');
      return;
    }
    const animate = this.plugin.settings.animate && !reducedMotion() && strays.length <= 60;
    this.move(r, strays, animate ? 420 : 0, false);
  }

  /** Hand the notes back to Obsidian's normal layout. */
  release(r) {
    this.stopAnim();
    this.pinned = false;
    const w = r && r.worker;
    if (!w || typeof w.postMessage !== 'function' || !Array.isArray(r.nodes)) return;
    try {
      for (const n of r.nodes) w.postMessage({ forceNode: { id: n.id, x: null, y: null } });
      w.postMessage({ run: true, alpha: 0.3 });
      r.changed();
    } catch (e) { /* ignore */ }
  }

  /* ---------------- camera ---------------- */

  /**
   * 0 to 1: how clearly a note's name shows (on top of Obsidian's own fading). A name stays hidden
   * until there is room for it beside its neighbours' names and it is big enough to read.
   */
  nameAlpha(g, r) {
    const sc = r.scale;
    if (sc !== this._naS) {
      this._naS = sc;
      // Obsidian keeps names one size on screen while zoomed out and lets them grow slowly once zoomed in.
      this._naOwn = sc < 1 ? 1 : Math.sqrt(sc);
    }
    const own = (g.fpx || 14) * this._naOwn;   // Obsidian's size for this name, in screen pixels
    const fits = sc * g.q;                     // the largest size it has room for
    if (!(fits < own)) {
      if (!this.namesOn) return 1;
      return smooth(6.5, 8, Math.max(own, Math.min(NAME.px / this.cssPer, fits)) * this.cssPer);
    }
    const a = smooth(0.75, 1, fits / own);
    return a > 0 && this.namesOn ? a * smooth(6.5, 8, own * this.cssPer) : a;
  }

  /**
   * How much larger than Obsidian's own size a note's name is drawn (1 = unchanged). On a sharp screen
   * Obsidian draws names only a few points tall. They are brought up to a comfortable reading size,
   * but never beyond what the name has room for.
   */
  labelGain(r, t, sx, g, highlighted) {
    const sc = r.scale, par = t.parent;
    if (sc !== this._lgS || par !== this._lgP) {
      this._lgS = sc;
      this._lgP = par;
      let k = 1;
      for (let p = par, i = 0; p && i < 6; p = p.parent, i++) if (p.scale && p.scale.x > 0) k *= p.scale.x;
      this._lgK = k; // zoom applied to the name by everything it sits inside
    }
    const own = (g.fpx || 14) * sx * this._lgK; // the size Obsidian drew it at, in screen pixels
    if (!(own > 0)) return 1;
    const full = NAME.px / this.cssPer;
    // the note under your finger has no neighbours' names to crowd, so it always gets the full size
    return clamp((highlighted ? full : Math.min(full, sc * g.q)) / own, 1, NAME.max);
  }

  ensureFit(r) {
    const scr = screenOf(r);
    if (!scr || !this.model) return;
    if (this.needFit) { this.fitNow(r, scr); return; }
    const f = this.fit;
    if (f && f.first && Date.now() - f.at < 3500 && this.userInput < f.at && !this.cameraUntouched(r)) {
      // Obsidian restored an older zoom just after the galaxy was framed, and nobody has touched it: frame it again.
      this.fitNow(r, scr);
      return;
    }
    if (f && (Math.abs(scr.w - f.w) > 1 || Math.abs(scr.h - f.h) > 1)) {
      // The view was resized (or the iPad rotated). Re-fit unless you have zoomed yourself.
      this.fitNow(r, scr, !this.cameraUntouched(r));
    }
  }

  /** True while the zoom is still the one this plugin chose. */
  cameraUntouched(r) {
    const f = this.fit;
    return !!f && Math.abs((r.targetScale || r.scale) / f.scale - 1) < 0.002;
  }

  /**
   * Work out the zoom that shows the whole galaxy and move the camera there.
   * With `keepCamera` only the bookkeeping is updated and the view is left where it is.
   */
  fitNow(r, scr, keepCamera) {
    scr = scr || screenOf(r);
    const M = this.model;
    if (!scr || !M) return false;
    if (!keepCamera) this.needFit = false;
    const pad = 16 / scr.cssPer;
    const hw = scr.w / 2 - pad, hh = scr.h / 2 - pad;
    const base = Math.min(hw, hh) / M.Rfit;
    let scale = base, tucked = false;
    const st = this.plugin.settings;
    const fontPx = this.labelFontPx(scr);
    if (st.armLabels && M.tips.length) {
      // leave room for the arm names round the edge
      const Rl = M.geo.Rout + 0.55 * M.s, h = fontPx * 1.3;
      let beside = base, stacked = base * 0.95;
      for (const tip of M.tips) {
        if (!tip.text) continue;
        const w = this.labelText(tip.text).length * fontPx * 0.74;
        const ax = Math.abs(tip.ux), ay = Math.abs(tip.uy);
        if (ax > 0.05) beside = Math.min(beside, (hw - (ax > 0.38 ? w : w / 2)) / (Rl * ax));
        if (ay > 0.05) {
          beside = Math.min(beside, (hh - (ay > 0.38 ? h : h / 2)) / (Rl * ay));
          stacked = Math.min(stacked, (hh - 2.6 * h) / (Rl * ay));
        }
      }
      if (beside >= 0.72 * base) scale = beside;
      else { scale = stacked; tucked = true; } // narrow screen: names go above or below the arm tips instead
    }
    scale = clamp(Math.max(scale, 0.5 * base), 1 / 128, 4);
    const px = scr.w / 2, py = scr.h / 2;
    if (!keepCamera) {
      try {
        r.targetScale = scale;
        if (typeof r.setScale === 'function') r.setScale(scale);
        if (typeof r.setPan === 'function') r.setPan(px, py);
        else { r.panX = px; r.panY = py; }
        r.zoomCenterX = 0;
        r.zoomCenterY = 0;
        r.changed();
      } catch (e) { /* ignore */ }
    }
    const prev = this.fit;
    this.fit = {
      scale, w: scr.w, h: scr.h, R: M.Rfit, cssPer: scr.cssPer, tucked,
      first: keepCamera ? false : !prev || !!prev.first,
      at: prev && prev.first && !keepCamera ? prev.at : Date.now(),
    };
    this.cssPer = scr.cssPer;
    this._lgS = NaN;
    this._naS = NaN;
    this.layoutLabels();
    return true;
  }

  /* ---------------- glow and arm names ---------------- */

  glowAlpha() { return clamp(this.plugin.settings.glow, 0, 1); }
  labelFontPx(scr) { return 11.5 / scr.cssPer; }
  labelText(t) { return t.length > 30 ? t.slice(0, 29).toUpperCase() + '…' : t.toUpperCase(); }

  ensureScene(r) {
    const st = this.plugin.settings, M = this.model, hanger = r.hanger;
    if (!hanger || typeof hanger.addChildAt !== 'function') return;
    const P = pixiOf(r);
    if (!P) return;

    /* glow */
    if (st.glow > 0) {
      const sp = this.sprite;
      const dead = pixiGone(sp);
      if (dead || this.spriteFor !== this.digest) {
        if (sp && this.spriteFor === this.digest) {
          // The picture vanished although the galaxy did not change. Once in a while that is normal
          // (Obsidian rebuilt its graphics); if it keeps happening, stop redrawing it.
          const now = Date.now();
          this.remakes = this.remakes.filter((t) => now - t < 20000);
          this.remakes.push(now);
          if (this.remakes.length > 4) { this.sceneOff = true; this.dropScene(r); return; }
        }
        this.dropSprite();
        const mobile = obsidian.Platform && obsidian.Platform.isMobile;
        const T = mobile ? 1536 : 2048;
        const cv = paintHaze(M, T, document);
        if (cv) {
          const tex = P.Texture.from(cv);
          const s2 = new P.Sprite(tex);
          s2.anchor.set(0.5);
          s2.position.set(0, 0);
          s2.scale.set((2 * M.extent) / T);
          s2.zIndex = -1000;
          if ('eventMode' in s2) s2.eventMode = 'none'; else s2.interactive = false;
          s2.alpha = this.anim && this.anim.swirl ? 0 : this.glowAlpha();
          hanger.addChildAt(s2, 0);
          this.sprite = s2;
          this.spriteFor = this.digest;
          r.changed();
        }
      } else {
        if (sp.parent !== hanger) { hanger.addChildAt(sp, 0); r.changed(); }
        if (!(this.anim && this.anim.swirl) && sp.alpha !== this.glowAlpha()) { sp.alpha = this.glowAlpha(); r.changed(); }
      }
    } else {
      this.dropSprite();
    }

    /* arm names */
    if (st.armLabels && P.Text && M.tips.length) {
      const dead = this.labels.some(pixiGone);
      // on a light theme with the dark background switched off, the names have to be dark enough to read
      const light = !st.background && document.body.classList.contains('theme-light');
      const key = this.digest + (light ? '|light' : '');
      if (dead || this.labelsFor !== key || !this.labels.length) {
        this.dropLabels();
        let family = 'sans-serif';
        try {
          const sample = r.nodes.find((n) => n.text && n.text.style);
          family = (sample && sample.text.style.fontFamily) || getComputedStyle(document.body).fontFamily || family;
        } catch (e) { /* ignore */ }
        for (const tip of M.tips) {
          if (!tip.text) continue;
          const t = new P.Text(this.labelText(tip.text), {
            fontFamily: family, fontSize: 40, fontWeight: '600', letterSpacing: 5,
            fill: cssHex(light ? mixRgb(tip.color, 0x16152a, 0.5) : mixRgb(tip.color, COL.white, 0.25)),
          });
          t.resolution = 2;
          t.zIndex = 3;
          t.alpha = 0.85;
          if ('eventMode' in t) t.eventMode = 'none'; else t.interactive = false;
          t.__tip = tip;
          // PixiJS calls this on our own label once per drawn frame: a safe place to keep its size steady.
          const ctl = this, baseUpdate = t.updateTransform;
          if (typeof baseUpdate === 'function') {
            t.updateTransform = function () {
              try { ctl.tuneLabel(this); } catch (e) { /* ignore */ }
              return baseUpdate.apply(this, arguments);
            };
          }
          hanger.addChild(t);
          this.labels.push(t);
        }
        this.labelsFor = key;
        this.layoutLabels();
        r.changed();
      } else {
        for (const t of this.labels) if (t.parent !== hanger) { hanger.addChild(t); r.changed(); }
      }
    } else {
      this.dropLabels();
    }
  }

  /** Size and place the arm names so they read at a normal text size when the whole galaxy is in view. */
  layoutLabels() {
    const f = this.fit, M = this.model;
    if (!f || !M || !this.labels.length) return;
    const world = 11.5 / f.cssPer / f.scale; // font size in graph units
    const off = 0.55 * M.s;
    for (const t of this.labels) {
      if (pixiGone(t)) continue;
      const tip = t.__tip;
      t.scale.set(world / 40);
      const side = Math.abs(tip.ux) > 0.38;
      if (!f.tucked) {
        // beside the tip, reading away from the galaxy
        t.anchor.set(!side ? 0.5 : tip.ux > 0 ? 0 : 1, Math.abs(tip.uy) <= 0.38 ? 0.5 : tip.uy > 0 ? 0 : 1);
        t.position.set(tip.x + tip.ux * off, tip.y + tip.uy * off);
        continue;
      }
      // narrow screen: keep the name on screen, just past the end of its arm
      const wS = t.width * f.scale, hS = t.height * f.scale, pad = 10 / f.cssPer;
      let sx = f.w / 2 + (tip.x + tip.ux * off) * f.scale;
      let sy = f.h / 2 + (tip.y + tip.uy * off) * f.scale;
      sy += side ? (tip.ux > 0 ? 1 : -1) * 1.5 * hS : (tip.uy > 0 ? 1 : -1) * 0.6 * hS;
      sx = clamp(sx, pad + wS / 2, Math.max(pad + wS / 2, f.w - pad - wS / 2));
      t.anchor.set(0.5, 0.5);
      t.position.set((sx - f.w / 2) / f.scale, (sy - f.h / 2) / f.scale);
    }
    const r = this.renderer;
    if (r && typeof r.changed === 'function') r.changed();
  }

  /** Arm names stay the same size on screen when you zoom in, and step back a little. */
  tuneLabel(t) {
    const f = this.fit, r = this.renderer;
    if (!f || !r || !(r.scale > 0)) return;
    const z = r.scale / f.scale;
    const sc = 11.5 / f.cssPer / Math.max(r.scale, f.scale) / 40;
    if (Math.abs(t.scale.x - sc) > sc * 1e-4) t.scale.set(sc);
    const a = z > 1 ? lerp(0.85, 0.5, smooth(1.4, 3, z)) : 0.85;
    if (t.alpha !== a) t.alpha = a;
  }

  dropSprite() {
    const sp = this.sprite;
    this.sprite = null;
    this.spriteFor = null;
    if (!sp) return;
    try {
      if (sp.parent) sp.parent.removeChild(sp);
      if (!pixiGone(sp)) sp.destroy({ texture: true, baseTexture: true });
    } catch (e) { /* ignore */ }
  }

  dropLabels() {
    const list = this.labels;
    this.labels = [];
    this.labelsFor = null;
    for (const t of list) {
      try {
        if (t.parent) t.parent.removeChild(t);
        if (!pixiGone(t)) t.destroy(true);
      } catch (e) { /* ignore */ }
    }
  }

  dropScene(r) {
    const had = this.sprite || this.labels.length;
    this.dropSprite();
    this.dropLabels();
    if (had && r && typeof r.changed === 'function') r.changed();
  }

  /* ---------------- legend ---------------- */

  ensureLegend() {
    const st = this.plugin.settings, M = this.model;
    const want = st.legend && M && M.legend.length > 0;
    if (!want) { this.dropLegend(); return; }
    const collapsed = st.legendCollapsed === null || st.legendCollapsed === undefined
      ? this.view.contentEl.clientWidth < 520
      : !!st.legendCollapsed;
    const key = this.digest + '|' + collapsed + '|' + this.layoutOn;
    if (this.legendEl && this.legendEl.isConnected && this.legendFor === key) return;
    this.dropLegend();
    const doc = this.view.contentEl.ownerDocument;
    const mk = (tag, cls, text) => {
      const e = doc.createElement(tag);
      if (cls) e.className = cls;
      if (text != null) e.textContent = text;
      return e;
    };
    const root = mk('div', 'galaxy-legend' + (collapsed ? ' is-collapsed' : ''));
    const head = mk('div', 'galaxy-legend-head');
    const title = mk('div', 'galaxy-legend-title', 'Galaxy');
    head.appendChild(title);
    if (this.layoutOn) {
      const fitBtn = mk('div', 'galaxy-legend-btn clickable-icon');
      fitBtn.setAttribute('aria-label', 'Fit the galaxy to the view');
      this.icon(fitBtn, 'maximize', '⤢');
      fitBtn.addEventListener('click', (ev) => { ev.stopPropagation(); this.fitNow(this.renderer); });
      head.appendChild(fitBtn);
    }
    const tog = mk('div', 'galaxy-legend-btn clickable-icon');
    tog.setAttribute('aria-label', collapsed ? 'Show the list' : 'Hide the list');
    this.icon(tog, collapsed ? 'chevron-up' : 'chevron-down', collapsed ? '▴' : '▾');
    tog.addEventListener('click', (ev) => {
      ev.stopPropagation();
      st.legendCollapsed = !collapsed;
      this.plugin.persist();
      this.ensureLegend();
    });
    head.appendChild(tog);
    root.appendChild(head);
    const list = mk('div', 'galaxy-legend-list');
    for (const e of M.legend) {
      const row = mk('div', 'galaxy-legend-item' + (this.spot === e.seg ? ' is-active' : ''));
      const dot = mk('span', 'galaxy-legend-dot');
      dot.style.backgroundColor = cssHex(e.color);
      dot.style.boxShadow = '0 0 6px ' + cssRgba(e.color, 0.7);
      row.appendChild(dot);
      row.appendChild(mk('span', 'galaxy-legend-name', e.name));
      row.appendChild(mk('span', 'galaxy-legend-count', String(e.count)));
      row.addEventListener('click', (ev) => { ev.stopPropagation(); this.spotlight(this.spot === e.seg ? null : e.seg); });
      list.appendChild(row);
    }
    root.appendChild(list);
    this.view.contentEl.appendChild(root);
    this.legendEl = root;
    this.legendFor = key;
  }

  icon(el, name, fallback) {
    try {
      if (typeof obsidian.setIcon === 'function') { obsidian.setIcon(el, name); if (el.childNodes.length) return; }
    } catch (e) { /* ignore */ }
    el.textContent = fallback;
  }

  /** Dim everything except one arm (or clear with null). */
  spotlight(seg) {
    this.spot = seg;
    const r = this.renderer;
    if (r && Array.isArray(r.nodes)) {
      for (const n of r.nodes) {
        const g = n.__gx;
        if (g) g.fade = seg === null || g.seg === seg ? 1 : 0.14;
      }
      for (const l of r.links || []) {
        const g = l.__gx;
        if (g) { g.dim = g.base * (seg === null || g.seg === seg ? 1 : LINK.off); g.last = NaN; }
      }
      if (typeof r.changed === 'function') r.changed();
    }
    if (this.legendEl) {
      const rows = this.legendEl.querySelectorAll('.galaxy-legend-item');
      const L = this.model ? this.model.legend : [];
      rows.forEach((row, i) => row.classList.toggle('is-active', !!L[i] && L[i].seg === seg));
    }
  }

  dropLegend() {
    if (this.legendEl) this.legendEl.remove();
    this.legendEl = null;
    this.legendFor = null;
  }

  /* ---------------- lifecycle ---------------- */

  /** Facts about this graph view for the diagnostic report (no note names or contents). */
  report() {
    const r = this.renderer || {}, M = this.model;
    const n = (r.nodes && r.nodes[0]) || null, l = (r.links && r.links[0]) || null;
    const has = (o, k) => !!o && o[k] !== undefined && o[k] !== null;
    const fn = (o, k) => !!o && typeof o[k] === 'function';
    let drift = 0;
    for (const node of r.nodes || []) {
      const g = node.__gx;
      if (g && g.has) drift = Math.max(drift, Math.hypot(node.x - g.tx, node.y - g.ty));
    }
    const round = (v) => (typeof v === 'number' ? Math.round(v * 1000) / 1000 : v);
    let edged = 0, gain = 1;
    for (const node of r.nodes || []) {
      const g = node.__gx, t = node.text;
      if (!g || !t || !t.style) continue;
      if (t.style.__gx0) edged++;
      if (g.ts0 > 0 && g.ts > 0 && t.visible !== false) gain = Math.max(gain, g.ts / g.ts0);
    }
    return {
      type: this.view.getViewType(),
      nodes: r.nodes ? r.nodes.length : -1,
      links: r.links ? r.links.length : -1,
      layoutOn: this.layoutOn, pinned: this.pinned, broken: this.broken, strikes: this.strikes,
      errors: this.errors, lastError: this.lastError, sceneOff: this.sceneOff, sceneFails: this.sceneFails,
      glow: !!this.sprite && !pixiGone(this.sprite), armNames: this.labels.length, list: !!this.legendEl, drift: round(drift),
      names: { on: this.namesOn, edged, gain: round(gain), size: n && n.text && n.text.style ? n.text.style.fontSize : null, sharp: n && n.text ? n.text.resolution : null, inside: n && n.text && n.text.parent ? (n.text.parent === r.hanger ? 'graph' : n.text.parent === n.circle ? 'note' : 'other') : null },
      fit: this.fit ? { scale: round(this.fit.scale), w: this.fit.w, h: this.fit.h, tucked: this.fit.tucked } : null,
      camera: { scale: round(r.scale), target: round(r.targetScale), panX: round(r.panX), panY: round(r.panY), nodeScale: round(r.nodeScale), textAlpha: round(r.textAlpha) },
      drawn: r.hanger && r.hanger.worldTransform ? { x: round(r.hanger.worldTransform.tx), y: round(r.hanger.worldTransform.ty), scale: round(r.hanger.worldTransform.a) } : null,
      model: M ? {
        mode: M.mode, auto: !!M.auto, arms: M.arms.length, groups: M.segs.length, centre: M.core >= 0,
        aroundCentre: M.bulgeN, unlinked: M.haloN, gap: Math.round(M.s), rim: Math.round(M.geo.Rout), fitRadius: Math.round(M.Rfit),
      } : null,
      renderer: {
        worker: fn(r.worker, 'postMessage'), hanger: fn(r.hanger, 'addChildAt'), sortable: r.hanger ? !!r.hanger.sortableChildren : null,
        px: has(r, 'px'), screen: screenOf(r), setScale: fn(r, 'setScale'), setPan: fn(r, 'setPan'), changed: fn(r, 'changed'),
        getHighlightNode: fn(r, 'getHighlightNode'), dragNode: 'dragNode' in r, textAlpha: typeof r.textAlpha,
        targetScale: typeof r.targetScale, nodeSize: r.fNodeSizeMult, width: r.width, height: r.height,
      },
      node: n ? {
        circle: has(n, 'circle'), text: has(n, 'text'), getFillColor: fn(n, 'getFillColor'), getSize: fn(n, 'getSize'), render: fn(n, 'render'),
        ownFill: Object.prototype.hasOwnProperty.call(n, 'getFillColor'), weight: typeof n.weight, coloured: !!n.__gx,
      } : null,
      link: l ? { line: has(l, 'line'), px: has(l, 'px'), render: fn(l, 'render'), tint: l.line ? typeof l.line.tint : null, coloured: !!l.__gx } : null,
    };
  }

  fail(err) {
    this.lastError = String((err && (err.stack || err.message)) || err).slice(0, 600);
    if (++this.errors <= 3) console.warn('Galaxy Graph:', err);
    if (this.errors > 8) this.broken = true;
  }

  destroy(restore) {
    this.stopAnim();
    this.unlisten();
    const r = this.renderer;
    this.dropScene(r);
    this.dropLegend();
    try { this.view.contentEl.classList.remove('galaxy-graph-host'); } catch (e) { /* ignore */ }
    if (restore && r && Array.isArray(r.nodes)) {
      if (this.pinned) this.release(r);
      for (const n of r.nodes) { plainText(n); this.plugin.unpatchNode(n); delete n.__gx; delete n.__gxh; delete n.__gxt; }
      const plain = r.colors && r.colors.line;
      for (const l of r.links || []) {
        if (l.__gx && l.line && plain && !pixiGone(l.line)) { try { l.line.tint = plain.rgb; l.line.alpha = plain.a; } catch (e) { /* ignore */ } }
        delete l.__gx;
      }
      if (this.isGlobal && this.fit) this.plainCamera(r);
      if (typeof r.changed === 'function') r.changed();
    }
    this.sig = null;
    this.digest = null;
    this.model = null;
  }

  /** Obsidian's own layout is far tighter than the galaxy: zoom to suit it, so the normal graph is not a speck. */
  plainCamera(r) {
    try {
      const scr = screenOf(r);
      if (!scr) return;
      const radius = 60 * Math.sqrt(r.nodes.length) + 150;
      const scale = clamp(Math.min(scr.w, scr.h) / (2.2 * radius), 0.2, 1.5);
      r.targetScale = scale;
      if (typeof r.setScale === 'function') r.setScale(scale);
      if (typeof r.setPan === 'function') r.setPan(scr.w / 2, scr.h / 2); else { r.panX = scr.w / 2; r.panY = scr.h / 2; }
      r.zoomCenterX = 0;
      r.zoomCenterY = 0;
    } catch (e) { /* leave the view where it is */ }
  }
}

/* ------------------------------------------------------------------ */
/* The plugin                                                          */
/* ------------------------------------------------------------------ */

class GalaxyGraphPlugin extends Plugin {
  async onload() {
    const saved = (await this.loadData()) || {};
    // carry over the on/off switches from version 1
    if (saved.layout === undefined && typeof saved.spiralLayout === 'boolean') saved.layout = saved.spiralLayout;
    if (saved.background === undefined && typeof saved.softBackground === 'boolean') saved.background = saved.softBackground;
    if (saved.stars === undefined && typeof saved.backgroundStars === 'boolean') saved.stars = saved.backgroundStars;
    this.settings = {};
    for (const k of Object.keys(DEFAULTS)) {
      const d = DEFAULTS[k], v = saved[k];
      if (v === undefined || v === null) this.settings[k] = d;
      else if (typeof d === 'boolean') this.settings[k] = !!v;
      else if (typeof d === 'number') this.settings[k] = Number.isFinite(+v) ? +v : d;
      else if (typeof d === 'string') this.settings[k] = String(v);
      else this.settings[k] = typeof v === 'boolean' ? v : d;
    }
    const st = this.settings;
    st.pitch = clamp(st.pitch, 8, 32);
    st.spread = clamp(st.spread, 0.5, 2.5);
    st.glow = clamp(st.glow, 0, 1);
    st.links = clamp(st.links, 0, 1);
    // which colour and which place each MOC was given, so both stay put from one day to the next
    const mem = saved.memory && typeof saved.memory === 'object' ? saved.memory : {};
    this.memory = {
      colors: mem.colors && typeof mem.colors === 'object' ? mem.colors : {},
      rank: Array.isArray(mem.rank) ? mem.rank.filter((x) => typeof x === 'string') : [],
    };

    this.controllers = new Map();
    this.patches = [];
    this.patchedProtos = new WeakSet();
    this.nodeWraps = [];
    this.settingsVersion = 1;
    this.metaVersion = 1;
    this._vaultColors = null;
    this.compile();

    this.addSettingTab(new GalaxySettingTab(this.app, this));
    this.addCommand({
      id: 'toggle',
      name: 'Turn galaxy on or off',
      callback: () => this.toggle(),
    });
    this.addCommand({
      id: 'fit',
      name: 'Fit the galaxy to the view',
      callback: () => { for (const c of this.controllers.values()) if (c.isGlobal && c.layoutOn) c.fitNow(c.renderer); },
    });
    this.addCommand({
      id: 'rearrange',
      name: 'Re-arrange the graph into a galaxy',
      callback: () => {
        for (const c of this.controllers.values()) {
          c.sig = null; c.digest = null; c.broken = false; c.strikes = 0; c.errors = 0;
          c.sceneOff = false; c.sceneFails = 0; c.remakes = []; c.needFit = true;
        }
        this.tick();
      },
    });

    this.addCommand({
      id: 'report',
      name: 'Copy a diagnostic report',
      callback: () => this.copyReport(),
    });

    this.registerEvent(this.app.metadataCache.on('resolved', () => { this.metaVersion++; this._vaultColors = null; }));
    if (this.app.vault && typeof this.app.vault.on === 'function') {
      // a renamed MOC keeps its colour and its place
      this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
        const mem = this.memory, to = file && file.path;
        if (!to || typeof oldPath !== 'string') return;
        let dirty = false;
        if (mem.colors[oldPath] !== undefined) { mem.colors[to] = mem.colors[oldPath]; delete mem.colors[oldPath]; dirty = true; }
        const at = mem.rank.indexOf(oldPath);
        if (at >= 0) { mem.rank[at] = to; dirty = true; }
        if (dirty) this.persistSoon();
      }));
    }
    this.registerEvent(this.app.workspace.on('layout-change', () => this.tickSoon()));
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.tickSoon()));
    this.registerInterval(window.setInterval(() => this.tick(), 400));
    this.app.workspace.onLayoutReady(() => { this.applyBody(); this.tick(); });
  }

  onunload() {
    if (this._persist) { window.clearTimeout(this._persist); this._persist = 0; this.persist(); }
    if (this._soon) { window.clearTimeout(this._soon); this._soon = 0; }
    this.shutdown();
    this.applyBody(true);
    this.ensureSwitches(this.graphViews(), true);
  }

  /** Galaxy on or off: the command, and the button in the corner of the graph view, both come here. */
  async toggle() {
    this.settings.enabled = !this.settings.enabled;
    await this.saveSettings();
  }

  /**
   * The on/off button in the corner of the main graph view. It is there whether the galaxy is on
   * or off, so one tap switches between the galaxy and Obsidian's normal graph.
   */
  ensureSwitches(views, remove) {
    const want = !remove && this.settings.switchButton !== false, on = !!this.settings.enabled;
    for (const v of views) {
      try {
        if (v.getViewType() !== 'graph') continue;
        const host = v.contentEl;
        let el = null;
        for (const c of Array.from(host.children)) if (c.classList && c.classList.contains('galaxy-switch')) el = c;
        if (!want) {
          if (el) el.remove();
          host.classList.remove('galaxy-switch-host');
          continue;
        }
        if (!el) {
          el = host.ownerDocument.createElement('div');
          el.className = 'galaxy-switch';
          el.setAttribute('role', 'button');
          el.addEventListener('click', (ev) => { ev.stopPropagation(); this.toggle(); });
          // a tap on the button must not start dragging the graph underneath
          for (const type of ['pointerdown', 'mousedown', 'touchstart']) el.addEventListener(type, (ev) => ev.stopPropagation());
          host.appendChild(el);
          host.classList.add('galaxy-switch-host');
        }
        const state = on ? 'on' : 'off';
        if (el.dataset.state === state) continue;
        el.dataset.state = state;
        el.classList.toggle('is-on', on);
        el.setAttribute('aria-label', on ? 'Galaxy is on. Tap for the normal graph.' : 'Galaxy is off. Tap for the galaxy.');
        el.textContent = '';
        const ic = host.ownerDocument.createElement('span');
        ic.className = 'galaxy-switch-icon';
        try { if (typeof obsidian.setIcon === 'function') obsidian.setIcon(ic, 'orbit'); } catch (e) { /* plain dot below */ }
        if (!ic.childNodes.length) ic.textContent = '✦';
        el.appendChild(ic);
        const label = host.ownerDocument.createElement('span');
        label.textContent = on ? 'Galaxy on' : 'Galaxy off';
        el.appendChild(label);
      } catch (e) { /* never let the button break the graph */ }
    }
  }

  /** What the plugin found in this copy of Obsidian. Holds settings and counts only, never note names or text. */
  diagnostics() {
    const P = window.PIXI, pf = obsidian.Platform;
    const st = Object.assign({}, this.settings);
    st.centerNote = st.centerNote ? '(set)' : '';
    const rep = {
      plugin: (this.manifest && this.manifest.version) || null,
      obsidian: obsidian.apiVersion || null,
      platform: pf ? { mobile: !!pf.isMobile, phone: !!pf.isPhone, tablet: !!pf.isTablet, ios: !!pf.isIosApp, android: !!pf.isAndroidApp, desktop: !!pf.isDesktopApp } : null,
      pixelRatio: window.devicePixelRatio || 1,
      pixi: P ? { version: P.VERSION || null, Sprite: !!P.Sprite, Texture: !!P.Texture, Text: !!P.Text } : null,
      settings: st,
      remembered: { colours: Object.keys(this.memory.colors).length, places: this.memory.rank.length },
      hooks: this.patches.map((p) => p.name).concat(this.nodeWraps.map((w) => w.name + ' (per note)')),
      views: [],
    };
    for (const c of this.controllers.values()) { try { rep.views.push(c.report()); } catch (e) { rep.views.push({ error: String(e) }); } }
    return rep;
  }

  async copyReport() {
    const text = 'Galaxy Graph report\n' + JSON.stringify(this.diagnostics(), null, 1);
    let done = false;
    try { await navigator.clipboard.writeText(text); done = true; } catch (e) { /* fall through */ }
    console.log(text);
    if (typeof obsidian.Notice === 'function') {
      new obsidian.Notice(done ? 'Galaxy Graph: report copied. Paste it wherever you are asking for help.' : 'Galaxy Graph: could not reach the clipboard; the report is in the developer console.');
    }
    return text;
  }

  compile() {
    const st = this.settings;
    this.mocRe = wordRegex(st.mocText);
    this.mocCamel = camelRegex(st.mocText);
    this.mocTag = (st.mocTag || '').trim().replace(/^#/, '').toLowerCase();
  }

  persist() {
    return this.saveData(Object.assign({}, this.settings, { memory: this.memory }));
  }

  persistSoon() {
    if (this._persist) return;
    this._persist = window.setTimeout(() => { this._persist = 0; this.persist(); }, 1500);
  }

  /** Keep each MOC's colour, and the order of the arms, from one session to the next. */
  remember(M, withRank) {
    if (!M || !Array.isArray(M.segs)) return;
    const mem = this.memory, keep = (id) => typeof id === 'string' && (/\.md$/i.test(id) || id.startsWith('folder:'));
    let dirty = false;
    for (const sg of M.segs) {
      if (!keep(sg.id) || !Number.isInteger(sg.ci)) continue;
      if (mem.colors[sg.id] !== sg.ci) { mem.colors[sg.id] = sg.ci; dirty = true; }
    }
    if (withRank && Array.isArray(M.rank)) {
      const now = M.rank.filter(keep), present = new Set(now);
      const merged = [];
      let k = 0;
      for (const id of mem.rank) merged.push(present.has(id) ? now[k++] : id); // MOCs hidden by a filter keep their place
      while (k < now.length) merged.push(now[k++]);
      if (merged.length !== mem.rank.length || merged.some((id, i) => id !== mem.rank[i])) { mem.rank = merged; dirty = true; }
    }
    if (dirty) this.persistSoon();
  }

  async saveSettings() {
    await this.persist();
    this.compile();
    this.settingsVersion++;
    this._vaultColors = null;
    this.applyBody();
    if (!this.settings.enabled) this.shutdown();
    this.tick();
  }

  /** Classes and variables on <body> that the stylesheet keys off. */
  applyBody(off) {
    const st = this.settings, b = document.body;
    const on = !off && st.enabled;
    b.classList.toggle('galaxy-graph-on', on);
    b.classList.toggle('galaxy-bg', on && st.background);
    b.classList.toggle('galaxy-bg-stars', on && st.background && st.stars);
    if (on) {
      const v = clamp(st.links, 0, 1);
      b.style.setProperty('--galaxy-line-alpha', (0.02 + 0.26 * v * v).toFixed(3));
    } else {
      b.style.removeProperty('--galaxy-line-alpha');
    }
    this.app.workspace.trigger('css-change');
  }

  shutdown() {
    for (const c of this.controllers.values()) { try { c.destroy(true); } catch (e) { /* ignore */ } }
    this.controllers.clear();
    for (const p of this.patches) { try { if (p.proto[p.name] === p.wrapped) p.proto[p.name] = p.orig; } catch (e) { /* ignore */ } }
    this.patches = [];
    this.patchedProtos = new WeakSet();
    this.nodeWraps = [];
  }

  graphViews() {
    const ws = this.app.workspace, res = [];
    for (const type of ['graph', 'localgraph']) {
      for (const leaf of ws.getLeavesOfType(type)) {
        const v = leaf.view;
        if (v && v.renderer && v.contentEl && typeof v.getViewType === 'function') res.push(v);
      }
    }
    return res;
  }

  tickSoon() {
    if (this._soon) return;
    this._soon = window.setTimeout(() => { this._soon = 0; this.tick(); }, 60);
  }

  tick() {
    const views = this.graphViews(), live = new Set(views);
    this.ensureSwitches(views);
    if (!this.settings.enabled) return;
    for (const [v, c] of this.controllers) {
      if (!live.has(v) || !v.contentEl || !v.contentEl.isConnected) {
        try { c.destroy(false); } catch (e) { /* ignore */ }
        this.controllers.delete(v);
      }
    }
    for (const v of views) {
      let c = this.controllers.get(v);
      if (!c) { c = new GraphController(this, v); this.controllers.set(v, c); }
      try { c.tick(); } catch (e) { c.fail(e); }
    }
  }

  /** Wrap three methods of Obsidian's graph node class (colour, size, label fade). */
  patchPrototypes(r) {
    const link = r.links && r.links[0];
    if (link) {
      const lp = Object.getPrototypeOf(link);
      if (lp && lp !== Object.prototype && !this.patchedProtos.has(lp)) {
        this.patchedProtos.add(lp);
        let owner = lp;
        while (owner && owner !== Object.prototype && !Object.prototype.hasOwnProperty.call(owner, 'render')) owner = Object.getPrototypeOf(owner);
        if (owner && owner !== Object.prototype && typeof owner.render === 'function' && !owner.render.__galaxy) {
          const orig = owner.render, wrapped = wrapLinkRender(orig);
          wrapped.__galaxy = true;
          owner.render = wrapped;
          this.patches.push({ proto: owner, name: 'render', orig, wrapped });
        }
      }
    }
    const node = r.nodes && r.nodes[0];
    if (!node) return;
    const proto = Object.getPrototypeOf(node);
    if (!proto || proto === Object.prototype || this.patchedProtos.has(proto)) return;
    this.patchedProtos.add(proto);
    const wrap = (name, make) => {
      let owner = proto;
      while (owner && owner !== Object.prototype && !Object.prototype.hasOwnProperty.call(owner, name)) owner = Object.getPrototypeOf(owner);
      if (!owner || owner === Object.prototype) {
        // not on the class: wrap it on each node instead
        if (typeof node[name] === 'function' && !this.nodeWraps.some((w) => w.name === name)) this.nodeWraps.push({ name, make });
        return;
      }
      const orig = owner[name];
      if (typeof orig !== 'function' || orig.__galaxy) return;
      const wrapped = make(orig);
      wrapped.__galaxy = true;
      owner[name] = wrapped;
      this.patches.push({ proto: owner, name, orig, wrapped });
    };
    wrap('getFillColor', wrapFill);
    wrap('getSize', wrapSize);
    wrap('render', wrapRender);
  }

  patchNode(n) {
    for (const w of this.nodeWraps) {
      const cur = n[w.name];
      if (typeof cur !== 'function' || cur.__galaxy) continue;
      const wrapped = w.make(cur);
      wrapped.__galaxy = true;
      wrapped.__orig = cur;
      n[w.name] = wrapped;
    }
  }

  unpatchNode(n) {
    for (const key of ['getFillColor', 'getSize', 'render']) {
      if (!Object.prototype.hasOwnProperty.call(n, key)) continue;
      const cur = n[key];
      if (cur && cur.__galaxy && cur.__orig) n[key] = cur.__orig;
    }
  }

  /* ---- what counts as a MOC ---- */

  fileCache(id) {
    try {
      const f = this.app.vault.getAbstractFileByPath(id);
      return f ? this.app.metadataCache.getFileCache(f) : null;
    } catch (e) { return null; }
  }

  isMoc(id) {
    if (!/\.md$/i.test(id)) return false;
    const name = basename(id);
    if (this.mocRe && this.mocRe.test(name)) return true;
    if (this.mocCamel && this.mocCamel.test(name)) return true;
    if (!this.mocTag) return false;
    const cache = this.fileCache(id);
    if (!cache) return false;
    let tags = [];
    try { tags = (obsidian.getAllTags && obsidian.getAllTags(cache)) || []; } catch (e) { /* ignore */ }
    const want = '#' + this.mocTag;
    return tags.some((t) => { t = String(t).toLowerCase(); return t === want || t.startsWith(want + '/'); });
  }

  mocLabel(id) { return stripWord(basename(id), this.mocRe, this.mocCamel); }

  /** A MOC can choose its own arm colour with `galaxy-color: "#ff8800"` in its properties. */
  customColor(id) {
    const cache = this.fileCache(id);
    const fm = cache && cache.frontmatter;
    if (!fm) return null;
    return parseColor(fm['galaxy-color'] != null ? String(fm['galaxy-color']) : fm['galaxy-colour'] != null ? String(fm['galaxy-colour']) : '');
  }

  resolveCenter(ids) {
    const want = (this.settings.centerNote || '').trim().toLowerCase().replace(/\.md$/, '');
    if (!want) return null;
    let found = null;
    for (const id of ids) {
      if (!/\.md$/i.test(id)) continue;
      const path = id.toLowerCase().replace(/\.md$/, '');
      if (path === want) return id;
      if (!found && basename(id).toLowerCase() === want) found = id;
    }
    return found;
  }

  modelOptions(G) {
    const st = this.settings;
    return {
      isMoc: (id) => this.isMoc(id),
      name: basename,
      label: (id) => this.mocLabel(id),
      color: (id) => this.customColor(id),
      centerId: this.resolveCenter(G.ids),
      pitchDeg: st.pitch,
      spread: st.spread,
      sizeMult: G.sizeMult || 1,
      maxArms: 8,
      labels: st.armLabels,
      colors: this.memory.colors,
      rank: this.memory.rank,
    };
  }

  mocSignature(r) {
    let h = 0;
    for (const n of r.nodes) {
      if (n.type) continue;
      if (!this.isMoc(n.id)) continue;
      h = (Math.imul(h, 31) + hashStr(n.id)) | 0;
      const c = this.customColor(n.id);
      if (c != null) h = (h + c) | 0;
    }
    return h;
  }

  /** Colours for every file in the vault, for local graphs. */
  vaultColors() {
    if (this._vaultColors) return this._vaultColors;
    const map = new Map();
    try {
      const mc = this.app.metadataCache;
      const ids = [], types = [], index = new Map();
      const add = (id, type) => {
        let i = index.get(id);
        if (i === undefined) { i = ids.length; index.set(id, i); ids.push(id); types.push(type); }
        return i;
      };
      for (const f of this.app.vault.getMarkdownFiles()) add(f.path, '');
      const edges = [];
      const res = mc.resolvedLinks || {};
      for (const src in res) {
        const a = add(src, /\.md$/i.test(src) ? '' : 'attachment');
        for (const dst in res[src]) edges.push(a, add(dst, /\.md$/i.test(dst) ? '' : 'attachment'));
      }
      const unres = mc.unresolvedLinks || {};
      for (const src in unres) {
        const a = index.get(src);
        if (a === undefined) continue;
        for (const dst in unres[src]) edges.push(a, add(dst, 'unresolved'));
      }
      const G = { ids, types, weights: null, edges, index };
      const M = buildModel(G, Object.assign(this.modelOptions(G), { names: false })); // colours only
      this.remember(M, false);
      for (let i = 0; i < ids.length; i++) map.set(ids[i], M.color[i]);
    } catch (e) {
      console.warn('Galaxy Graph:', e);
    }
    this._vaultColors = map;
    return map;
  }
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

class GalaxySettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
    this.pending = 0;
  }

  /** Apply a change that was still waiting for a pause. */
  flush() {
    if (!this.pending) return;
    window.clearTimeout(this.pending);
    this.pending = 0;
    this.plugin.saveSettings();
  }

  hide() {
    this.flush();
  }

  display() {
    const { containerEl } = this;
    const st = this.plugin.settings;
    const save = () => { this.flush(); return this.plugin.saveSettings(); };
    // sliders and text boxes change many times a second; wait for a pause before rebuilding the galaxy
    const saveSoon = () => {
      if (this.pending) window.clearTimeout(this.pending);
      this.pending = window.setTimeout(() => { this.pending = 0; this.plugin.saveSettings(); }, 350);
    };
    containerEl.empty();

    const toggle = (name, desc, key) =>
      new Setting(containerEl).setName(name).setDesc(desc)
        .addToggle((t) => t.setValue(!!st[key]).onChange(async (v) => { st[key] = v; await save(); }));
    const slider = (name, desc, key, min, max, step) =>
      new Setting(containerEl).setName(name).setDesc(desc)
        .addSlider((sl) => sl.setLimits(min, max, step).setValue(st[key]).setDynamicTooltip()
          .onChange((v) => { st[key] = v; saveSoon(); }));
    const text = (name, desc, key, placeholder) =>
      new Setting(containerEl).setName(name).setDesc(desc)
        .addText((t) => t.setPlaceholder(placeholder || '').setValue(st[key] || '')
          .onChange((v) => { st[key] = v; saveSoon(); }));

    toggle('Galaxy graph', 'Switch between the galaxy and Obsidian\'s normal graph. The button in the corner of the graph view does the same.', 'enabled');
    toggle('On/off button', 'Show a small Galaxy on/off button in the top-left corner of the graph view.', 'switchButton');
    toggle('Arrange notes into a galaxy', 'Each MOC becomes a spiral arm in the main graph view. Turn off to keep the colours but let notes float freely.', 'layout');
    toggle('Glide into place', 'Notes swirl into position when the graph opens. Turn off to place them instantly.', 'animate');

    new Setting(containerEl).setHeading().setName('MOCs');
    text('MOC word', 'A note with this word in its name is a MOC and gets its own arm. It must be a whole word, so "Democracy" does not count.', 'mocText', 'MOC');
    text('MOC tag', 'Notes with this tag are MOCs too. Leave out the #.', 'mocTag', 'moc');
    text('Centre note', 'The note at the middle of the galaxy. Leave blank and the note that links to most of your MOCs (for example Home) is used.', 'centerNote', 'Home');

    new Setting(containerEl).setHeading().setName('Shape');
    slider('Arm winding', 'Lower winds the arms more tightly round the centre.', 'pitch', 10, 28, 1);
    slider('Spacing', 'How far apart the notes sit.', 'spread', 0.7, 1.8, 0.05);

    new Setting(containerEl).setHeading().setName('Look');
    slider('Arm glow', 'The soft light along each arm. 0 turns it off.', 'glow', 0, 1, 0.05);
    slider('Link lines', 'How visible the lines between notes are. 0 hides them until you touch a note.', 'links', 0, 1, 0.05);
    toggle('Clearer note names', 'Gives note names a thin dark edge so they stay readable over the glow, and draws them at a comfortable size on sharp screens such as an iPad.', 'names');
    toggle('Arm names', 'Write each MOC\'s name at the end of its arm.', 'armLabels');
    toggle('MOC list', 'A small list of your MOCs in the corner. Tap a name to light up just that arm.', 'legend');
    toggle('Dark space background', 'A plain, dark background behind the graph.', 'background');
    toggle('Faint stars', 'A few dim, still stars in the background.', 'stars');

    new Setting(containerEl).setHeading().setName('Help');
    new Setting(containerEl).setName('Tips')
      .setDesc('Tap a name in the MOC list to light up just that arm. Drag a note and it glides back. Give a MOC its own colour by adding a property called galaxy-color (for example #ff8800) to that note.');
    new Setting(containerEl).setName('Something not looking right?')
      .setDesc('Open the graph view, then copy this report and send it along with a screenshot. It lists settings and counts only, never note names or text.')
      .addButton((b) => b.setButtonText('Copy report').onClick(() => this.plugin.copyReport()));
  }
}

module.exports = GalaxyGraphPlugin;
// exposed for the test harness only
GalaxyGraphPlugin.internals = { buildModel, paintHaze, modelDigest, wordRegex, camelRegex, stripWord, relax, nameEms, LINK, NAME };
