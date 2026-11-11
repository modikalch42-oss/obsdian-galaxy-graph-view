/*
 * A stand-in for Obsidian's graph view, built on the same drawing library
 * (PixiJS 7) and following the published typings for Obsidian 1.15's graph
 * internals: renderer.nodes / links / hanger / px / worker, node.getFillColor /
 * getSize / render, forceNode messages, setPan / setScale / zoomTo and so on.
 */
(function () {
  const PIXI = window.PIXI;
  const DPR = () => window.devicePixelRatio || 1;
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };

  function readColor(parent, cls) {
    const el = document.createElement('div');
    el.className = 'graph-view ' + cls;
    parent.appendChild(el);
    const cs = getComputedStyle(el);
    const m = cs.color.match(/rgba?\(([^)]+)\)/);
    const parts = m ? m[1].split(/[, /]+/).filter(Boolean).map(parseFloat) : [128, 128, 128, 1];
    const a = (parts.length > 3 ? parts[3] : 1) * parseFloat(cs.opacity || '1');
    el.remove();
    return { a, rgb: (Math.round(parts[0]) << 16) | (Math.round(parts[1]) << 8) | Math.round(parts[2]) };
  }

  /* ---------------- layout worker: a small force simulation that honours pinned nodes ---------------- */
  const WORKER_SRC = `
    let nodes = new Map(), order = [], links = [], alpha = 0, alphaTarget = 0, timer = null;
    onmessage = (e) => {
      const d = e.data;
      if (d.nodes) {
        for (const id in d.nodes) {
          const v = d.nodes[id];
          if (!v) nodes.delete(id);
          else if (!nodes.has(id)) nodes.set(id, { id, x: v[0], y: v[1], vx: 0, vy: 0, fx: null, fy: null });
        }
        order = Array.from(nodes.values());
      }
      if (d.links) links = d.links.map(([a, b]) => [nodes.get(a), nodes.get(b)]).filter((l) => l[0] && l[1]);
      if (d.forceNode) { const n = nodes.get(d.forceNode.id); if (n) { n.fx = d.forceNode.x; n.fy = d.forceNode.y; } }
      if (d.alpha !== undefined) alpha = d.alpha;
      if (d.alphaTarget !== undefined) alphaTarget = d.alphaTarget;
      if (d.run !== undefined) {
        if (d.run && !timer) timer = setInterval(tick, 16);
        if (!d.run && timer) { clearInterval(timer); timer = null; }
      }
    };
    function tick() {
      alpha += (alphaTarget - alpha) * 0.0228;
      if (alpha < 0.001) { clearInterval(timer); timer = null; return; }
      const n = order.length;
      for (let i = 0; i < n; i++) {
        const a = order[i];
        a.vx -= a.x * 0.012 * alpha; a.vy -= a.y * 0.012 * alpha;
        for (let j = i + 1; j < n; j++) {
          const b = order[j];
          let dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
          if (l2 < 1) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; l2 = 1; }
          if (l2 > 640000) continue;
          const f = 2600 * alpha / l2;
          a.vx -= dx * f; a.vy -= dy * f; b.vx += dx * f; b.vy += dy * f;
        }
      }
      for (const [a, b] of links) {
        const dx = b.x - a.x, dy = b.y - a.y, l = Math.sqrt(dx * dx + dy * dy) || 1;
        const f = (l - 120) / l * 0.06 * alpha;
        a.vx += dx * f; a.vy += dy * f; b.vx -= dx * f; b.vy -= dy * f;
      }
      const buf = new Float32Array(n * 2);
      for (let i = 0; i < n; i++) {
        const a = order[i];
        if (a.fx != null) { a.x = a.fx; a.vx = 0; } else { a.vx *= 0.6; a.x += a.vx; }
        if (a.fy != null) { a.y = a.fy; a.vy = 0; } else { a.vy *= 0.6; a.y += a.vy; }
        buf[2 * i] = a.x; buf[2 * i + 1] = a.y;
      }
      postMessage({ id: order.map((a) => a.id), buffer: buf.buffer }, [buf.buffer]);
    }
  `;

  /* ---------------- node ---------------- */
  class GraphNode {
    constructor(renderer, id, type) {
      this.renderer = renderer; this.id = id; this.type = type;
      this.x = 0; this.y = 0; this.fx = null; this.fy = null;
      this.forward = {}; this.reverse = {}; this.weight = 0;
      this.color = null; this.rendered = false; this.circle = null; this.highlight = null; this.text = null;
      this.fadeAlpha = 1; this.moveText = 0; this.fontDirty = false;
    }
    getDisplayText() {
      const s = this.id;
      if (this.type === 'tag') return s;
      const cut = s.lastIndexOf('/');
      return (cut >= 0 ? s.slice(cut + 1) : s).replace(/\.md$/, '');
    }
    getTextStyle() {
      return new PIXI.TextStyle({
        fontSize: 14, fill: this.renderer.colors.text.rgb,
        fontFamily: 'ui-sans-serif, -apple-system, "Segoe UI", Roboto, Inter, sans-serif',
        wordWrap: true, wordWrapWidth: 300, align: 'center',
      });
    }
    getSize() { return this.renderer.fNodeSizeMult * Math.max(8, Math.min(3 * Math.sqrt(this.weight + 1), 30)); }
    getFillColor() {
      const r = this.renderer, t = this.type;
      if (r.getHighlightNode() === this) return r.colors.fillHighlight;
      if (t === 'focused') return r.colors.fillFocused;
      if (this.color) return this.color;
      if (t === 'tag') return r.colors.fillTag;
      if (t === 'unresolved') return r.colors.fillUnresolved;
      if (t === 'attachment') return r.colors.fillAttachment;
      return r.colors.fill;
    }
    getRelated() { return Object.keys(this.forward).concat(Object.keys(this.reverse)); }
    initGraphics() {
      if (this.rendered) return;
      this.rendered = true;
      const r = this.renderer;
      const c = (this.circle = new PIXI.Graphics());
      c.beginFill(0xffffff); c.drawCircle(100, 100, 100); c.endFill();
      c.pivot.set(100, 100); c.zIndex = 1;
      r.hanger.addChild(c);
      const t = (this.text = new PIXI.Text(this.getDisplayText(), this.getTextStyle()));
      t.resolution = 2; t.anchor.set(0.5, 0); t.zIndex = 2;
      r.hanger.addChild(t);
    }
    clearGraphics() {
      if (!this.rendered) return;
      this.rendered = false;
      for (const k of ['circle', 'text', 'highlight']) { const o = this[k]; if (o) { if (o.parent) o.parent.removeChild(o); o.destroy(); this[k] = null; } }
    }
    render() {
      if (!this.rendered) return;
      const r = this.renderer, c = this.circle, t = this.text, hl = r.getHighlightNode();
      const size = this.getSize(), fill = this.getFillColor();
      const isHl = hl === this;
      const related = !hl || isHl || this.forward[hl.id] || this.reverse[hl.id];
      const target = related ? 1 : 0.2;
      if (Math.abs(target - this.fadeAlpha) > 0.01) { this.fadeAlpha += (target - this.fadeAlpha) * 0.25; r.changed(); } else this.fadeAlpha = target;
      c.x = this.x; c.y = this.y;
      c.scale.set((size / 100) * r.nodeScale);
      c.tint = fill.rgb; c.alpha = fill.a * this.fadeAlpha;
      if (isHl) {
        if (!this.highlight) {
          const h = (this.highlight = new PIXI.Graphics());
          h.lineStyle(14, 0xffffff, 1); h.drawCircle(100, 100, 108);
          c.addChild(h);
        }
        this.highlight.tint = r.colors.circle.rgb;
      } else if (this.highlight) { c.removeChild(this.highlight); this.highlight.destroy(); this.highlight = null; }
      let ta = r.textAlpha;
      if (isHl) ta = 1;
      ta *= this.fadeAlpha;
      t.visible = ta > 0.001;
      if (t.visible) {
        // Position and size are only worked out while the name is showing. Zoomed out, a name keeps a
        // constant size on screen; zoomed in, it grows with the notes.
        if (this.fontDirty) { this.fontDirty = false; t.style = this.getTextStyle(); }
        t.x = this.x; t.y = this.y + (size + 5) * r.nodeScale + this.moveText;
        t.scale.set(r.scale < 1 ? 1 / r.scale : r.nodeScale); t.alpha = ta;
      }
    }
  }

  /* ---------------- link ---------------- */
  class GraphLink {
    constructor(renderer, source, target) { this.renderer = renderer; this.source = source; this.target = target; this.rendered = false; this.px = null; this.line = null; this.arrow = null; }
    initGraphics() {
      if (this.rendered) return;
      this.rendered = true;
      this.px = new PIXI.Container();
      this.line = new PIXI.Sprite(PIXI.Texture.WHITE);
      this.px.addChild(this.line);
      this.px.zIndex = 0;
      this.renderer.hanger.addChild(this.px);
    }
    clearGraphics() {
      if (!this.rendered) return;
      this.rendered = false;
      if (this.px.parent) this.px.parent.removeChild(this.px);
      this.px.destroy({ children: true });
      this.px = this.line = null;
    }
    render() {
      if (!this.rendered) return;
      const r = this.renderer, s = this.source, t = this.target;
      const dx = t.x - s.x, dy = t.y - s.y, dist = Math.sqrt(dx * dx + dy * dy);
      const hl = r.getHighlightNode();
      const on = hl && (hl === s || hl === t);
      const col = on ? r.colors.lineHighlight : r.colors.line;
      this.px.x = s.x; this.px.y = s.y; this.px.rotation = Math.atan2(dy, dx);
      const thick = (1.3 * Math.sqrt(r.fLineSizeMult) * DPR()) / r.scale;
      this.line.width = dist; this.line.height = thick; this.line.y = -thick / 2;
      this.line.tint = col.rgb;
      this.line.alpha = col.a * (hl && !on ? 0.3 : 1);
    }
  }

  /* ---------------- renderer ---------------- */
  class GraphRenderer {
    constructor(containerEl) {
      this.containerEl = containerEl;
      this.nodes = []; this.links = []; this.nodeLookup = {};
      this.scale = 1; this.targetScale = 1; this.nodeScale = 1; this.textAlpha = 1;
      this.panX = 0; this.panY = 0; this.panvX = 0; this.panvY = 0; this.panning = false;
      this.zoomCenterX = 0; this.zoomCenterY = 0; this.mouseX = null; this.mouseY = null;
      this.fNodeSizeMult = 1; this.fLineSizeMult = 1; this.fTextShowMult = 0; this.fShowArrow = false;
      this.dragNode = null; this.highlightNode = null;
      this.idleFrames = 0; this.renderTimer = null; this.workerResults = null;
      this.width = 0; this.height = 0; this.colors = {};
      this.frames = 0;
      this.renderCallback = this.renderCallback.bind(this);
      this.worker = new Worker(URL.createObjectURL(new Blob([WORKER_SRC], { type: 'text/javascript' })));
      this.worker.onmessage = (e) => { this.workerResults = e.data; this.changed(); };
      this.initGraphics();
      this.testCSS();
      this.onResize();
      this.setPan((this.width / 2) * DPR(), (this.height / 2) * DPR());
      this.setScale(1);
      this.bind();
    }
    initGraphics() {
      if (this.interactiveEl) this.interactiveEl.remove();
      this.interactiveEl = document.createElement('canvas');
      this.containerEl.prepend(this.interactiveEl);
      if (this._bound) this.bindCanvas();
      this.px = new PIXI.Application({ view: this.interactiveEl, antialias: true, backgroundAlpha: 0, autoStart: false, width: 300, height: 150 });
      this.hanger = new PIXI.Container();
      this.hanger.sortableChildren = true;
      this.px.stage.addChild(this.hanger);
      for (const n of this.nodes) n.initGraphics();
      for (const l of this.links) l.initGraphics();
    }
    destroyGraphics() {
      for (const n of this.nodes) n.clearGraphics();
      for (const l of this.links) l.clearGraphics();
      this.px.destroy(false, { children: true, texture: true, baseTexture: true });
      this.px = null; this.hanger = null;
    }
    testCSS() {
      const map = { fill: 'color-fill', fillFocused: 'color-fill-focused', fillTag: 'color-fill-tag', fillUnresolved: 'color-fill-unresolved', fillAttachment: 'color-fill-attachment', arrow: 'color-arrow', circle: 'color-circle', line: 'color-line', text: 'color-text', fillHighlight: 'color-fill-highlight', lineHighlight: 'color-line-highlight' };
      for (const k in map) this.colors[k] = readColor(this.containerEl, map[k]);
      for (const n of this.nodes) n.fontDirty = true; // each name takes the new colour when it is next drawn
      this.changed();
    }
    onResize() {
      const w = this.containerEl.clientWidth, h = this.containerEl.clientHeight, d = DPR();
      if (this.width) { this.panX += ((w - this.width) / 2) * d; this.panY += ((h - this.height) / 2) * d; }
      this.width = w; this.height = h;
      this.px.renderer.resize(w * d, h * d);
      this.interactiveEl.style.width = w + 'px'; this.interactiveEl.style.height = h + 'px';
      this.changed();
    }
    getHighlightNode() { return this.dragNode || this.highlightNode; }
    setPan(x, y) { this.panX = x; this.panY = y; }
    setScale(e) {
      this.scale = e;
      this.nodeScale = Math.sqrt(1 / e);
      this.textAlpha = Math.min(Math.max(Math.log(e) / Math.log(2) + 1 - this.fTextShowMult, 0), 1);
    }
    zoomTo(scale, pointer) {
      this.targetScale = Math.min(8, Math.max(1 / 128, scale));
      this.zoomCenterX = pointer ? pointer.x : 0; this.zoomCenterY = pointer ? pointer.y : 0;
      this.changed();
    }
    updateZoom() {
      const e = this.scale, t = this.targetScale;
      if (e === t) return;
      let cx = this.zoomCenterX, cy = this.zoomCenterY;
      if (cx === 0 && cy === 0) { cx = (this.width / 2) * DPR(); cy = (this.height / 2) * DPR(); }
      let ns = e * 0.85 + t * 0.15;
      if (Math.abs(ns - t) < t * 0.004) ns = t;
      const k = ns / e;
      this.panX = cx - (cx - this.panX) * k; this.panY = cy - (cy - this.panY) * k;
      this.setScale(ns);
      this.changed();
    }
    changed() { this.idleFrames = 0; this.queueRender(); }
    queueRender() { if (!this.renderTimer && this.idleFrames <= 60) this.renderTimer = requestAnimationFrame(this.renderCallback); }
    renderCallback() {
      this.renderTimer = null;
      if (this.idleFrames > 60 || !this.px) return;
      this.idleFrames++;
      this.frames++;
      this.updateZoom();
      const res = this.workerResults;
      if (res) {
        this.workerResults = null;
        const ids = res.id, buf = new Float32Array(res.buffer);
        for (let i = 0; i < ids.length; i++) { const n = this.nodeLookup[ids[i]]; if (n) { n.x = buf[2 * i]; n.y = buf[2 * i + 1]; } }
      }
      const h = this.hanger;
      h.x = this.panX; h.y = this.panY; h.scale.set(this.scale);
      for (const n of this.nodes) n.render();
      for (const l of this.links) l.render();
      this.px.render();
      this.queueRender();
    }
    setData(data) {
      const old = this.nodeLookup, nodes = [], lookup = {}, add = {};
      for (const id in data.nodes) {
        const d = data.nodes[id];
        let n = old[id];
        if (!n) {
          n = new GraphNode(this, id, d.type);
          const a = rnd() * 6.283, rr = rnd() * 110;
          n.x = Math.cos(a) * rr; n.y = Math.sin(a) * rr;
          add[id] = [n.x, n.y];
          n.initGraphics();
        }
        n.type = d.type; n.color = d.color || null; n.forward = {}; n.reverse = {};
        nodes.push(n); lookup[id] = n;
      }
      for (const id in old) if (!lookup[id]) { old[id].clearGraphics(); add[id] = false; }
      for (const l of this.links) l.clearGraphics();
      const links = [], pairs = [];
      for (const id in data.nodes) {
        const s = lookup[id];
        for (const tid in data.nodes[id].links) {
          const t = lookup[tid];
          if (!t) continue;
          const l = new GraphLink(this, s, t);
          s.forward[tid] = l; t.reverse[id] = l;
          links.push(l); pairs.push([id, tid]);
          l.initGraphics();
        }
      }
      for (const n of nodes) n.weight = Object.keys(n.forward).length + Object.keys(n.reverse).length;
      this.nodes = nodes; this.links = links; this.nodeLookup = lookup;
      this.worker.postMessage({ nodes: add, links: pairs, alpha: 0.3, run: true });
      this.changed();
    }
    /* pointer handling (simplified, but with Obsidian's drag protocol) */
    toWorld(ev) {
      const rect = this.interactiveEl.getBoundingClientRect(), d = DPR();
      const sx = (ev.clientX - rect.left) * d, sy = (ev.clientY - rect.top) * d;
      return { sx, sy, x: (sx - this.panX) / this.scale, y: (sy - this.panY) / this.scale };
    }
    hit(p) {
      let best = null, bd = Infinity;
      for (const n of this.nodes) {
        const rad = n.getSize() * this.nodeScale + 4 / this.scale;
        const d2 = (n.x - p.x) ** 2 + (n.y - p.y) ** 2;
        if (d2 < rad * rad && d2 < bd) { best = n; bd = d2; }
      }
      return best;
    }
    bind() {
      this._bound = true;
      this.bindCanvas();
      new ResizeObserver(() => { if (this.px && (this.containerEl.clientWidth !== this.width || this.containerEl.clientHeight !== this.height)) this.onResize(); }).observe(this.containerEl);
    }
    bindCanvas() {
      const el = this.interactiveEl;
      let last = null;
      el.addEventListener('pointerdown', (ev) => {
        const p = this.toWorld(ev), n = this.hit(p);
        if (n) { this.dragNode = n; } else { this.panning = true; }
        last = p; el.setPointerCapture(ev.pointerId); this.changed();
      });
      el.addEventListener('pointermove', (ev) => {
        const p = this.toWorld(ev);
        if (this.dragNode) {
          const n = this.dragNode; n.fx = p.x; n.fy = p.y;
          this.worker.postMessage({ alpha: 0.3, alphaTarget: 0.3, run: true, forceNode: { id: n.id, x: p.x, y: p.y } });
        } else if (this.panning && last) {
          this.panX += p.sx - last.sx; this.panY += p.sy - last.sy;
        } else {
          const n = this.hit(p);
          if (n !== this.highlightNode) this.highlightNode = n;
        }
        last = p; this.changed();
      });
      const up = () => {
        if (this.dragNode) {
          const n = this.dragNode;
          this.worker.postMessage({ alphaTarget: 0, forceNode: { id: n.id, x: null, y: null } });
          n.fx = null; n.fy = null; this.dragNode = null;
        }
        this.panning = false; last = null; this.changed();
      };
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
      el.addEventListener('wheel', (ev) => {
        ev.preventDefault();
        const p = this.toWorld(ev);
        this.zoomTo(this.targetScale * Math.pow(1.5, -ev.deltaY / 120), { x: p.sx, y: p.sy });
      }, { passive: false });
    }
  }

  /* ---------------- vault, views, app ---------------- */
  function graphData(vault, opts) {
    opts = Object.assign({ showAttachments: true, showTags: false, hideUnresolved: false }, opts);
    const nodes = {};
    for (const f of vault.files) nodes[f.path] = { type: '', links: {} };
    for (const src in vault.links) {
      if (!nodes[src]) continue;
      for (const dst of vault.links[src]) {
        const isMd = /\.md$/.test(dst);
        if (!isMd && !opts.showAttachments) continue;
        if (!nodes[dst]) nodes[dst] = { type: isMd ? '' : 'attachment', links: {} };
        nodes[src].links[dst] = true;
      }
    }
    if (!opts.hideUnresolved) {
      for (const src in vault.unresolved || {}) {
        if (!nodes[src]) continue;
        for (const dst of vault.unresolved[src]) {
          if (!nodes[dst]) nodes[dst] = { type: 'unresolved', links: {} };
          nodes[src].links[dst] = true;
        }
      }
    }
    if (opts.showTags) {
      for (const f of vault.files) for (const t of f.tags || []) {
        const id = '#' + t;
        if (!nodes[id]) nodes[id] = { type: 'tag', links: {} };
        nodes[f.path].links[id] = true;
      }
    }
    if (opts.local) {
      const keep = new Set([opts.local]);
      for (const t in nodes[opts.local].links) keep.add(t);
      for (const id in nodes) if (nodes[id].links[opts.local]) keep.add(id);
      for (const id in nodes) if (!keep.has(id)) delete nodes[id];
      nodes[opts.local].type = 'focused';
    }
    return { nodes };
  }

  class GraphView {
    constructor(app, type, host) {
      this.app = app; this.type = type;
      this.containerEl = host;
      this.contentEl = document.createElement('div');
      this.contentEl.className = 'view-content';
      host.appendChild(this.contentEl);
      this.renderer = new GraphRenderer(this.contentEl);
      this.leaf = { view: this };
    }
    getViewType() { return this.type; }
    setData(opts) { this.opts = opts; this.renderer.setData(graphData(this.app.__vault, opts)); }
    refresh() { this.renderer.setData(graphData(this.app.__vault, this.opts)); }
  }

  class Events {
    constructor() { this.h = {}; }
    on(name, cb) { (this.h[name] || (this.h[name] = [])).push(cb); return { name, cb, src: this }; }
    off(ref) { const l = this.h[ref.name]; if (l) this.h[ref.name] = l.filter((c) => c !== ref.cb); }
    trigger(name, ...a) { for (const cb of this.h[name] || []) cb(...a); }
  }

  function makeApp(vault) {
    const ws = new Events();
    const views = [];
    ws.getLeavesOfType = (t) => views.filter((v) => v.type === t).map((v) => v.leaf);
    ws.onLayoutReady = (cb) => setTimeout(cb, 0);
    const trig = ws.trigger.bind(ws);
    ws.trigger = (name, ...a) => { if (name === 'css-change') for (const v of views) v.renderer.testCSS(); trig(name, ...a); };
    const mc = new Events();
    const vaultEvents = new Events();
    const app = { workspace: ws, metadataCache: mc, __vault: vault, __views: views, __vaultEvents: vaultEvents };
    const refreshMeta = () => {
      const byPath = new Map(vault.files.map((f) => [f.path, f]));
      app.vault = {
        on: (name, cb) => vaultEvents.on(name, cb),
        getMarkdownFiles: () => vault.files.map((f) => ({ path: f.path, basename: f.path.split('/').pop().replace(/\.md$/, '') })),
        getAbstractFileByPath: (p) => (byPath.has(p) ? { path: p, __f: byPath.get(p) } : null),
      };
      mc.resolvedLinks = {}; mc.unresolvedLinks = {};
      for (const f of vault.files) { mc.resolvedLinks[f.path] = {}; mc.unresolvedLinks[f.path] = {}; }
      for (const src in vault.links) for (const d of vault.links[src]) if (mc.resolvedLinks[src]) mc.resolvedLinks[src][d] = 1;
      for (const src in vault.unresolved || {}) for (const d of vault.unresolved[src]) if (mc.unresolvedLinks[src]) mc.unresolvedLinks[src][d] = 1;
      mc.getFileCache = (file) => { const f = file && file.__f; return f ? { tags: (f.tags || []).map((t) => ({ tag: '#' + t })), frontmatter: f.frontmatter } : null; };
    };
    refreshMeta();
    app.__refresh = () => { refreshMeta(); for (const v of views) v.refresh(); mc.trigger('resolved'); };
    app.__open = (type, host, opts) => { const v = new GraphView(app, type, host); views.push(v); v.setData(opts || {}); ws.trigger('layout-change'); return v; };
    app.__close = (v) => { const i = views.indexOf(v); if (i >= 0) views.splice(i, 1); v.renderer.destroyGraphics(); v.containerEl.innerHTML = ''; ws.trigger('layout-change'); };
    return app;
  }

  /* ---------------- the `obsidian` module the plugin requires ---------------- */
  class Plugin {
    constructor(app, manifest) { this.app = app; this.manifest = manifest; this._refs = []; this._ints = []; this.commands = []; }
    registerEvent(ref) { this._refs.push(ref); }
    registerInterval(id) { this._ints.push(id); return id; }
    addCommand(c) { this.commands.push(c); }
    addSettingTab(t) { this.settingTab = t; }
    async loadData() { return window.__pluginData ? JSON.parse(JSON.stringify(window.__pluginData)) : null; }
    async saveData(d) { window.__pluginData = JSON.parse(JSON.stringify(d)); }
    unload() { this.onunload(); for (const i of this._ints) clearInterval(i); for (const r of this._refs) r.src.off(r); }
  }
  class PluginSettingTab { constructor(app, plugin) { this.app = app; this.plugin = plugin; this.containerEl = document.createElement('div'); this.containerEl.empty = function () { this.innerHTML = ''; }; } }
  class Setting {
    constructor(el) { this.el = el; el.appendChild(document.createElement('div')); }
    setName(n) { this.name = n; return this; } setDesc() { return this; } setHeading() { return this; }
    addToggle(cb) { cb({ setValue() { return this; }, onChange() { return this; } }); return this; }
    addSlider(cb) { cb({ setLimits() { return this; }, setValue() { return this; }, setDynamicTooltip() { return this; }, onChange() { return this; } }); return this; }
    addText(cb) { cb({ setPlaceholder() { return this; }, setValue() { return this; }, onChange() { return this; } }); return this; }
    addButton(cb) { cb({ setButtonText() { return this; }, onClick(fn) { window.__buttons = (window.__buttons || []).concat(fn); return this; } }); return this; }
  }
  class Notice { constructor(msg) { (window.__notices = window.__notices || []).push(msg); } }
  const obsidian = {
    Plugin, PluginSettingTab, Setting, Notice, apiVersion: '1.15.0-sim',
    Platform: { isMobile: !!window.__mobile, isTablet: !!window.__mobile, isIosApp: !!window.__mobile },
    getAllTags: (cache) => (cache.tags || []).map((t) => t.tag),
    setIcon: (el, name) => { el.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' + (name === 'maximize' ? '<path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3"/>' : name === 'chevron-down' ? '<path d="m6 9 6 6 6-6"/>' : '<path d="m18 15-6-6-6 6"/>') + '</svg>'; },
  };

  window.Mock = { makeApp, obsidian, GraphRenderer, GraphNode, GraphLink };
})();
