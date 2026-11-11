const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { VAULTS } = require('./vaults');

const REPO = path.join(__dirname, '..');
const HERE = __dirname;
const OUT = path.join(HERE, 'out');
fs.mkdirSync(OUT, { recursive: true });

const HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:#1e1e1e;color:#dadada;font-family:ui-sans-serif,-apple-system,"Segoe UI",Roboto,Inter,sans-serif}
.workspace-leaf-content{position:absolute;inset:0;display:flex;flex-direction:column}
.view-content{flex:1;position:relative;overflow:hidden;background:#1e1e1e}
.view-content canvas{display:block}
.clickable-icon{cursor:pointer}
.graph-view.color-fill{color:#b3b3b3}
.graph-view.color-fill-focused{color:#8a5cf5}
.graph-view.color-fill-tag{color:#77c98c}
.graph-view.color-fill-unresolved{color:#b3b3b3;opacity:.5}
.graph-view.color-fill-attachment{color:#e0c060}
.graph-view.color-arrow{color:#dadada;opacity:.5}
.graph-view.color-circle{color:#8a5cf5}
.graph-view.color-line{color:#3f3f3f}
.graph-view.color-text{color:#dadada}
.graph-view.color-fill-highlight{color:#8a5cf5}
.graph-view.color-line-highlight{color:#8a5cf5}
</style></head><body class="theme-dark"><div class="workspace-leaf-content" data-type="graph"></div></body></html>`;

let browser = null;
async function getBrowser() {
  if (!browser) {
    browser = await chromium.launch({
      args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl'],
    });
  }
  return browser;
}

/**
 * Opens the simulated graph view.
 * opts: vault, width, height, dpr, mobile, pluginData, plugin (false = plain Obsidian), graphOpts, quiet
 */
async function open(opts = {}) {
  const o = Object.assign({ vault: 'student', width: 1000, height: 590, dpr: 2, mobile: true, pluginData: null, plugin: true, graphOpts: {}, quiet: false, pluginFirst: true }, opts);
  const b = await getBrowser();
  const ctx = await b.newContext({ viewport: { width: o.width, height: o.height }, deviceScaleFactor: o.dpr });
  const page = await ctx.newPage();
  const logs = [];
  page.on('console', (m) => { const t = `[${m.type()}] ${m.text()}`; logs.push(t); if (!o.quiet && m.type() !== 'log') console.log('   page', t); });
  page.on('pageerror', (e) => { logs.push('[pageerror] ' + e.message); console.log('   PAGE ERROR', e.message, (e.stack || '').split('\n').slice(0, 4).join(' | ')); });
  await page.addInitScript((m) => { window.__mobile = m; }, o.mobile);
  await page.setContent(HTML);
  await page.addScriptTag({ path: path.join(HERE, 'node_modules/pixi.js/dist/pixi.min.js') });
  await page.addScriptTag({ path: path.join(HERE, 'mock-obsidian.js') });
  await page.addStyleTag({ path: path.join(REPO, 'styles.css') });
  const vault = typeof o.vault === 'string' ? VAULTS[o.vault]() : o.vault;
  let code = fs.readFileSync(path.join(REPO, 'main.js'), 'utf8');
  for (const [a, b] of o.patch || []) { if (!code.includes(a)) throw new Error('patch target missing: ' + a); code = code.split(a).join(b); }
  await page.evaluate(async ({ vault, code, o }) => {
    window.__pluginData = o.pluginData;
    window.app = Mock.makeApp(vault);
    const host = document.querySelector('.workspace-leaf-content');
    window.loadPlugin = async () => {
      const module = { exports: {} };
      new Function('module', 'exports', 'require', code)(module, module.exports, (n) => { if (n === 'obsidian') return Mock.obsidian; throw new Error('no module ' + n); });
      window.PluginClass = module.exports;
      window.plugin = new module.exports(window.app, { id: 'galaxy-graph' });
      await window.plugin.onload();
    };
    if (o.plugin && o.pluginFirst) await window.loadPlugin();
    window.view = window.app.__open('graph', host, o.graphOpts);
    if (o.plugin && !o.pluginFirst) await window.loadPlugin();
  }, { vault, code, o });
  page.logs = logs;
  page.shot = async (name) => { const p = path.join(OUT, name + '.png'); await page.screenshot({ path: p }); return p; };
  page.ctl = () => page.evaluate(() => { const c = plugin.controllers.get(view); return c ? { layoutOn: c.layoutOn, broken: c.broken, errors: c.errors, strikes: c.strikes, anim: !!c.anim, fit: c.fit, sprite: !!c.sprite, labels: c.labels.length, legend: !!c.legendEl } : null; });
  return page;
}

async function close() { if (browser) { await browser.close(); browser = null; } }

module.exports = { open, close, OUT, REPO, VAULTS };
