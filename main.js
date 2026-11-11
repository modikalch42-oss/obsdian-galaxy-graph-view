/* Galaxy Graph — Obsidian plugin (plain JS, no build step needed) */
const { Plugin, PluginSettingTab, Setting } = require("obsidian");

const DEFAULTS = {
  enabled: true,
  colorMode: "degree", // degree | folder | rainbow
  starfield: true,
  nebula: true,
  twinkle: true,
  shootingStars: true,
  parallax: true,
  glow: true,
  starDensity: 1,
};

/* ---------- colour helpers ---------- */
function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function hsl(h, s, l) {
  s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return (Math.round(f(0) * 255) << 16) | (Math.round(f(8) * 255) << 8) | Math.round(f(4) * 255);
}
function mix(a, b, t) {
  const r = ((a >> 16) & 255) + (((b >> 16) & 255) - ((a >> 16) & 255)) * t;
  const g = ((a >> 8) & 255) + (((b >> 8) & 255) - ((a >> 8) & 255)) * t;
  const bl = (a & 255) + ((b & 255) - (a & 255)) * t;
  return (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(bl);
}
// cool violet outskirts -> blue -> cyan -> pink -> hot white-gold core
const RAMP = [
  [0.0, 0x6a4cff],
  [0.3, 0x3f8cff],
  [0.55, 0x55e0ff],
  [0.8, 0xffb8ef],
  [1.0, 0xfff4d2],
];
function ramp(t) {
  t = Math.max(0, Math.min(1, t));
  for (let i = 1; i < RAMP.length; i++) {
    if (t <= RAMP[i][0]) {
      const [t0, c0] = RAMP[i - 1];
      const [t1, c1] = RAMP[i];
      return mix(c0, c1, (t - t0) / (t1 - t0));
    }
  }
  return RAMP[RAMP.length - 1][1];
}

/* ---------- starfield ---------- */
const STAR_COLOURS = ["#ffffff", "#cfe0ff", "#a9c4ff", "#fff1c9", "#ffd2f0", "#c9b8ff"];

function makeSprite(colour) {
  const c = document.createElement("canvas");
  c.width = c.height = 32;
  const g = c.getContext("2d");
  const grad = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  grad.addColorStop(0, "#ffffff");
  grad.addColorStop(0.15, colour);
  grad.addColorStop(0.4, colour + "55");
  grad.addColorStop(1, colour + "00");
  g.fillStyle = grad;
  g.fillRect(0, 0, 32, 32);
  return c;
}

class Starfield {
  constructor(plugin, view) {
    this.plugin = plugin;
    this.view = view;
    this.host = view.contentEl;
    this.host.addClass("galaxy-graph-host");
    this.canvas = document.createElement("canvas");
    this.canvas.addClass("galaxy-starfield");
    this.host.prepend(this.canvas);
    this.ctx = this.canvas.getContext("2d");
    this.sprites = STAR_COLOURS.map(makeSprite);
    this.shooters = [];
    this.lastFrame = 0;
    this.dirty = true;
    this.lastPan = "";

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(this.host);
    this.resize();

    this.loop = this.loop.bind(this);
    this.raf = requestAnimationFrame(this.loop);
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = this.host.clientWidth, h = this.host.clientHeight;
    if (!w || !h) return;
    this.w = w; this.h = h; this.dpr = dpr;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.makeStars();
    this.makeNebula();
    this.dirty = true;
  }

  makeStars() {
    const s = this.plugin.settings;
    const count = Math.round(((this.w * this.h) / 2200) * s.starDensity);
    const seed = { v: 1337 };
    const rnd = () => ((seed.v = Math.imul(seed.v ^ (seed.v >>> 15), 2246822507) + 0x9e3779b9) >>> 0) / 4294967296;
    this.stars = [];
    for (let i = 0; i < count; i++) {
      const big = rnd() < 0.06;
      this.stars.push({
        x: rnd(), y: rnd(),
        r: big ? 2.5 + rnd() * 3.5 : 0.8 + rnd() * 1.8,
        a: big ? 0.8 + rnd() * 0.2 : 0.25 + rnd() * 0.6,
        sp: 0.6 + rnd() * 2.4,
        ph: rnd() * Math.PI * 2,
        c: Math.floor(rnd() * this.sprites.length),
        d: 0.015 + rnd() * 0.08, // parallax depth
      });
    }
  }

  makeNebula() {
    const c = document.createElement("canvas");
    c.width = this.canvas.width; c.height = this.canvas.height;
    const g = c.getContext("2d");
    g.scale(this.dpr, this.dpr);
    g.globalCompositeOperation = "lighter";
    const W = this.w, H = this.h, R = Math.max(W, H);
    const clouds = [
      [0.25, 0.3, 0.55, "120, 60, 255", 0.22],
      [0.75, 0.65, 0.6, "255, 70, 180", 0.14],
      [0.6, 0.2, 0.4, "40, 140, 255", 0.16],
      [0.3, 0.8, 0.45, "60, 220, 255", 0.1],
      [0.5, 0.5, 0.3, "255, 200, 150", 0.06],
    ];
    for (const [x, y, r, rgb, a] of clouds) {
      const grad = g.createRadialGradient(x * W, y * H, 0, x * W, y * H, r * R);
      grad.addColorStop(0, `rgba(${rgb}, ${a})`);
      grad.addColorStop(0.5, `rgba(${rgb}, ${a * 0.35})`);
      grad.addColorStop(1, `rgba(${rgb}, 0)`);
      g.fillStyle = grad;
      g.fillRect(0, 0, W, H);
    }
    this.nebula = c;
  }

  loop(t) {
    this.raf = requestAnimationFrame(this.loop);
    if (document.hidden || !this.w) return;
    if (t - this.lastFrame < 33) return; // ~30fps, kind to iPad batteries
    const s = this.plugin.settings;
    const r = this.view.renderer;
    const panKey = r ? `${r.panX}|${r.panY}|${r.scale}` : "";
    const animated = s.twinkle || s.shootingStars || this.shooters.length;
    const panned = s.parallax && panKey !== this.lastPan;
    if (!animated && !panned && !this.dirty) return;
    this.lastFrame = t;
    this.lastPan = panKey;
    this.dirty = false;
    this.draw(t / 1000);
  }

  draw(time) {
    const s = this.plugin.settings;
    const ctx = this.ctx, W = this.w, H = this.h;
    ctx.clearRect(0, 0, W, H);

    if (s.nebula && this.nebula) {
      ctx.globalAlpha = s.twinkle ? 0.85 + 0.15 * Math.sin(time * 0.25) : 1;
      ctx.drawImage(this.nebula, 0, 0, W, H);
    }

    const r = this.view.renderer;
    const px = s.parallax && r && isFinite(r.panX) ? r.panX : 0;
    const py = s.parallax && r && isFinite(r.panY) ? r.panY : 0;

    for (const st of this.stars) {
      const x = (((st.x * W + px * st.d) % W) + W) % W;
      const y = (((st.y * H + py * st.d) % H) + H) % H;
      const a = s.twinkle ? st.a * (0.55 + 0.45 * Math.sin(time * st.sp + st.ph)) : st.a;
      ctx.globalAlpha = a;
      const size = st.r * 4;
      ctx.drawImage(this.sprites[st.c], x - size / 2, y - size / 2, size, size);
    }

    if (s.shootingStars) this.drawShooters(time);
    ctx.globalAlpha = 1;
  }

  drawShooters(time) {
    const ctx = this.ctx, W = this.w, H = this.h;
    if (Math.random() < 0.006 && this.shooters.length < 2) {
      const ang = Math.PI * (0.15 + Math.random() * 0.2);
      this.shooters.push({
        x: Math.random() * W * 0.8, y: Math.random() * H * 0.4,
        vx: Math.cos(ang) * (9 + Math.random() * 6),
        vy: Math.sin(ang) * (9 + Math.random() * 6),
        life: 1,
      });
    }
    for (const sh of this.shooters) {
      sh.x += sh.vx; sh.y += sh.vy; sh.life -= 0.025;
      const tail = 9;
      const grad = ctx.createLinearGradient(sh.x, sh.y, sh.x - sh.vx * tail, sh.y - sh.vy * tail);
      grad.addColorStop(0, `rgba(255,255,255,${Math.max(0, sh.life)})`);
      grad.addColorStop(0.3, `rgba(180,200,255,${Math.max(0, sh.life) * 0.5})`);
      grad.addColorStop(1, "rgba(150,120,255,0)");
      ctx.globalAlpha = 1;
      ctx.strokeStyle = grad;
      ctx.lineWidth = 2;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(sh.x, sh.y);
      ctx.lineTo(sh.x - sh.vx * tail, sh.y - sh.vy * tail);
      ctx.stroke();
    }
    this.shooters = this.shooters.filter((sh) => sh.life > 0 && sh.x < W + 200 && sh.y < H + 200);
  }

  refresh() {
    this.makeStars();
    this.dirty = true;
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.canvas.remove();
    this.host.removeClass("galaxy-graph-host");
  }
}

/* ---------- plugin ---------- */
module.exports = class GalaxyGraphPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULTS, await this.loadData());
    this.starfields = new Map();
    this.computeDegrees();

    this.registerEvent(this.app.metadataCache.on("resolved", () => this.computeDegrees()));
    this.registerInterval(window.setInterval(() => this.tick(), 400));
    this.addSettingTab(new GalaxySettingTab(this.app, this));

    this.addCommand({
      id: "toggle-galaxy-graph",
      name: "Toggle galaxy graph",
      callback: async () => {
        this.settings.enabled = !this.settings.enabled;
        await this.saveSettings();
      },
    });

    this.app.workspace.onLayoutReady(() => this.applyAll());
  }

  onunload() {
    this.teardown();
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.applyAll();
  }

  applyAll() {
    document.body.toggleClass("galaxy-graph-on", this.settings.enabled);
    document.body.toggleClass("galaxy-glow", this.settings.enabled && this.settings.glow);
    this.app.workspace.trigger("css-change");
    if (!this.settings.enabled) {
      this.teardown(true);
      return;
    }
    for (const sf of this.starfields.values()) sf.refresh();
    this.tick(true);
  }

  teardown(keepBodyClassesHandled) {
    for (const sf of this.starfields.values()) sf.destroy();
    this.starfields.clear();
    for (const view of this.graphViews()) this.unpatch(view.renderer);
    if (!keepBodyClassesHandled) {
      document.body.removeClass("galaxy-graph-on");
      document.body.removeClass("galaxy-glow");
      this.app.workspace.trigger("css-change");
    }
  }

  graphViews() {
    const ws = this.app.workspace;
    return [...ws.getLeavesOfType("graph"), ...ws.getLeavesOfType("localgraph")]
      .map((l) => l.view)
      .filter((v) => v && v.contentEl);
  }

  computeDegrees() {
    const deg = new Map();
    const links = this.app.metadataCache.resolvedLinks || {};
    for (const src in links) {
      for (const dst in links[src]) {
        deg.set(src, (deg.get(src) || 0) + 1);
        deg.set(dst, (deg.get(dst) || 0) + 1);
      }
    }
    let max = 1;
    for (const v of deg.values()) if (v > max) max = v;
    this.degrees = deg;
    this.maxDeg = max;
  }

  colourFor(node) {
    const id = String(node.id || "");
    const h = hash(id);
    if (node.type === "tag") return hsl(320 + (h % 30), 90, 70);
    if (node.type === "attachment") return hsl(25 + (h % 20), 95, 66);
    if (node.type === "unresolved") return 0x565c82;

    const mode = this.settings.colorMode;
    if (mode === "rainbow") return hsl(h % 360, 88, 66);

    if (mode === "folder") {
      const folder = id.includes("/") ? id.split("/")[0] : "(root)";
      const hue = ((hash(folder) * 0.61803398875) % 1) * 360;
      return hsl(hue, 85, 58 + (h % 15));
    }

    // degree: hubs glow white-gold like galactic cores, leaves are cool blue/violet
    const d = this.degrees.get(id) || 0;
    if (d === 0) return mix(0x7d6bd6, hsl(h % 360, 70, 70), 0.2);
    const t = Math.log(1 + d) / Math.log(1 + this.maxDeg);
    return mix(ramp(t), hsl(h % 360, 90, 70), 0.12);
  }

  patch(renderer) {
    if (!renderer || !Array.isArray(renderer.nodes)) return;
    const plugin = this;
    let changed = false;
    for (const node of renderer.nodes) {
      const rgb = this.colourFor(node);
      if (node.__galaxyRgb === rgb && node.__galaxyPatched) continue;
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
      if (node.getFillColor !== node.__galaxyOrig && node.__galaxyOrig) node.getFillColor = node.__galaxyOrig;
      delete node.__galaxyOrig;
      delete node.__galaxyRgb;
      delete node.__galaxyPatched;
    }
    if (typeof renderer.changed === "function") renderer.changed();
  }

  tick() {
    if (!this.settings.enabled) return;
    const views = this.graphViews();
    const live = new Set(views);

    for (const [view, sf] of this.starfields) {
      if (!live.has(view) || !view.contentEl.isConnected || !this.settings.starfield) {
        sf.destroy();
        this.starfields.delete(view);
      }
    }

    for (const view of views) {
      try { this.patch(view.renderer); } catch (e) { console.warn("Galaxy Graph:", e); }
      if (this.settings.starfield && !this.starfields.has(view)) {
        this.starfields.set(view, new Starfield(this, view));
      }
      // make sure the graph canvas itself is see-through so space shows behind it
      try {
        const pr = view.renderer && view.renderer.px && view.renderer.px.renderer;
        if (pr && pr.background && pr.background.alpha !== 0) pr.background.alpha = 0;
      } catch (e) { /* ignore */ }
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
    containerEl.empty();

    const toggle = (name, desc, key) =>
      new Setting(containerEl).setName(name).setDesc(desc).addToggle((t) =>
        t.setValue(s[key]).onChange(async (v) => { s[key] = v; await this.plugin.saveSettings(); })
      );

    toggle("Enabled", "Turn the galaxy theme on or off.", "enabled");

    new Setting(containerEl)
      .setName("Node colours")
      .setDesc("Connections: hubs burn white-gold, loose notes are blue/violet. Folder: one colour per top-level folder. Rainbow: every note its own colour.")
      .addDropdown((d) =>
        d.addOptions({ degree: "By connections (galaxy core)", folder: "By folder", rainbow: "Rainbow" })
          .setValue(s.colorMode)
          .onChange(async (v) => { s.colorMode = v; await this.plugin.saveSettings(); })
      );

    toggle("Starfield", "Stars behind the graph.", "starfield");
    toggle("Nebula clouds", "Purple, pink and blue gas clouds.", "nebula");
    toggle("Twinkle", "Animate the stars. Turn off to save battery.", "twinkle");
    toggle("Shooting stars", "Occasional meteors.", "shootingStars");
    toggle("Parallax", "Stars drift slightly as you pan the graph.", "parallax");
    toggle("Glow", "Bloom around nodes. Can be slow on very large graphs.", "glow");

    new Setting(containerEl)
      .setName("Star density")
      .addSlider((sl) =>
        sl.setLimits(0.2, 3, 0.1).setValue(s.starDensity).setDynamicTooltip()
          .onChange(async (v) => { s.starDensity = v; await this.plugin.saveSettings(); })
      );
  }
}
