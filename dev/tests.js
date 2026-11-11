/* Behaviour tests for Galaxy Graph in the Obsidian simulator. */
const { open, close } = require('./lib');

let failures = 0;
const ok = (cond, msg, extra) => { if (cond) console.log('  ok   ' + msg); else { failures++; console.log('  FAIL ' + msg + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); } };
const errorsOf = (page) => page.logs.filter((l) => /pageerror|\[error\]|Galaxy Graph/i.test(l));

/** Largest distance of any node from where the galaxy wants it. */
const maxDrift = (page) => page.evaluate(() => { let m = 0; for (const n of view.renderer.nodes) { const g = n.__gx; if (!g || !g.has) continue; m = Math.max(m, Math.hypot(n.x - g.tx, n.y - g.ty)); } return m; });
const screenOf = (page, id) => page.evaluate((id) => { const r = view.renderer, n = r.nodeLookup[id], d = devicePixelRatio; return { x: (n.x * r.scale + r.panX) / d, y: (n.y * r.scale + r.panY) / d }; }, id);
const state = (page) => page.evaluate(() => { const r = view.renderer, c = plugin.controllers.get(view); return { frames: r.frames, scale: r.scale, panX: r.panX, panY: r.panY, hanger: r.hanger ? r.hanger.children.length : -1, anim: !!(c && c.anim), sprite: !!(c && c.sprite), spriteAlpha: c && c.sprite ? c.sprite.alpha : null, labels: c ? c.labels.length : 0, legend: !!document.querySelector('.galaxy-legend'), patched: plugin.patches.length, bodyOn: document.body.classList.contains('galaxy-graph-on') }; });

const T = {};

T.entrance = async () => {
  const page = await open({ quiet: true });
  const shots = [120, 380, 700, 1100];
  let last = 0;
  for (const t of shots) { await page.waitForTimeout(t - last); last = t; await page.shot('anim-' + t); }
  await page.waitForTimeout(1900);
  const s1 = await state(page);
  ok((await maxDrift(page)) < 0.5, 'every note ends exactly on its place', await maxDrift(page));
  ok(!s1.anim && s1.sprite && s1.labels === 6 && s1.legend, 'animation finished; glow, 6 arm names and the list exist', s1);
  ok(Math.abs(s1.spriteAlpha - 0.8) < 1e-6, 'glow faded in to its set strength', s1.spriteAlpha);
  // idle: after things settle the plugin must not ask Obsidian to redraw anything
  await page.waitForTimeout(4000);
  await page.evaluate(() => { const r = view.renderer, c = r.changed.bind(r); window.__changes = 0; r.changed = () => { window.__changes++; c(); }; window.__msgs = 0; const pm = r.worker.postMessage.bind(r.worker); r.worker.postMessage = (m) => { window.__msgs++; pm(m); }; });
  await page.waitForTimeout(4000);
  const idle = await page.evaluate(() => ({ changes: window.__changes, msgs: window.__msgs }));
  ok(idle.changes === 0 && idle.msgs === 0, 'while idle the plugin asks for no redraws and sends nothing (nothing animates, nothing can freeze)', idle);
  const f1 = (await state(page)).frames; await page.waitForTimeout(1500); const f2 = (await state(page)).frames;
  ok(f2 === f1, 'and the graph really is at rest: no frames drawn', { f1, f2 });
  ok(errorsOf(page).length === 0, 'no errors logged', errorsOf(page));
  await page.context().close();
};

T.drag = async () => {
  const page = await open({ quiet: true });
  await page.waitForTimeout(3200);
  const id = 'Philosophy/Euthanasia.md';
  const p = await screenOf(page, id);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await page.mouse.move(p.x + 90, p.y - 70, { steps: 8 });
  await page.waitForTimeout(250);
  const during = await page.evaluate((id) => { const n = view.renderer.nodeLookup[id], g = n.__gx; return { d: Math.hypot(n.x - g.tx, n.y - g.ty), dragging: view.renderer.dragNode === n }; }, id);
  ok(during.dragging && during.d > 100, 'a note can be dragged away from its place', during);
  await page.shot('drag-during');
  await page.mouse.up();
  await page.waitForTimeout(1800);
  const after = await page.evaluate((id) => { const n = view.renderer.nodeLookup[id], g = n.__gx; return Math.hypot(n.x - g.tx, n.y - g.ty); }, id);
  ok(after < 0.5, 'after letting go it glides back to its place', after);
  ok((await maxDrift(page)) < 0.5, 'no other note moved', await maxDrift(page));
  const c = await page.ctl();
  ok(!c.broken && c.strikes === 0, 'layout still healthy', c);
  // drag several times in a row
  for (let i = 0; i < 4; i++) {
    const q = await screenOf(page, 'Politics/Pressure Groups.md');
    await page.mouse.move(q.x, q.y); await page.mouse.down(); await page.mouse.move(q.x - 60, q.y + 50, { steps: 4 }); await page.mouse.up();
    await page.waitForTimeout(1300);
  }
  ok((await maxDrift(page)) < 0.5 && !(await page.ctl()).broken, 'repeated dragging never knocks the layout out', await page.ctl());
  ok(errorsOf(page).length === 0, 'no errors logged', errorsOf(page));
  await page.context().close();
};

T.hover = async () => {
  const page = await open({ quiet: true });
  await page.waitForTimeout(3200);
  const p = await screenOf(page, 'Philosophy/Philosophy MOC.md');
  await page.mouse.move(p.x, p.y);
  await page.waitForTimeout(700);
  const info = await page.evaluate(() => {
    const r = view.renderer, hl = r.getHighlightNode();
    const moc = r.nodeLookup['Philosophy/Philosophy MOC.md'], member = r.nodeLookup['Philosophy/Euthanasia.md'], other = r.nodeLookup['Politics/Pressure Groups.md'];
    const link = moc.forward['Philosophy/Euthanasia.md'];
    return { hl: hl && hl.id, mocTint: moc.circle.tint, hlColor: r.colors.fillHighlight.rgb, memberAlpha: member.circle.alpha, otherAlpha: other.circle.alpha, linkAlpha: link.line.alpha, linkTint: link.line.tint, lineHl: r.colors.lineHighlight, mocLabel: moc.text.visible && moc.text.alpha };
  });
  ok(info.hl === 'Philosophy/Philosophy MOC.md', 'hovering a note highlights it', info.hl);
  ok(info.mocTint === info.hlColor, 'hovered note takes Obsidian\'s highlight colour', info);
  ok(info.memberAlpha > 0.9 && info.otherAlpha < 0.4, 'linked notes stay bright, the rest dim', info);
  ok(Math.abs(info.linkAlpha - info.lineHl.a) < 0.02 && info.linkTint === info.lineHl.rgb, 'its links light up in full (not toned down)', info);
  ok(info.mocLabel === 1, 'its name shows even when zoomed out', info.mocLabel);
  await page.shot('hover');
  await page.mouse.move(5, 5);
  await page.waitForTimeout(2600);
  const back = await page.evaluate(() => { const r = view.renderer; const l = r.nodeLookup['Philosophy/Philosophy MOC.md'].forward['Philosophy/Euthanasia.md']; return { a: l.line.alpha, base: r.colors.line.a, other: r.nodeLookup['Politics/Pressure Groups.md'].circle.alpha }; });
  ok(Math.abs(back.a - back.base * 0.25) < 0.004, 'afterwards MOC links return to their quiet level (no build-up)', back);
  ok(back.other > 0.99, 'and every note is bright again', back);
  await page.context().close();
};

T.legend = async () => {
  const page = await open({ quiet: true });
  await page.waitForTimeout(3200);
  const names = await page.$$eval('.galaxy-legend-name', (els) => els.map((e) => e.textContent));
  ok(names.join(',') === 'Philosophy,Politics,History,Economics,Admin,Maths,Unlinked', 'list shows the MOCs, biggest first, then Unlinked', names);
  await page.click('.galaxy-legend-item:nth-child(2)');
  await page.waitForTimeout(600);
  const spot = await page.evaluate(() => { const r = view.renderer; return { pol: r.nodeLookup['Politics/Pressure Groups.md'].circle.alpha, mocPol: r.nodeLookup['Politics/Politics MOC.md'].circle.alpha, phil: r.nodeLookup['Philosophy/Euthanasia.md'].circle.alpha, home: r.nodeLookup['Home.md'].circle.alpha, active: document.querySelectorAll('.galaxy-legend-item.is-active').length }; });
  ok(spot.pol > 0.99 && spot.mocPol > 0.99 && spot.phil < 0.2 && spot.active === 1, 'tapping a MOC lights up only its arm', spot);
  await page.shot('spotlight');
  await page.click('.galaxy-legend-item:nth-child(2)');
  await page.waitForTimeout(500);
  const clear = await page.evaluate(() => ({ phil: view.renderer.nodeLookup['Philosophy/Euthanasia.md'].circle.alpha, active: document.querySelectorAll('.galaxy-legend-item.is-active').length }));
  ok(clear.phil > 0.99 && clear.active === 0, 'tapping it again clears the spotlight', clear);
  // zoom in, then the fit button brings the whole galaxy back
  await page.mouse.move(700, 300); await page.mouse.wheel(0, -600); await page.waitForTimeout(1500);
  const zoomed = (await state(page)).scale;
  await page.click('.galaxy-legend-btn[aria-label^="Fit"]');
  await page.waitForTimeout(600);
  const fitted = await state(page), fit = (await page.ctl()).fit;
  ok(zoomed > fit.scale * 1.5 && Math.abs(fitted.scale - fit.scale) < 1e-6 && Math.abs(fitted.panX - 1000) < 1 && Math.abs(fitted.panY - 590) < 1, 'the fit button re-centres and re-fits the galaxy', { zoomed, fitted: fitted.scale, fit: fit.scale });
  await page.click('.galaxy-legend-btn[aria-label="Hide the list"]');
  await page.waitForTimeout(300);
  ok(await page.$eval('.galaxy-legend', (e) => e.classList.contains('is-collapsed')), 'the list collapses');
  ok(await page.evaluate(() => window.__pluginData && window.__pluginData.legendCollapsed === true), 'and remembers that it is collapsed');
  await page.shot('legend-collapsed');
  ok(errorsOf(page).length === 0, 'no errors logged', errorsOf(page));
  await page.context().close();
};

/** Everything about the note names as they are drawn right now. Sizes are in screen pixels. */
const namesNow = (page) => page.evaluate(() => {
  const r = view.renderer, out = [];
  for (const n of r.nodes) {
    const t = n.text;
    if (!t) continue;
    const shown = t.visible && t.alpha > 0.5 && t.worldAlpha > 0.05;
    const b = shown ? t.getBounds() : null, px = t.style.fontSize * t.scale.x * r.scale;
    out.push({
      id: n.id, shown, alpha: t.visible ? t.alpha : 0,
      px, own: t.style.fontSize * (r.scale < 1 ? 1 / r.scale : r.nodeScale) * r.scale,
      edge: t.style.strokeThickness, marked: !!t.style.__gx0,
      // the part of the text box that letters actually cover: the box leaves room above for accents and below the last line
      box: b ? [b.x, b.y + 0.21 * px, b.x + b.width, b.y + b.height - 0.29 * px] : null,
      star: [n.x * r.scale + r.panX, n.y * r.scale + r.panY],
    });
  }
  return out;
});
/** Pairs of shown names whose boxes overlap, and names that run across another note's star. */
const clashes = (list) => {
  const shown = list.filter((n) => n.shown), pad = 0.5;
  let names = 0, stars = 0;
  const first = [];
  for (let a = 0; a < shown.length; a++) {
    const A = shown[a].box;
    for (let b = a + 1; b < shown.length; b++) {
      const B = shown[b].box;
      if (A[0] + pad < B[2] - pad && B[0] + pad < A[2] - pad && A[1] + pad < B[3] - pad && B[1] + pad < A[3] - pad) { names++; if (first.length < 4) first.push(shown[a].id + ' / ' + shown[b].id); }
    }
    for (const o of list) {
      if (o === shown[a]) continue;
      if (o.star[0] > A[0] + pad && o.star[0] < A[2] - pad && o.star[1] > A[1] + pad && o.star[1] < A[3] - pad) stars++;
    }
  }
  return { names, stars, shown: shown.length, first };
};
const zoomTo = async (page, sc, x = 0, y = 0) => {
  await page.evaluate(({ sc, x, y }) => {
    const r = view.renderer, scr = r.px.renderer.screen;
    view.contentEl.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); // as a finger on the screen would
    r.targetScale = sc; r.setScale(sc); r.setPan(scr.width / 2 - x * sc, scr.height / 2 - y * sc); r.changed();
  }, { sc, x, y });
  await page.waitForTimeout(500);
};

T.names = async () => {
  // an iPad: a sharp screen, where Obsidian's own names are only 7 CSS pixels tall
  const page = await open({ quiet: true, width: 1180, height: 696, dpr: 2 });
  await page.waitForTimeout(3400);
  const fit = (await page.ctl()).fit;
  const atFit = await namesNow(page);
  ok(atFit.length === 74 && atFit.every((n) => !n.shown), 'whole galaxy in view: no note names, the picture stays clean', atFit.filter((n) => n.shown).length);
  await zoomTo(page, 1);
  const z1 = await namesNow(page), c1 = clashes(z1);
  ok(c1.shown === 74 && z1.every((n) => n.alpha > 0.99), 'zoomed in: every note shows its name', c1.shown);
  ok(z1.every((n) => n.px > 20.5 && n.px < 22.01) && z1.every((n) => Math.abs(n.own - 14) < 0.01), 'on a sharp screen names are drawn at 11 CSS pixels instead of Obsidian\'s 7', { min: Math.min(...z1.map((n) => n.px)), max: Math.max(...z1.map((n) => n.px)) });
  ok(z1.every((n) => n.edge === 4), 'every name has its thin dark edge');
  ok(c1.names === 0, 'no two names overlap', c1);
  ok(c1.stars === 0, 'no name runs across another note\'s star', c1);
  await page.shot('names-ipad');
  // the same holds across the range of zooms where names are showing
  let worst = { names: 0, stars: 0 };
  for (const sc of [0.75, 0.9, 1.3, 1.8, 2.6]) { await zoomTo(page, sc); const c = clashes(await namesNow(page)); worst = { names: Math.max(worst.names, c.names), stars: Math.max(worst.stars, c.stars) }; }
  ok(worst.names === 0, 'and none overlap at other zoom levels either', worst);
  await zoomTo(page, 3);
  const z3 = await namesNow(page);
  ok(z3.every((n) => Math.abs(n.px - n.own) < 0.01 && n.px > 24), 'zoomed right in, names are back to the size Obsidian gives them', { px: z3[0].px, own: z3[0].own });
  // touching a note while zoomed out shows its name at a readable size
  await zoomTo(page, fit.scale);
  const p = await screenOf(page, 'Politics/Pressure Groups.md');
  await page.mouse.move(p.x, p.y);
  await page.waitForTimeout(600);
  const hov = (await namesNow(page)).find((n) => n.id === 'Politics/Pressure Groups.md');
  ok(hov.shown && Math.abs(hov.px - 22) < 0.01, 'touching a note while zoomed out shows its name at a readable size', hov);
  await page.mouse.move(5, 5);
  await page.waitForTimeout(900);
  // the setting switches the edge and the larger size off, and leaves nothing behind
  await page.evaluate(async () => { plugin.settings.names = false; await plugin.saveSettings(); });
  await zoomTo(page, 1);
  const off = await namesNow(page);
  ok(off.every((n) => n.edge === 0 && !n.marked && Math.abs(n.px - 14) < 0.01) && off.every((n) => n.shown), 'with "Clearer note names" off, names are exactly as Obsidian draws them', off[0]);
  await page.evaluate(async () => { plugin.settings.names = true; await plugin.saveSettings(); });
  await page.waitForTimeout(500);
  ok((await namesNow(page)).every((n) => n.edge === 4 && Math.abs(n.px - 22) < 1.5), 'and on again they are restored');
  ok(errorsOf(page).length === 0, 'no errors logged', errorsOf(page));
  await page.context().close();

  // an ordinary desktop screen: Obsidian's own size is already comfortable, so it is kept
  const desk = await open({ quiet: true, width: 1400, height: 880, dpr: 1, mobile: false });
  await desk.waitForTimeout(3400);
  await zoomTo(desk, 1);
  const d1 = await namesNow(desk), dc = clashes(d1);
  ok(d1.every((n) => Math.abs(n.px - 14) < 0.01 && n.edge === 4) && dc.shown === 74, 'on an ordinary screen names keep Obsidian\'s size and gain only the edge', d1[0]);
  ok(dc.names === 0 && dc.stars === 0, 'and there too nothing overlaps', dc);
  await desk.context().close();

  // a bigger vault, where the arms are broad
  const big = await open({ quiet: true, vault: 'medium', width: 1180, height: 696, dpr: 2 });
  await big.waitForTimeout(3600);
  let bw = { names: 0, shown: 0 };
  for (const [x, y] of [[0, 0], [900, 500], [-1200, 800], [300, -1500]]) { await zoomTo(big, 1, x, y); const c = clashes(await namesNow(big)); bw = { names: Math.max(bw.names, c.names), shown: Math.max(bw.shown, c.shown), first: c.first.length ? c.first : bw.first }; }
  ok(bw.names === 0 && bw.shown > 250, 'in a 340-note vault the names that show do not overlap', bw);
  await big.shot('names-medium');
  await big.context().close();

  // a light theme with the dark background switched off: dark names need no dark edge
  const light = await open({ quiet: true, width: 1180, height: 696, dpr: 2 });
  await light.addStyleTag({ content: '.theme-light .view-content{background:#fff}.theme-light .graph-view.color-text{color:#222}.theme-light .graph-view.color-line{color:#c8c8c8}.theme-light .graph-view.color-fill{color:#5c5c5c}' });
  await light.evaluate(async () => { document.body.classList.replace('theme-dark', 'theme-light'); plugin.settings.background = false; await plugin.saveSettings(); });
  await light.waitForTimeout(3600);
  await zoomTo(light, 1);
  const l1 = await namesNow(light);
  const lc = await light.evaluate(() => ({ text: view.renderer.colors.text.rgb, line: view.renderer.colors.line.rgb, arm: plugin.controllers.get(view).labels[0].style.fill }));
  ok(l1.every((n) => n.edge === 0) && lc.text === 0x222222, 'light theme, background off: names keep the theme\'s dark colour and get no dark edge', lc);
  const lum = (hex) => { const v = parseInt(String(lc.arm).replace('#', ''), 16); return 0.299 * (v >> 16) + 0.587 * ((v >> 8) & 255) + 0.114 * (v & 255); };
  ok(lum() < 150 && lc.line === 0x484c7a, 'and the arm names and link lines are dark enough to see', lc);
  await light.shot('names-light');
  ok(errorsOf(light).length === 0, 'no errors logged', errorsOf(light));
  await light.context().close();
};

T.onoff = async () => {
  const page = await open({ quiet: true });
  await page.waitForTimeout(3200);
  const before = await page.evaluate(() => { const n = view.renderer.nodes[5]; return { hanger: view.renderer.hanger.children.length }; });
  // turn off through the command, as a user would
  await page.evaluate(() => plugin.commands.find((c) => c.id === 'toggle').callback());
  await page.waitForTimeout(2500);
  const off = await page.evaluate(() => {
    const r = view.renderer;
    return { gx: r.nodes.filter((n) => n.__gx).length, lgx: r.links.filter((l) => l.__gx).length, fill: r.nodes[5].getFillColor() === r.colors.fill, size: r.nodes.find((n) => n.id === 'Scratchpad.md').getSize(),
      body: document.body.className, legend: !!document.querySelector('.galaxy-legend'), host: document.querySelectorAll('.galaxy-graph-host').length, patches: plugin.patches.length, controllers: plugin.controllers.size,
      wrapped: !!Mock.GraphNode.prototype.getFillColor.__galaxy || !!Mock.GraphNode.prototype.render.__galaxy || !!Mock.GraphLink.prototype.render.__galaxy, lineA: r.colors.line.a, kids: r.hanger.children.length };
  });
  ok(off.gx === 0 && off.lgx === 0 && off.fill && off.size === 8, 'turned off: notes and links are exactly as Obsidian draws them', off);
  ok(!off.legend && off.host === 0 && !/galaxy/.test(off.body), 'turned off: list, background and classes are gone', off);
  ok(off.patches === 0 && !off.wrapped, 'turned off: Obsidian\'s own code is restored', off);
  ok(Math.abs(off.lineA - 1) < 0.01, 'turned off: link lines are back to the theme\'s colour', off.lineA);
  await zoomTo(page, 1);
  const plain = await namesNow(page);
  ok(plain.length === 74 && plain.every((n) => n.edge === 0 && !n.marked && Math.abs(n.px - 14) < 0.01), 'turned off: note names are exactly as Obsidian draws them', plain[0]);
  const drift = await page.evaluate(() => { let moved = 0; for (const n of view.renderer.nodes) if (Math.hypot(n.x, n.y) > 0) moved++; return moved; });
  await page.shot('off');
  const kidsOff = off.kids;
  ok(kidsOff === before.hanger - 7, 'turned off: the glow and arm names are removed from the scene', { before: before.hanger, after: kidsOff });
  // and on again
  await page.evaluate(() => plugin.commands.find((c) => c.id === 'toggle').callback());
  await page.waitForTimeout(3200);
  const on = await state(page);
  ok(on.sprite && on.labels === 6 && on.legend && on.bodyOn && (await maxDrift(page)) < 0.5, 'turned on again: the galaxy re-forms', on);
  await page.shot('on-again');
  // the button in the corner of the graph view switches between the galaxy and the normal graph
  const sw0 = await page.evaluate(() => { const e = document.querySelector('.galaxy-switch'); return e && { on: e.classList.contains('is-on'), text: e.textContent }; });
  ok(sw0 && sw0.on && /Galaxy on/.test(sw0.text), 'the graph view has an on/off button showing "Galaxy on"', sw0);
  await page.click('.galaxy-switch');
  await page.waitForTimeout(1500);
  const sw1 = await page.evaluate(() => { const e = document.querySelector('.galaxy-switch'), r = view.renderer; return { there: !!e, on: e && e.classList.contains('is-on'), text: e && e.textContent, enabled: plugin.settings.enabled, legend: !!document.querySelector('.galaxy-legend'), gx: r.nodes.filter((n) => n.__gx).length, scale: r.scale, panX: r.panX, w: r.px.renderer.screen.width }; });
  ok(sw1.there && !sw1.on && /Galaxy off/.test(sw1.text) && !sw1.enabled && !sw1.legend && sw1.gx === 0, 'one tap gives the normal graph, and the button stays so you can switch back', sw1);
  ok(sw1.scale > 0.5 && Math.abs(sw1.panX - sw1.w / 2) < 1, 'the view zooms in to suit the normal graph', sw1);
  await page.click('.galaxy-switch');
  await page.waitForTimeout(3200);
  const sw2 = await state(page);
  ok(sw2.sprite && sw2.legend && sw2.bodyOn && (await maxDrift(page)) < 0.5 && Math.abs(sw2.scale - (await page.ctl()).fit.scale) < 1e-6, 'another tap brings the galaxy back, fitted to the view', sw2);
  await page.evaluate(async () => { plugin.settings.switchButton = false; await plugin.saveSettings(); });
  ok(!(await page.$('.galaxy-switch')), 'the button can be hidden in settings');
  await page.evaluate(async () => { plugin.settings.switchButton = true; await plugin.saveSettings(); });
  // full unload, as when the plugin is disabled in settings
  await page.evaluate(() => plugin.unload());
  await page.waitForTimeout(1500);
  const un = await page.evaluate(() => ({ gx: view.renderer.nodes.filter((n) => n.__gx).length, body: document.body.className, legend: !!document.querySelector('.galaxy-legend'), wrapped: !!Mock.GraphNode.prototype.getFillColor.__galaxy, vars: document.body.style.getPropertyValue('--galaxy-line-alpha') }));
  ok(un.gx === 0 && !/galaxy/.test(un.body) && !un.legend && !un.wrapped && un.vars === '' && !(await page.$('.galaxy-switch')) && !(await page.$('.galaxy-switch-host')), 'unloading the plugin leaves nothing behind', un);
  ok(errorsOf(page).length === 0, 'no errors logged', errorsOf(page));
  await page.context().close();
};

T.settings = async () => {
  const page = await open({ quiet: true });
  await page.waitForTimeout(3200);
  const set = async (patch) => { await page.evaluate(async (patch) => { Object.assign(plugin.settings, patch); await plugin.saveSettings(); }, patch); await page.waitForTimeout(1600); };
  await set({ glow: 0 });
  ok(!(await state(page)).sprite, 'arm glow 0 removes the glow');
  await set({ glow: 0.4 });
  ok(Math.abs((await state(page)).spriteAlpha - 0.4) < 1e-6, 'arm glow strength follows the slider');
  await set({ armLabels: false });
  ok((await state(page)).labels === 0, 'arm names can be switched off');
  await set({ legend: false });
  ok(!(await state(page)).legend, 'the MOC list can be switched off');
  await set({ links: 0 });
  ok((await page.evaluate(() => view.renderer.colors.line.a)) < 0.03, 'link lines 0 hides the lines');
  await set({ links: 1 });
  ok(Math.abs((await page.evaluate(() => view.renderer.colors.line.a)) - 0.28) < 0.01, 'link lines 1 shows them clearly');
  await set({ background: false });
  ok(await page.evaluate(() => getComputedStyle(view.contentEl).backgroundImage === 'none'), 'the background can be switched off');
  await set({ background: true, glow: 0.8, armLabels: true, legend: true, links: 0.5, pitch: 24, spread: 1.3 });
  const m1 = await page.evaluate(() => { const M = plugin.controllers.get(view).model; return { s: M.s, r0: M.geo.r0, b: M.geo.b }; });
  ok(Math.abs(m1.s - 182) < 0.01 && Math.abs(m1.b - Math.tan(24 * Math.PI / 180)) < 1e-6, 'winding and spacing sliders reshape the galaxy', m1);
  ok((await maxDrift(page)) < 0.5, 'notes moved to the new shape');
  await page.shot('settings-pitch24-spread13');
  await set({ pitch: 12, spread: 0.8 });
  await page.shot('settings-pitch12-spread08');
  await set({ pitch: 17, spread: 1, layout: false });
  await page.waitForTimeout(2200);
  const off = await page.evaluate(() => { const r = view.renderer, c = plugin.controllers.get(view); return { layoutOn: c.layoutOn, sprite: !!c.sprite, labels: c.labels.length, coloured: r.nodeLookup['Philosophy/Euthanasia.md'].getFillColor().rgb, size: r.nodeLookup['Scratchpad.md'].getSize(), legend: !!document.querySelector('.galaxy-legend') }; });
  ok(!off.layoutOn && !off.sprite && off.labels === 0 && off.size === 8, 'layout off: notes float freely again, no glow or arm names', off);
  ok(off.coloured === 0x78b4ff && off.legend, 'layout off: MOC colours and the list are kept', off);
  await page.shot('settings-layout-off');
  await set({ layout: true });
  await page.waitForTimeout(1500);
  ok((await maxDrift(page)) < 0.5 && (await state(page)).sprite, 'layout on again: galaxy re-forms');
  // custom centre note and MOC word
  await set({ centerNote: 'Philosophy MOC' });
  const m2 = await page.evaluate(() => { const M = plugin.controllers.get(view).model; return { core: M.ids[M.core], arms: M.arms.length }; });
  ok(m2.core === 'Philosophy/Philosophy MOC.md', 'a centre note can be chosen by name', m2);
  await set({ centerNote: '', mocText: 'Nothing', mocTag: '' });
  const m3 = await page.evaluate(() => { const M = plugin.controllers.get(view).model; return { core: M.ids[M.core], arms: M.arms.map((a) => a.segs[0].name), auto: M.auto }; });
  ok(m3.auto && m3.core === 'Home.md' && m3.arms.length === 6, 'with no MOC word it still finds Home and the six hubs by itself', m3);
  ok(errorsOf(page).length === 0, 'no errors logged', errorsOf(page));
  await page.context().close();
};

T.edits = async () => {
  const page = await open({ quiet: true });
  await page.waitForTimeout(3200);
  const digest0 = await page.evaluate(() => plugin.controllers.get(view).digest);
  // a metadata refresh with no real change must not rebuild or repaint anything
  await page.evaluate(() => { window.__sprite0 = plugin.controllers.get(view).sprite; app.__refresh(); });
  await page.waitForTimeout(1200);
  ok(await page.evaluate((d) => plugin.controllers.get(view).digest === d && plugin.controllers.get(view).sprite === window.__sprite0, digest0), 'saving a note without changing links repaints nothing');
  // add a note to Maths
  await page.evaluate(() => { const v = app.__vault; v.files.push({ path: 'Maths/Differentiation.md' }); v.links['Maths/Differentiation.md'] = []; v.links['Maths/Maths MOC.md'].push('Maths/Differentiation.md'); app.__refresh(); });
  await page.waitForTimeout(2200);
  const a = await page.evaluate(() => { const r = view.renderer, n = r.nodeLookup['Maths/Differentiation.md'], M = plugin.controllers.get(view).model; return { exists: !!n, gx: n && !!n.__gx, col: n && n.getFillColor().rgb, d: n && Math.hypot(n.x - n.__gx.tx, n.y - n.__gx.ty), count: M.legend.find((e) => e.name === 'Maths').count, repainted: plugin.controllers.get(view).sprite !== window.__sprite0 }; });
  ok(a.exists && a.gx && a.col === 0xb49cff && a.d < 0.5 && a.count === 4 && a.repainted, 'a new note joins its MOC\'s arm in the MOC\'s colour', a);
  ok((await maxDrift(page)) < 0.5, 'everything settled after the change');
  // a new MOC by tag, with its own colour
  await page.evaluate(() => { const v = app.__vault; v.files.push({ path: 'Reading/Books.md', tags: ['moc'], frontmatter: { 'galaxy-color': '#ff0000' } }); v.links['Reading/Books.md'] = []; for (const n of ['Dune', 'Emma', 'Ulysses']) { v.files.push({ path: `Reading/${n}.md` }); v.links[`Reading/${n}.md`] = []; v.links['Reading/Books.md'].push(`Reading/${n}.md`); } v.links['Home.md'].push('Reading/Books.md'); app.__refresh(); });
  await page.waitForTimeout(2600);
  const b = await page.evaluate(() => { const M = plugin.controllers.get(view).model; const sg = M.segs.find((s) => s.name === 'Books'); return { arms: M.arms.length, books: sg && { n: sg.members.length, color: sg.color }, labels: plugin.controllers.get(view).labels.length }; });
  ok(b.arms === 7 && b.books && b.books.n === 3 && b.books.color === 0xff0000 && b.labels === 7, 'a note tagged #moc becomes a new arm, in the colour set in its properties', b);
  await page.shot('edits-added-moc');
  // "Democracy" must not count as a MOC
  const dem = await page.evaluate(() => plugin.isMoc('Politics/Threats to Democracy.md'));
  ok(dem === false, '"Democracy" is not mistaken for a MOC');
  // delete a note
  await page.evaluate(() => { const v = app.__vault; v.files = v.files.filter((f) => f.path !== 'Philosophy/Euthanasia.md'); delete v.links['Philosophy/Euthanasia.md']; for (const k in v.links) v.links[k] = v.links[k].filter((d) => d !== 'Philosophy/Euthanasia.md'); app.__refresh(); });
  await page.waitForTimeout(2200);
  ok(await page.evaluate(() => !view.renderer.nodeLookup['Philosophy/Euthanasia.md'] && plugin.controllers.get(view).model.legend[0].count === 28), 'a deleted note leaves its arm');
  ok((await maxDrift(page)) < 0.5 && errorsOf(page).length === 0, 'settled, no errors', errorsOf(page));
  await page.context().close();
};

T.reset = async () => {
  const page = await open({ quiet: true });
  await page.waitForTimeout(3200);
  // Obsidian throws its graphics away and rebuilds them (this happens on an iPad when the app has been in the background)
  await page.evaluate(() => { const r = view.renderer; r.destroyGraphics(); r.initGraphics(); r.onResize(); r.changed(); });
  await page.waitForTimeout(1600);
  const s = await state(page);
  ok(s.sprite && s.labels === 6 && (await page.evaluate(() => { const c = plugin.controllers.get(view); return c.sprite.parent === view.renderer.hanger && !c.sprite._destroyed && c.labels.every((t) => t.parent === view.renderer.hanger); })), 'after a graphics reset the glow and arm names are rebuilt', s);
  await page.shot('after-reset');
  ok((await maxDrift(page)) < 0.5 && errorsOf(page).length === 0, 'notes still in place, no errors', errorsOf(page));
  await page.context().close();
};

T.resize = async () => {
  const page = await open({ quiet: true });
  await page.waitForTimeout(3200);
  const f1 = (await page.ctl()).fit;
  await page.setViewportSize({ width: 820, height: 1060 });   // iPad turned upright
  await page.waitForTimeout(1500);
  const f2 = (await page.ctl()).fit, s2 = await state(page);
  ok(f2.w === 1640 && Math.abs(s2.panX - 820) < 1 && Math.abs(s2.panY - 1060) < 1 && Math.abs(s2.scale - f2.scale) < 1e-6 && f2.scale !== f1.scale, 'turning the iPad re-fits and re-centres the galaxy', { f1: f1.scale, f2: f2.scale, s2 });
  await page.shot('portrait');
  // once the user has zoomed, a resize leaves their view alone
  await page.mouse.move(400, 500); await page.mouse.wheel(0, -480);
  await page.waitForFunction(() => view.renderer.scale === view.renderer.targetScale, null, { timeout: 20000 });
  const z = (await state(page)).scale;
  await page.setViewportSize({ width: 1000, height: 590 });
  await page.waitForTimeout(1500);
  ok(z > f2.scale * 1.5 && Math.abs((await state(page)).scale - z) < 1e-6, 'after you zoom yourself, a resize does not override your view', { z, now: (await state(page)).scale });
  await page.context().close();
  // phone
  const phone = await open({ quiet: true, width: 390, height: 700, dpr: 3 });
  await phone.waitForTimeout(3200);
  await phone.shot('phone');
  ok(!(await phone.ctl()).broken && errorsOf(phone).length === 0, 'phone-sized view works', errorsOf(phone));
  await phone.context().close();
  // desktop
  const desk = await open({ quiet: true, width: 1400, height: 880, dpr: 1, mobile: false });
  await desk.waitForTimeout(3200);
  await desk.shot('desktop');
  ok(!(await desk.ctl()).broken && errorsOf(desk).length === 0, 'desktop-sized view works', errorsOf(desk));
  await desk.context().close();
};

T.late = async () => {
  // graph already open (default layout running) when the plugin is switched on
  const page = await open({ quiet: true, pluginFirst: false });
  await page.waitForTimeout(3400);
  const s = await state(page);
  ok(s.sprite && s.labels === 6 && s.legend && (await maxDrift(page)) < 0.5, 'enabling the plugin with a graph already open works', s);
  await page.context().close();
  // local graph: colours only
  const p2 = await open({ quiet: true });
  await p2.waitForTimeout(2500);
  const res = await p2.evaluate(async () => {
    const host = document.createElement('div'); host.className = 'workspace-leaf-content'; host.style.cssText = 'position:absolute;right:0;top:0;width:420px;height:320px;z-index:9';
    document.body.appendChild(host);
    window.local = app.__open('localgraph', host, { local: 'Philosophy/Cosmological Argument.md' });
    await new Promise((r) => setTimeout(r, 1800));
    const r = local.renderer, c = plugin.controllers.get(local);
    return { nodes: r.nodes.length, global: c.isGlobal, layoutOn: c.layoutOn, sprite: !!c.sprite, legend: host.querySelectorAll('.galaxy-legend').length,
      aristotle: r.nodeLookup['Philosophy/Aristotle.md'].getFillColor().rgb, moc: r.nodeLookup['Philosophy/Philosophy MOC.md'].getFillColor().rgb, focused: r.nodeLookup['Philosophy/Cosmological Argument.md'].getFillColor() === r.colors.fillFocused,
      pinned: r.nodes.filter((n) => n.__gx && n.__gx.has).length, size: r.nodeLookup['Philosophy/Aristotle.md'].getSize(), base: Mock.GraphNode.prototype.getSize.__galaxy };
  });
  ok(res.nodes > 3 && !res.global && !res.layoutOn && !res.sprite && res.legend === 0 && res.pinned === 0, 'local graph keeps Obsidian\'s own layout (no glow, no list)', res);
  ok(res.aristotle === 0x78b4ff && res.focused, 'local graph notes take their MOC\'s colour; the open note keeps Obsidian\'s', res);
  await p2.shot('local');
  ok(errorsOf(p2).length === 0, 'no errors logged', errorsOf(p2));
  await p2.context().close();
};

T.options = async () => {
  // tags shown, attachments hidden, unresolved hidden
  const page = await open({ quiet: true, vault: 'student', graphOpts: { showTags: true, showAttachments: false, hideUnresolved: true } });
  await page.waitForTimeout(3200);
  ok(!(await page.ctl()).broken && (await maxDrift(page)) < 0.5 && errorsOf(page).length === 0, 'works with other graph filter settings', errorsOf(page));
  await page.context().close();
  // node size slider in Obsidian's own graph settings
  const p2 = await open({ quiet: true });
  await p2.waitForTimeout(3000);
  const s0 = await p2.evaluate(() => plugin.controllers.get(view).model.s);
  await p2.evaluate(() => { view.renderer.fNodeSizeMult = 2; view.renderer.changed(); });
  await p2.waitForTimeout(2200);
  const s1 = await p2.evaluate(() => ({ s: plugin.controllers.get(view).model.s, size: view.renderer.nodeLookup['Scratchpad.md'].getSize() }));
  ok(s1.s > s0 * 1.3 && Math.abs(s1.size - 8 * 2 * 1.35) < 1e-6, 'Obsidian\'s node size slider still works, and the galaxy makes room', { s0, s1 });
  await p2.shot('nodesize2');
  await p2.context().close();
};

T.perf = async () => {
  const page = await open({ quiet: true, vault: 'large', mobile: true });
  await page.waitForTimeout(6000);
  const r = await page.evaluate(() => {
    const c = plugin.controllers.get(view), I = PluginClass.internals;
    const t0 = performance.now(); for (let i = 0; i < 5; i++) c.sig = null, c.digest = null, c.rebuild(view.renderer); const tRebuild = (performance.now() - t0) / 5;
    const t1 = performance.now(); const cv = I.paintHaze(c.model, 1536, document); const tPaint = performance.now() - t1;
    const t2 = performance.now(); for (let i = 0; i < 20; i++) plugin.tick(); const tTick = (performance.now() - t2) / 20;
    // closest pair of notes, as a share of the normal gap
    const M = c.model; let min = Infinity;
    for (let i = 0; i < M.N; i++) for (let j = i + 1; j < M.N; j++) { const d = Math.hypot(M.pos[2 * i] - M.pos[2 * j], M.pos[2 * i + 1] - M.pos[2 * j + 1]); if (d < min) min = d; }
    return { nodes: M.N, tRebuild: Math.round(tRebuild), tPaint: Math.round(tPaint), tTick: +tTick.toFixed(2), minGap: +(min / M.s).toFixed(2), anim: !!c.anim };
  });
  console.log('  info', JSON.stringify(r));
  ok(r.tRebuild < 400 && r.tTick < 30, '1,500-note vault: layout and the regular check are quick', r);
  ok(r.minGap > 0.45, 'no two notes sit on top of each other', r.minGap);
  await page.waitForTimeout(3000);
  await page.evaluate(() => { const r = view.renderer, c = r.changed.bind(r); window.__changes = 0; r.changed = () => { window.__changes++; c(); }; window.__msgs = 0; const pm = r.worker.postMessage.bind(r.worker); r.worker.postMessage = (m) => { window.__msgs++; pm(m); }; });
  await page.waitForTimeout(4000);
  const idle = await page.evaluate(() => ({ changes: window.__changes, msgs: window.__msgs }));
  ok(idle.changes === 0 && idle.msgs === 0, 'idle with 1,500 notes: the plugin asks for no redraws and sends nothing', idle);
  ok((await maxDrift(page)) < 0.5 && errorsOf(page).length === 0, 'in place, no errors', errorsOf(page));
  await page.context().close();
};

T.memory = async () => {
  const { VAULTS } = require('./vaults');
  const colourOf = (page, name) => page.evaluate((name) => { const M = plugin.controllers.get(view).model; const sg = M.segs.find((s) => s.name === name); return sg ? sg.color : null; }, name);
  const orderOf = (page) => page.evaluate(() => plugin.controllers.get(view).model.arms.map((a) => a.segs[0].name));
  const page = await open({ quiet: true });
  await page.waitForTimeout(4800);
  const saved = await page.evaluate(() => window.__pluginData);
  ok(saved && saved.memory && Object.keys(saved.memory.colors).length === 6 && saved.memory.rank.length === 6, 'each MOC\'s colour and place are saved', saved && saved.memory);
  const c0 = { maths: await colourOf(page, 'Maths'), admin: await colourOf(page, 'Admin'), phil: await colourOf(page, 'Philosophy') };
  const order0 = await orderOf(page);
  await page.context().close();

  // next session: Maths has grown a little (3 -> 5 notes); nothing should swap places or colours
  const grow = (n) => { const v = VAULTS.student(); for (let i = 0; i < n; i++) { const p = `Maths/Extra ${i}.md`; v.files.push({ path: p }); v.links[p] = []; v.links['Maths/Maths MOC.md'].push(p); } return v; };
  const p2 = await open({ quiet: true, vault: grow(2), pluginData: saved });
  await p2.waitForTimeout(3200);
  ok((await colourOf(p2, 'Maths')) === c0.maths && (await colourOf(p2, 'Admin')) === c0.admin, 'next session, after Maths gains two notes: colours are unchanged');
  ok(JSON.stringify(await orderOf(p2)) === JSON.stringify(order0), 'and the arms keep their places', await orderOf(p2));
  await p2.context().close();

  // much later: Maths is clearly bigger than its neighbours, so it may move, but it keeps its colour
  const p3 = await open({ quiet: true, vault: grow(14), pluginData: saved });
  await p3.waitForTimeout(3200);
  ok((await colourOf(p3, 'Maths')) === c0.maths && (await colourOf(p3, 'Philosophy')) === c0.phil, 'when a MOC grows a lot it keeps its colour');
  ok(JSON.stringify(await orderOf(p3)) !== JSON.stringify(order0), 'and only then do the arms re-balance', await orderOf(p3));
  // renaming a MOC keeps its colour
  await p3.evaluate(() => {
    const v = app.__vault, from = 'Maths/Maths MOC.md', to = 'Maths/Mathematics MOC.md';
    v.files.find((f) => f.path === from).path = to; v.links[to] = v.links[from]; delete v.links[from];
    for (const k in v.links) v.links[k] = v.links[k].map((d) => (d === from ? to : d));
    app.__vaultEvents.trigger('rename', { path: to }, from);
    app.__refresh();
  });
  await p3.waitForTimeout(2600);
  ok((await colourOf(p3, 'Mathematics')) === c0.maths, 'a renamed MOC keeps its colour', await colourOf(p3, 'Mathematics'));
  ok(errorsOf(p3).length === 0, 'no errors logged', errorsOf(p3));
  await p3.context().close();
};

T.camera = async () => {
  const page = await open({ quiet: true });
  await page.waitForTimeout(3200);
  // zoom in on one arm, then the vault changes a lot: the view must stay where the reader put it
  await page.mouse.move(700, 300); await page.mouse.wheel(0, -480);
  await page.waitForFunction(() => view.renderer.scale === view.renderer.targetScale, null, { timeout: 20000 });
  const before = await state(page);
  await page.evaluate(() => { const v = app.__vault; for (let i = 0; i < 12; i++) { const p = `Philosophy/New note ${i}.md`; v.files.push({ path: p }); v.links[p] = []; v.links['Philosophy/Philosophy MOC.md'].push(p); } app.__refresh(); });
  await page.waitForTimeout(2600);
  const after = await state(page), fit = (await page.ctl()).fit;
  ok(Math.abs(after.scale - before.scale) < 1e-9 && Math.abs(after.panX - before.panX) < 1e-6 && Math.abs(after.panY - before.panY) < 1e-6, 'adding notes while zoomed in does not move the view', { before: before.scale, after: after.scale });
  ok(fit.scale < before.scale * 0.6 && (await maxDrift(page)) < 0.5, 'the galaxy itself did re-arrange for the new notes', fit.scale);
  // with the whole galaxy in view, the same change re-fits it
  await page.click('.galaxy-legend-btn[aria-label^="Fit"]');
  await page.waitForTimeout(500);
  await page.evaluate(() => { const v = app.__vault; for (let i = 0; i < 14; i++) { const p = `Philosophy/More ${i}.md`; v.files.push({ path: p }); v.links[p] = []; v.links['Philosophy/Philosophy MOC.md'].push(p); } app.__refresh(); });
  await page.waitForTimeout(2600);
  const s3 = await state(page), f3 = (await page.ctl()).fit;
  ok(Math.abs(s3.scale - f3.scale) < 1e-9 && f3.scale < fit.scale, 'when the whole galaxy is in view it re-fits as the galaxy grows', { s3: s3.scale, f3: f3.scale });
  ok(errorsOf(page).length === 0, 'no errors logged', errorsOf(page));
  await page.context().close();
};

T.report = async () => {
  const page = await open({ quiet: true });
  await page.waitForTimeout(3200);
  const rep = await page.evaluate(async () => { plugin.manifest.version = '2.0.0'; plugin.settingTab.display(); return plugin.diagnostics(); });
  const v = rep.views[0];
  ok(rep.pixi && rep.pixi.Sprite && rep.hooks.join(',') === 'render,getFillColor,getSize,render' && v && v.glow && v.armNames === 6 && v.drift < 0.5 && v.errors === 0, 'the diagnostic report describes a healthy view', { hooks: rep.hooks, v: v && { glow: v.glow, armNames: v.armNames, drift: v.drift, errors: v.errors } });
  const text = JSON.stringify(rep);
  ok(!/Philosophy|Politics|Aquinas|Home\.md/.test(text), 'the report contains no note names');
  ok(await page.evaluate(() => (window.__buttons || []).length === 1), 'settings page has a "Copy report" button');
  // if the optional drawing layer ever throws, the layout and colours carry on without it
  await page.evaluate(() => { const c = plugin.controllers.get(view); c.ensureScene = () => { throw new Error('simulated drawing failure'); }; });
  await page.waitForTimeout(2200);
  const c = await page.evaluate(() => { const c = plugin.controllers.get(view); return { sceneOff: c.sceneOff, broken: c.broken, sprite: !!c.sprite, legend: !!c.legendEl, lastError: c.lastError.slice(0, 40), col: view.renderer.nodeLookup['Philosophy/Euthanasia.md'].getFillColor().rgb }; });
  ok(c.sceneOff && !c.broken && !c.sprite && c.legend && c.col === 0x78b4ff && /simulated/.test(c.lastError), 'a failure in the glow layer switches only that layer off', c);
  ok((await maxDrift(page)) < 0.5, 'notes stay in the galaxy shape');
  await page.context().close();
};

(async () => {
  const which = process.argv.slice(2);
  for (const name of Object.keys(T)) {
    if (which.length && !which.includes(name)) continue;
    console.log(name);
    try { await T[name](); } catch (e) { failures++; console.log('  FAIL (threw) ' + (e.stack || e).split('\n').slice(0, 3).join(' | ')); }
  }
  await close();
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();
