/* Galaxy Graph — Obsidian plugin (plain JS, no build step needed)
 *
 * Arranges the global graph into a spiral galaxy:
 *   - each MOC gets its own spiral arm (and its own colour)
 *   - notes linked to that MOC sit along its arm, most-connected nearest the core
 *   - a "MOC of MOCs" (a MOC that links to other MOCs) sits at the galactic core
 *   - notes that belong to no MOC drift in a faint halo around the disc
 */
const { Plugin, PluginSettingTab, Setting, getAllTags, debounce } = require("obsidian");

const DEFAULTS = {
  enabled: true,
  spiralLayout: true,
  mocText: "MOC",      // a note whose name contains this is a MOC
  mocTag: "moc",       // ...or a note with this tag
  autoHubs: 6,         // if no MOCs are found, use this many of the most-linked notes
  tightness: 0.45,     // spiral pitch: smaller = more tightly wound arms
  spacing: 18,         // distance between notes along an arm
  softBackground: true,
  backgroundStars: true,
};

/* ---------- helpers ---------- */
function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
// two deterministic uniform numbers in (0,1) from a string
function rand2(str) {
  const a = hash(str), b = hash(str + "#");
  return [(a + 1) / 4294967297, (b + 1) / 4294967297];
}
// deterministic gaussian pair (Box–Muller)
function gauss2(str) {
  const [u, v] = rand2(str);
  const m = Math.sqrt(-2 * Math.log(u));
  return [m * Math.cos(2 * Math.PI * v), m * Math.sin(2 * Math.PI * v)];
}
function hsl(h, s, l) {
  s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return (Math.round(f(0) * 255) << 16) | (Math.round(f(8) * 255) << 8) | Math.round(f(4) * 255);
}
const GOLDEN_ANGLE = 137.508;

const COLOURS = {
  core: 0xfff1d6,
  bulge: 0xe6d6b4,
  field: 0x7d7b98,
  tag: 0xc29ad3,
  attachment: 0xd3b08c,
  unresolved: 0x4c4b63,
};

/* ---------- galaxy layout ---------- */
function buildGalaxy(app, s) {
  const files = app.vault.getMarkdownFiles();
  const links = app.metadataCache.resolvedLinks || {};

  // undirected neighbour sets + degree
  const nbrs = new Map();
  const add = (a, b) => {
    if (!nbrs.has(a)) nbrs.set(a, new Set());
    nbrs.get(a).add(b);
  };
  for (const src in links) for (const dst in links[src]) {
    if (src === dst) continue;
    add(src, dst); add(dst, src);
  }
  const deg = (p) => (nbrs.get(p) ? nbrs.get(p).size : 0);

  // --- find MOCs ---
  const text = (s.mocText || "").trim().toLowerCase();
  const tag = (s.mocTag || "").trim().replace(/^#/, "").toLowerCase();
  const isMoc = (f) => {
    if (text && f.basename.toLowerCase().includes(text)) return true;
    if (!tag) return false;
    const cache = app.metadataCache.getFileCache(f);
    const tags = cache ? getAllTags(cache) || [] : [];
    return tags.some((t) => {
      t = t.toLowerCase();
      return t === "#" + tag || t.startsWith("#" + tag + "/");
    });
  };
  let mocs = files.filter(isMoc).map((f) => f.path);
  if (mocs.length === 0) {
    mocs = files.map((f) => f.path)
      .filter((p) => deg(p) >= 3)
      .sort((a, b) => deg(b) - deg(a) || a.localeCompare(b))
      .slice(0, Math.max(1, s.autoHubs));
  }
  const mocSet = new Set(mocs);

  // --- core: the MOC that links to the most other MOCs (needs at least 2) ---
  let core = null, best = 1;
  for (const m of mocs) {
    let n = 0;
    for (const x of nbrs.get(m) || []) if (mocSet.has(x)) n++;
    if (n > best || (n === best && core && m < core)) { best = n; core = m; }
  }

  // --- assign every note to a MOC ---
  const assign = new Map();
  for (const m of mocs) assign.set(m, m);
  const sortedMocs = [...mocs].sort();
  const allPaths = new Set(files.map((f) => f.path));
  for (const p of nbrs.keys()) allPaths.add(p);

  for (const p of allPaths) {
    if (assign.has(p)) continue;
    const cands = sortedMocs.filter((m) => nbrs.get(p) && nbrs.get(p).has(m));
    if (!cands.length) continue;
    const nonCore = cands.filter((m) => m !== core);
    const pool = nonCore.length ? nonCore : cands;
    // prefer a MOC that actually lists this note
    const listed = pool.find((m) => links[m] && links[m][p]);
    assign.set(p, listed || pool[0]);
  }
  // second pass: notes one step removed join their neighbours' majority MOC
  const second = new Map();
  for (const p of allPaths) {
    if (assign.has(p)) continue;
    const count = new Map();
    for (const q of nbrs.get(p) || []) {
      const m = assign.get(q);
      if (m && m !== core) count.set(m, (count.get(m) || 0) + 1);
    }
    let pick = null, pc = 0;
    for (const [m, c] of count) if (c > pc || (c === pc && m < pick)) { pick = m; pc = c; }
    if (pick) second.set(p, pick);
  }
  for (const [p, m] of second) assign.set(p, m);

  // --- group members ---
  const arms = sortedMocs.filter((m) => m !== core);
  const members = new Map(arms.map((m) => [m, []]));
  const bulge = [];
  for (const [p, m] of assign) {
    if (p === m) continue;
    if (m === core) bulge.push(p);
    else members.get(m).push(p);
  }
  const byImportance = (a, b) => deg(b) - deg(a) || a.localeCompare(b);
  bulge.sort(byImportance);
  for (const list of members.values()) list.sort(byImportance);

  // --- positions ---
  const pos = new Map();
  const armOf = new Map();   // path -> arm index
  const along = new Map();   // path -> 0..1 how far out along its arm
  const sp = s.spacing;
  const b = s.tightness;
  const A = Math.max(1, arms.length);

  // bulge: sunflower pattern around the core
  if (core) pos.set(core, { x: 0, y: 0 });
  bulge.forEach((p, i) => {
    const r = sp * 0.75 * Math.sqrt(i + 1);
    const a = (i + 1) * GOLDEN_ANGLE * Math.PI / 180;
    pos.set(p, { x: r * Math.cos(a), y: r * Math.sin(a) });
  });
  const bulgeR = bulge.length ? sp * 0.75 * Math.sqrt(bulge.length) : 0;
  const r0 = Math.max(sp * 3 + A * sp * 0.6, bulgeR + sp * 2.5);

  // arms: logarithmic spirals r = r0 * e^(b·φ), notes spaced evenly along the curve
  const k = b / Math.sqrt(1 + b * b); // dr per unit arc length
  let rMax = r0;
  arms.forEach((m, a) => {
    const theta = (2 * Math.PI * a) / A;
    pos.set(m, { x: r0 * Math.cos(theta), y: r0 * Math.sin(theta) });
    armOf.set(m, a);
    along.set(m, 0);
    const list = members.get(m);
    list.forEach((p, i) => {
      const r = r0 + (i + 1) * sp * k;
      const phi = theta + Math.log(r / r0) / b;
      // spread notes across the arm so it reads as a band, not a line
      const [g1, g2] = gauss2(p);
      const width = sp * 0.35 + r * 0.035;
      const nx = Math.cos(phi), ny = Math.sin(phi);           // radial direction
      const tx = -Math.sin(phi), ty = Math.cos(phi);          // tangent direction
      const x = r * nx + g1 * width * nx * 0.5 + g2 * width * tx * 0.5;
      const y = r * ny + g1 * width * ny * 0.5 + g2 * width * ty * 0.5;
      pos.set(p, { x, y });
      armOf.set(p, a);
      along.set(p, list.length > 1 ? (i + 1) / list.length : 1);
      if (r > rMax) rMax = r;
    });
  });

  const armHue = arms.map((_, a) => (215 + a * GOLDEN_ANGLE) % 360);
  return { pos, armOf, along, armHue, mocSet, core, r0, rMax, assign };
}

/* ---------- plugin ---------- */
module.exports = class GalaxyGraphPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULTS, await this.loadData());
    this.layoutVersion = 0;
    this.galaxy = null;
    this.hosts = new Set();

    this.rebuild = debounce(() => this.computeGalaxy(), 1500, true);
    this.registerEvent(this.app.metadataCache.on("resolved", () => this.rebuild()));
    this.registerInterval(window.setInterval(() => this.tick(), 500));
    this.addSettingTab(new GalaxySettingTab(this.app, this));

    this.addCommand({
      id: "toggle-galaxy-graph",
      name: "Toggle galaxy graph",
      callback: async () => {
        this.settings.enabled = !this.settings.enabled;
        await this.saveSettings();
      },
    });
    this.addCommand({
      id: "rearrange-galaxy",
      name: "Re-arrange graph into galaxy",
      callback: () => { this.computeGalaxy(); this.tick(); },
    });

    this.app.workspace.onLayoutReady(() => {
      this.computeGalaxy();
      this.applyAll();
    });
  }

  onunload() {
    this.teardown();
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.computeGalaxy();
    this.applyAll();
  }

  computeGalaxy() {
    try {
      this.galaxy = buildGalaxy(this.app, this.settings);
      this.layoutVersion++;
    } catch (e) {
      console.warn("Galaxy Graph: layout failed", e);
    }
  }

  applyAll() {
    const s = this.settings;
    document.body.toggleClass("galaxy-graph-on", s.enabled);
    document.body.toggleClass("galaxy-bg", s.enabled && s.softBackground);
    document.body.toggleClass("galaxy-bg-stars", s.enabled && s.softBackground && s.backgroundStars);
    this.app.workspace.trigger("css-change");
    if (!s.enabled) {
      this.teardown(true);
      return;
    }
    if (!s.spiralLayout) for (const v of this.graphViews("graph")) this.releaseLayout(v.renderer);
    this.tick();
  }

  teardown(keepBody) {
    for (const v of this.graphViews()) {
      this.unpatch(v.renderer);
      this.releaseLayout(v.renderer);
    }
    for (const el of this.hosts) el.removeClass("galaxy-graph-host");
    this.hosts.clear();
    if (!keepBody) {
      document.body.removeClass("galaxy-graph-on");
      document.body.removeClass("galaxy-bg");
      document.body.removeClass("galaxy-bg-stars");
      this.app.workspace.trigger("css-change");
    }
  }

  graphViews(only) {
    const ws = this.app.workspace;
    const types = only ? [only] : ["graph", "localgraph"];
    return types.flatMap((t) => ws.getLeavesOfType(t))
      .map((l) => l.view)
      .filter((v) => v && v.contentEl);
  }

  /* ----- colours ----- */
  colourFor(node) {
    const id = String(node.id || "");
    if (node.type === "tag") return COLOURS.tag;
    if (node.type === "attachment") return COLOURS.attachment;
    if (node.type === "unresolved") return COLOURS.unresolved;
    const g = this.galaxy;
    if (!g) return COLOURS.field;
    if (id === g.core) return COLOURS.core;
    const a = g.armOf.get(id);
    if (a === undefined) {
      return g.assign.get(id) === g.core && g.core ? COLOURS.bulge : COLOURS.field;
    }
    const h = g.armHue[a];
    if (g.mocSet.has(id)) return hsl(h, 70, 82);          // the MOC itself: bright
    const t = g.along.get(id) || 0;
    return hsl(h, 58 - 14 * t, 70 - 10 * t);               // fades gently outwards
  }

  patch(renderer) {
    if (!renderer || !Array.isArray(renderer.nodes)) return;
    let changed = false;
    for (const node of renderer.nodes) {
      const rgb = this.colourFor(node);
      if (node.__galaxyPatched && node.__galaxyRgb === rgb) continue;
      node.__galaxyRgb = rgb;
      if (!node.__galaxyPatched) {
        node.__galaxyOrig = node.getFillColor;
        node.getFillColor = function () {
          let a = 1;
          try {
            const o = this.__galaxyOrig ? this.__galaxyOrig.call(this) : null;
            if (o && typeof o.a === "number") a = o.a; // keep Obsidian's hover fading
          } catch (e) { /* ignore */ }
          return { a, rgb: this.__galaxyRgb };
        };
        node.__galaxyPatched = true;
      }
      changed = true;
    }
    if (changed && typeof renderer.changed === "function") renderer.changed();
  }

  unpatch(renderer) {
    if (!renderer || !Array.isArray(renderer.nodes)) return;
    for (const node of renderer.nodes) {
      if (!node.__galaxyPatched) continue;
      delete node.getFillColor;
      if (node.__galaxyOrig && node.getFillColor !== node.__galaxyOrig) node.getFillColor = node.__galaxyOrig;
      delete node.__galaxyOrig;
      delete node.__galaxyRgb;
      delete node.__galaxyPatched;
    }
    if (typeof renderer.changed === "function") renderer.changed();
  }

  /* ----- layout ----- */
  positionFor(id) {
    const g = this.galaxy;
    const p = g.pos.get(id);
    if (p) return p;
    // notes with no MOC: a faint halo scattered over the disc
    const [u, v] = rand2(id);
    const r = g.r0 * 0.6 + Math.sqrt(u) * (g.rMax * 1.15 - g.r0 * 0.6);
    const a = v * Math.PI * 2;
    return { x: r * Math.cos(a), y: r * Math.sin(a) };
  }

  applyLayout(renderer) {
    if (!this.galaxy || !renderer || !renderer.worker || !Array.isArray(renderer.nodes)) return;
    const key = this.layoutVersion + ":" + renderer.nodes.length;
    if (renderer.worker.__galaxyKey === key) return;
    renderer.worker.__galaxyKey = key;
    for (const node of renderer.nodes) {
      const p = this.positionFor(String(node.id));
      renderer.worker.postMessage({ forceNode: { id: node.id, x: p.x, y: p.y } });
      node.x = p.x;
      node.y = p.y;
    }
    try { renderer.worker.postMessage({ run: true, alpha: 0.1 }); } catch (e) { /* ignore */ }
    if (typeof renderer.changed === "function") renderer.changed();
  }

  releaseLayout(renderer) {
    if (!renderer || !renderer.worker || !renderer.worker.__galaxyKey) return;
    delete renderer.worker.__galaxyKey;
    if (!Array.isArray(renderer.nodes)) return;
    for (const node of renderer.nodes) {
      renderer.worker.postMessage({ forceNode: { id: node.id, x: null, y: null } });
    }
    try { renderer.worker.postMessage({ run: true, alpha: 0.3 }); } catch (e) { /* ignore */ }
  }

  tick() {
    if (!this.settings.enabled) return;
    for (const view of this.graphViews()) {
      if (!view.contentEl.hasClass("galaxy-graph-host")) {
        view.contentEl.addClass("galaxy-graph-host");
        this.hosts.add(view.contentEl);
      }
      try {
        this.patch(view.renderer);
        if (this.settings.spiralLayout && view.getViewType() === "graph") this.applyLayout(view.renderer);
      } catch (e) {
        console.warn("Galaxy Graph:", e);
      }
    }
  }
};

class GalaxySettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    const s = this.plugin.settings;
    const save = () => this.plugin.saveSettings();
    containerEl.empty();

    const toggle = (name, desc, key) =>
      new Setting(containerEl).setName(name).setDesc(desc).addToggle((t) =>
        t.setValue(s[key]).onChange(async (v) => { s[key] = v; await save(); })
      );

    toggle("Enabled", "Turn the galaxy theme on or off.", "enabled");
    toggle("Spiral galaxy layout", "Arrange the global graph into spiral arms, one per MOC. Turn off to let notes float freely again.", "spiralLayout");

    new Setting(containerEl).setHeading().setName("MOCs");
    new Setting(containerEl)
      .setName("MOC name contains")
      .setDesc("Notes whose name contains this text count as MOCs. Leave blank to ignore names.")
      .addText((t) => t.setValue(s.mocText).onChange(async (v) => { s.mocText = v; await save(); }));
    new Setting(containerEl)
      .setName("MOC tag")
      .setDesc("Notes with this tag also count as MOCs (without the #).")
      .addText((t) => t.setValue(s.mocTag).onChange(async (v) => { s.mocTag = v; await save(); }));
    new Setting(containerEl)
      .setName("Fallback hubs")
      .setDesc("If no MOCs are found, use this many of your most-linked notes as arms instead.")
      .addSlider((sl) => sl.setLimits(2, 16, 1).setValue(s.autoHubs).setDynamicTooltip()
        .onChange(async (v) => { s.autoHubs = v; await save(); }));

    new Setting(containerEl).setHeading().setName("Shape");
    new Setting(containerEl)
      .setName("Spiral tightness")
      .setDesc("Lower winds the arms more tightly.")
      .addSlider((sl) => sl.setLimits(0.12, 0.6, 0.02).setValue(s.tightness).setDynamicTooltip()
        .onChange(async (v) => { s.tightness = v; await save(); }));
    new Setting(containerEl)
      .setName("Spacing")
      .setDesc("Distance between notes along an arm.")
      .addSlider((sl) => sl.setLimits(8, 40, 1).setValue(s.spacing).setDynamicTooltip()
        .onChange(async (v) => { s.spacing = v; await save(); }));

    new Setting(containerEl).setHeading().setName("Background");
    toggle("Soft space background", "A calm dark-blue background behind the graph.", "softBackground");
    toggle("Faint stars", "A few dim, still stars in the background.", "backgroundStars");
  }
}
