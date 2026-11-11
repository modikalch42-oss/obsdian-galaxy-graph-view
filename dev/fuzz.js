// Fuzz the layout model with odd and random graphs: it must never throw or produce a bad position.
const Module = require('module'); const orig = Module._load;
Module._load = (r, ...a) => (r === 'obsidian' ? { Plugin: class {}, PluginSettingTab: class {}, Setting: class {} } : orig(r, ...a));
const { buildModel, modelDigest, wordRegex, stripWord } = require('../main.js').internals;
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const base = (id) => id.split('/').pop().replace(/\.md$/, '');
const re = wordRegex('MOC');
function run(ids, types, edges, extra = {}) {
  const index = new Map(ids.map((id, i) => [id, i]));
  const G = { ids, types, weights: null, edges, index };
  const o = Object.assign({ isMoc: (id) => /\.md$/.test(id) && re.test(base(id)), name: base, label: (id) => stripWord(base(id), re), color: () => null, centerId: null, pitchDeg: 17, spread: 1, sizeMult: 1, maxArms: 8, labels: true, colors: {}, rank: [] }, extra);
  const M = buildModel(G, o);
  for (let i = 0; i < ids.length * 2; i++) if (!Number.isFinite(M.pos[i])) throw new Error('bad position for ' + ids[i >> 1]);
  for (let i = 0; i < ids.length; i++) if (!(M.color[i] >= 0 && M.color[i] <= 0xffffff)) throw new Error('bad colour');
  if (!Number.isFinite(M.Rfit) || !(M.Rfit > 0) || !Number.isFinite(M.extent)) throw new Error('bad extent');
  modelDigest(M);
  // deterministic: same input, same output
  const M2 = buildModel(G, o);
  if (modelDigest(M2) !== modelDigest(M)) throw new Error('not deterministic');
  // feeding its own memory back in must not change anything (no flip-flopping between sessions)
  const mem = { colors: {}, rank: M.rank || [] }; for (const sg of M.segs) mem.colors[sg.id] = sg.ci;
  const M3 = buildModel(G, Object.assign({}, o, mem));
  if (modelDigest(M3) !== modelDigest(M)) throw new Error('memory changes the result');
  return M;
}
let n = 0;
const cases = {
  empty: () => run([], [], []),
  one: () => run(['A.md'], [''], []),
  two: () => run(['A.md', 'B.md'], ['', ''], [0, 1]),
  selfLoops: () => run(['A.md', 'B.md', 'C MOC.md'], ['', '', ''], [0, 0, 1, 1, 2, 0, 2, 1, 2, 0]),
  onlyMocs: () => run(['A MOC.md', 'B MOC.md', 'C MOC.md'], ['', '', ''], []),
  oneMoc: () => run(['X MOC.md', 'a.md', 'b.md', 'c.md', 'd.md'], ['', '', '', '', ''], [0, 1, 0, 2, 0, 3, 0, 4]),
  oneMocBig: () => { const ids = ['X MOC.md'], t = [''], e = []; for (let i = 1; i < 60; i++) { ids.push('n' + i + '.md'); t.push(''); e.push(i < 8 ? 0 : 1 + (i % 7), i); } return run(ids, t, e); },
  tagsOnly: () => run(['#a', '#b', 'n1.md', 'n2.md'], ['tag', 'tag', '', ''], [2, 0, 3, 0, 3, 1]),
  unresolved: () => run(['Home.md', 'A MOC.md', 'B MOC.md', 'x', 'y'], ['', '', '', 'unresolved', 'unresolved'], [0, 1, 0, 2, 1, 3, 2, 4]),
  star: () => { const ids = ['Hub.md'], t = [''], e = []; for (let i = 1; i < 200; i++) { ids.push('leaf' + i + '.md'); t.push(''); e.push(0, i); } return run(ids, t, e); },
  chain: () => { const ids = [], t = [], e = []; for (let i = 0; i < 80; i++) { ids.push('c' + i + '.md'); t.push(''); if (i) e.push(i - 1, i); } return run(ids, t, e); },
  centre: () => run(['Home.md', 'A MOC.md', 'B MOC.md', 'n.md'], ['', '', '', ''], [0, 1, 0, 2, 1, 3], { centerId: 'n.md' }),
  manyMocs: () => { const ids = ['Home.md'], t = [''], e = []; for (let m = 0; m < 40; m++) { const mi = ids.length; ids.push('M' + m + ' MOC.md'); t.push(''); e.push(0, mi); for (let k = 0; k < (m % 5) + 1; k++) { ids.push('m' + m + 'n' + k + '.md'); t.push(''); e.push(mi, ids.length - 1); } } return run(ids, t, e); },
  hugeSizes: () => run(['Home.md', 'A MOC.md', 'B MOC.md', 'a.md', 'b.md'], ['', '', '', '', ''], [0, 1, 0, 2, 1, 3, 2, 4], { sizeMult: 5, spread: 2.5, pitchDeg: 30 }),
  tinySizes: () => run(['Home.md', 'A MOC.md', 'B MOC.md', 'a.md', 'b.md'], ['', '', '', '', ''], [0, 1, 0, 2, 1, 3, 2, 4], { sizeMult: 0.1, spread: 0.5, pitchDeg: 8 }),
};
for (const k in cases) { try { const M = cases[k](); n++; console.log('ok  ', k.padEnd(10), 'mode', M.mode, 'arms', M.arms.length, 'Rfit', Math.round(M.Rfit)); } catch (e) { console.log('FAIL', k, e.stack.split('\n').slice(0, 3).join(' | ')); process.exitCode = 1; } }
// random graphs
let worst = 0;
for (let seed = 1; seed <= 400; seed++) {
  const r = rng(seed);
  const N = 1 + Math.floor(r() * (seed % 20 === 0 ? 3000 : 220));
  const ids = [], types = [];
  const mocs = Math.floor(r() * 12);
  for (let i = 0; i < N; i++) { const roll = r(); const folder = 'F' + Math.floor(r() * 4); if (i < mocs) { ids.push(`${folder}/T${i} MOC.md`); types.push(''); } else if (roll < 0.05) { ids.push('#tag' + i); types.push('tag'); } else if (roll < 0.1) { ids.push('img' + i + '.png'); types.push('attachment'); } else if (roll < 0.15) { ids.push('ghost' + i); types.push('unresolved'); } else { ids.push(`${folder}/n${i}.md`); types.push(''); } }
  if (r() < 0.5) { ids.push('Home.md'); types.push(''); }
  const edges = []; const E = Math.floor(r() * N * 2.5);
  for (let k = 0; k < E; k++) { const a = Math.floor(r() * ids.length), b = r() < 0.4 ? Math.floor(r() * Math.max(1, mocs)) : Math.floor(r() * ids.length); edges.push(a, b); }
  if (ids[ids.length - 1] === 'Home.md') for (let i = 0; i < mocs; i++) if (r() < 0.8) edges.push(ids.length - 1, i);
  try {
    const t0 = Date.now();
    const M = run(ids, types, edges, { sizeMult: 0.5 + r() * 2, spread: 0.7 + r(), pitchDeg: 10 + r() * 18 });
    worst = Math.max(worst, (Date.now() - t0) / 3);
    // overlap check
    let min = Infinity; const P = M.pos; const lim = M.N;
    for (let i = 0; i < lim; i++) for (let j = i + 1; j < lim; j++) { const d = Math.hypot(P[2 * i] - P[2 * j], P[2 * i + 1] - P[2 * j + 1]); if (d < min) min = d; }
    if (M.N > 1 && min < 0.3 * M.s) throw new Error('notes too close: ' + (min / M.s).toFixed(2) + ' of the normal gap, N=' + M.N);
    n++;
  } catch (e) { console.log('FAIL seed', seed, 'N', ids.length, e.stack.split('\n').slice(0, 3).join(' | ')); process.exitCode = 1; }
}
console.log(n, 'graphs laid out; slowest build', Math.round(worst), 'ms');
