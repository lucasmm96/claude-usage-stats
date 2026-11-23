#!/usr/bin/env node
// Zero-dependency visual checks for the report.
// Starts a local HTTP server, drives headless Chrome/Edge through CDP, writes
// screenshots + manifest to tests/artifacts/visual/ and exits 1 on failures.
import fs from 'fs';
import http from 'http';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPORT = path.join(ROOT, 'report');
const EX_JSON = path.join(ROOT, 'examples', 'sessions.example.json');
const CACHE = path.join(ROOT, 'tests', '.cache');
const ARTIFACTS = path.join(ROOT, 'tests', 'artifacts', 'visual');
const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = path.join(ARTIFACTS, RUN_ID);
const FILTER = (process.argv.find(a => a.startsWith('--filter=')) || '').split('=')[1] || '';

fs.mkdirSync(CACHE, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function shiftToOldDates(data) {
  const old = value => {
    const d = new Date(value);
    d.setUTCFullYear(2020);
    return d.toISOString();
  };
  for (const s of Object.values(data.sessions)) {
    if (s.started_at) s.started_at = old(s.started_at);
    if (s.last_activity_at) s.last_activity_at = old(s.last_activity_at);
    for (const e of s.log || []) if (e.at) e.at = old(e.at);
  }
  return data;
}

function makePrice(model, input, output = input * 4) {
  return {
    input, cacheRead: input / 10, cacheWrite: input * 1.25, output,
    source: 'manual', syncAt: null, lastAttemptAt: null, autoFailed: false, history: [],
  };
}

function makeFixtures(example) {
  const emptyFile = { sessions: {} };
  const oldDates = shiftToOldDates(clone(example));

  const many = clone(example);
  const first = Object.values(many.sessions)[0];
  const names = Array.from({ length: 18 }, (_, i) => `Very Long Model Name Number ${String(i + 1).padStart(2, '0')} (Free)`);
  first.session_name = 'Many models';
  first.model = names[0];
  first.log = names.map((model, i) => ({
    at: `2026-11-22T${String(10 + Math.floor(i / 6)).padStart(2, '0')}:${String((i % 6) * 10).padStart(2, '0')}:00.000Z`,
    input_tokens: 1000 + i * 100,
    cache_read_tokens: 5000 + i * 250,
    cache_write_tokens: 100 + i * 10,
    output_tokens: 200 + i * 25,
    context_pct: 20 + i,
    model,
  }));
  first.last_activity_at = '2026-11-22T13:00:00.000Z';

  const standardPrices = {
    'Nemotron 3.5 Lightning (Free)': makePrice('Nemotron 3.5 Lightning (Free)', 0, 0),
    'Dots 3 Note Preview (Free)': makePrice('Dots 3 Note Preview (Free)', 0, 0),
    'Sonnet 4.6': makePrice('Sonnet 4.6', 3, 15),
    'Opus 5.5': makePrice('Opus 5.5', 4, 20),
  };
  const partialPrices = { 'Sonnet 4.6': makePrice('Sonnet 4.6', 3, 15) };

  return {
    'standard': example,
    'empty-file': emptyFile,
    'old-dates': oldDates,
    'many-models': many,
    'priced': { data: example, prices: standardPrices },
    'partial-priced': { data: example, prices: partialPrices },
  };
}

const fixtures = makeFixtures(JSON.parse(fs.readFileSync(EX_JSON, 'utf8')));
const fixtureBodies = new Map();
for (const [name, value] of Object.entries(fixtures)) {
  const payload = value.data ? value.data : value;
  fixtureBodies.set(name, JSON.stringify(payload));
}

function safeFile(base, rel) {
  const abs = path.resolve(base, rel);
  const prefix = path.resolve(base) + path.sep;
  return abs.startsWith(prefix) ? abs : null;
}

function serveFile(res, file) {
  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
    return;
  }
  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': 'no-store',
  });
  res.end(fs.readFileSync(file));
}

function startServer() {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      const pathname = decodeURIComponent(url.pathname);
      if (pathname === '/examples/sessions.example.json') return serveFile(res, EX_JSON);
      if (pathname.startsWith('/__fixtures/')) {
        const name = pathname.slice('/__fixtures/'.length).replace(/\.json$/, '');
        if (!fixtureBodies.has(name)) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('not found');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(fixtureBodies.get(name));
        return;
      }
      if (pathname === '/report' || pathname === '/report/') {
        return serveFile(res, path.join(REPORT, 'index.html'));
      }
      if (pathname.startsWith('/report/')) {
        return serveFile(res, safeFile(REPORT, pathname.slice('/report/'.length)));
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function browserPath() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  return candidates.find(p => fs.existsSync(p));
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitFor(fn, timeout = 15000, interval = 100) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await fn()) return true;
    await sleep(interval);
  }
  return false;
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.next = 0;
    this.pending = new Map();
    this.exceptions = [];
    this.consoleErrors = [];
    this.dialog = null;
    ws.onmessage = event => {
      const msg = JSON.parse(event.data);
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails || {};
        this.exceptions.push(d.text + ' ' + (d.exception?.description || ''));
      }
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        this.consoleErrors.push((msg.params.args || []).map(a => a.value || a.description || '').join(' '));
      }
      if (msg.method === 'Page.javascriptDialogOpening') {
        this.dialog = msg.params.message;
        this.send('Page.handleJavaScriptDialog', { accept: false }).catch(() => {});
      }
      if (msg.id && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
      }
    };
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = reject;
    });
    return new CDP(ws);
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.next;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text + ' ' + (result.exceptionDetails.exception?.description || ''));
    }
    return result.result.value;
  }

  close() {
    this.ws.close();
  }
}

async function launchBrowser() {
  const exe = browserPath();
  if (!exe) throw new Error('Chrome/Edge not found. Set CHROME_PATH.');
  const profile = path.join(CACHE, `chrome-profile-${process.pid}`);
  fs.rmSync(profile, { recursive: true, force: true });
  fs.mkdirSync(profile, { recursive: true });
  const child = spawn(exe, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    `--user-data-dir=${profile}`,
    'about:blank',
  ], { stdio: 'ignore' });

  const portFile = path.join(profile, 'DevToolsActivePort');
  const ready = await waitFor(() => fs.existsSync(portFile), 15000, 100);
  if (!ready) {
    child.kill();
    throw new Error(`Chrome did not expose DevToolsActivePort at ${portFile}`);
  }
  const [portLine] = fs.readFileSync(portFile, 'utf8').split('\n');
  const port = Number(portLine.trim());
  if (!port) throw new Error('Invalid DevTools port');

  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = targets.find(t => t.type === 'page');
  if (!page) throw new Error('No Chrome page target');

  return { child, profile, port, cdp: await CDP.connect(page.webSocketDebuggerUrl) };
}

async function closeBrowser(browser) {
  try { browser.cdp.close(); } catch (e) {}
  try { browser.child.kill(); } catch (e) {}
  await sleep(300);
  try { fs.rmSync(browser.profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch (e) {}
}

let currentEmulation = null;

async function setupState(cdp, options) {
  currentEmulation = options;
  const { viewport, scheme, reducedMotion, reducedTransparency, contrast } = options;
  await cdp.send('Emulation.setDeviceMetricsOverride', viewport);
  const features = [{ name: 'prefers-color-scheme', value: scheme || 'dark' }];
  if (reducedMotion) features.push({ name: 'prefers-reduced-motion', value: 'reduce' });
  if (reducedTransparency) features.push({ name: 'prefers-reduced-transparency', value: 'reduce' });
  if (contrast) features.push({ name: 'prefers-contrast', value: 'more' });
  await cdp.send('Emulation.setEmulatedMedia', { features });
}

async function navigate(cdp, url, scriptSource, predicate, timeout = 15000) {
  const added = await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: scriptSource || 'try{localStorage.clear()}catch(e){}' });
  try {
    await cdp.send('Page.navigate', { url });
    await waitFor(() => cdp.eval("document.readyState === 'complete'"), timeout);
    if (!scriptSource) {
      await cdp.eval(`try {
        localStorage.clear();
        if (typeof updatePricingButton === 'function') updatePricingButton();
        if (typeof globalData !== 'undefined' && globalData) renderAll();
      } catch (e) {}`);
    }
    if (currentEmulation) await setupState(cdp, currentEmulation);
    await sleep(150);
    const ready = typeof predicate === 'function' ? predicate : () => cdp.eval(predicate);
    await waitFor(ready, timeout);
    await sleep(300);
  } finally {
    await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: added.identifier }).catch(() => {});
  }
}

async function capture(cdp, name) {
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const file = path.join(OUT, `${name}.png`);
  const buffer = Buffer.from(shot.data, 'base64');
  fs.writeFileSync(file, buffer);
  return { file: path.relative(ROOT, file).split(path.sep).join('/'), bytes: buffer.length, buffer };
}

function check(list, name, condition, detail = '') {
  list.push({ name, pass: !!condition, detail: condition ? '' : detail });
}

const desktop = { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false };
const mobile = { width: 390, height: 844, deviceScaleFactor: 2, mobile: true };

function seedScript(prices) {
  if (!prices) return 'try{localStorage.clear()}catch(e){}';
  const data = {
    version: 2,
    prices,
    _default: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
  };
  return `try{localStorage.clear();localStorage.setItem('claude_usage_stats_pricing',${JSON.stringify(JSON.stringify(data))})}catch(e){}`;
}

async function stateEmpty(ctx) {
  const { cdp, port } = ctx;
  const checks = [];
  await setupState(cdp, { viewport: desktop, scheme: 'dark' });
  await navigate(cdp, `http://127.0.0.1:${port}/report/?v=${Date.now()}`, null,
    "document.querySelector('.empty-app') && getComputedStyle(document.querySelector('.empty-app')).display !== 'none'");
  const data = await cdp.eval(`({
    hasData: document.body.classList.contains('has-data'),
    empty: getComputedStyle(document.querySelector('.empty-app')).display,
    main: getComputedStyle(document.getElementById('main')).display,
    title: document.getElementById('empty-title').textContent
  })`);
  check(checks, 'empty app visible', data.empty !== 'none', JSON.stringify(data));
  check(checks, 'main hidden', data.main === 'none', data.main);
  check(checks, 'no data class', !data.hasData, JSON.stringify(data));
  const shot = await capture(cdp, 'empty-dark-1440x1000');
  return { checks, screenshots: [shot] };
}

async function stateEmptyFile(ctx) {
  const { cdp, port } = ctx;
  const checks = [];
  await setupState(cdp, { viewport: desktop, scheme: 'dark' });
  await navigate(cdp, `http://127.0.0.1:${port}/report/?data=${encodeURIComponent(`http://127.0.0.1:${port}/__fixtures/empty-file.json`)}&v=${Date.now()}`, null,
    "document.getElementById('empty-title') && document.getElementById('empty-title').textContent === 'No sessions found'");
  const title = await cdp.eval("document.getElementById('empty-title').textContent");
  check(checks, 'empty-file copy', title === 'No sessions found', title);
  const shot = await capture(cdp, 'empty-file-1440x1000');
  return { checks, screenshots: [shot] };
}

async function standardState(ctx, name, scheme) {
  const { cdp, port } = ctx;
  const checks = [];
  await setupState(cdp, { viewport: desktop, scheme });
  await navigate(cdp, `http://127.0.0.1:${port}/report/?data=${encodeURIComponent(`http://127.0.0.1:${port}/examples/sessions.example.json`)}&v=${Date.now()}`, null,
    "document.body.classList.contains('has-data') && document.querySelectorAll('.sess-item').length > 0 && !!window.Chart");
  const data = await cdp.eval(`({
    sessions: document.querySelectorAll('.sess-item').length,
    stats: document.getElementById('s-count').textContent,
    detail: document.getElementById('detail').textContent.trim().length,
    canvases: [...document.querySelectorAll('canvas')].map(c => ({ id: c.id, label: c.getAttribute('aria-label'), role: c.getAttribute('role'), painted: (() => { const d = c.getContext('2d').getImageData(0,0,c.width,c.height).data; for (let i = 3; i < d.length; i += 4) if (d[i]) return true; return false; })() })),
    overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    bg: getComputedStyle(document.body).backgroundColor
  })`);
  check(checks, 'sessions rendered', data.sessions > 0, String(data.sessions));
  check(checks, 'stats populated', data.stats !== '0' && data.stats !== '—', data.stats);
  check(checks, 'detail rendered', data.detail > 0, String(data.detail));
  check(checks, 'no horizontal overflow', !data.overflow, String(data.overflow));
  for (const c of data.canvases.filter(c => c.id)) {
    check(checks, `canvas ${c.id} role`, c.role === 'img', JSON.stringify(c));
    check(checks, `canvas ${c.id} label`, !!c.label, JSON.stringify(c));
  }
  const shot = await capture(cdp, `standard-${scheme}-1440x1000`);
  return { checks, screenshots: [shot], bg: data.bg };
}

async function filteredEmptyState(ctx) {
  const { cdp, port } = ctx;
  const checks = [];
  await setupState(cdp, { viewport: desktop, scheme: 'dark' });
  await navigate(cdp, `http://127.0.0.1:${port}/report/?data=${encodeURIComponent(`http://127.0.0.1:${port}/__fixtures/old-dates.json`)}&v=${Date.now()}`, null,
    "document.body.classList.contains('has-data') && document.querySelectorAll('.sess-item').length > 0");
  await cdp.eval("document.querySelector('.range-btn[data-range=\"month\"]').click()");
  await sleep(500);
  const data = await cdp.eval(`({
    listEmpty: !!document.querySelector('.list-empty'),
    dailyEmpty: getComputedStyle(document.querySelector('.daily-empty')).display,
    canvas: getComputedStyle(document.getElementById('c-daily')).display,
    label: document.getElementById('c-daily').getAttribute('aria-label'),
    scope: document.getElementById('date-scope').textContent
  })`);
  check(checks, 'list empty state', data.listEmpty, JSON.stringify(data));
  check(checks, 'daily empty state', data.dailyEmpty === 'flex', JSON.stringify(data));
  check(checks, 'daily canvas hidden', data.canvas === 'none', data.canvas);
  check(checks, 'stale canvas label removed', !data.label, String(data.label));
  const shot = await capture(cdp, 'filtered-empty-dark-1440x1000');
  return { checks, screenshots: [shot] };
}

async function manyModelsState(ctx) {
  const { cdp, port } = ctx;
  const checks = [];
  await setupState(cdp, { viewport: desktop, scheme: 'dark' });
  await navigate(cdp, `http://127.0.0.1:${port}/report/?data=${encodeURIComponent(`http://127.0.0.1:${port}/__fixtures/many-models.json`)}&v=${Date.now()}`, null,
    "document.body.classList.contains('has-data') && document.querySelectorAll('.chart-legend-item').length >= 10");
  const data = await cdp.eval(`({
    legend: document.querySelectorAll('.chart-legend-item').length,
    overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    height: document.querySelector('.daily-chart-wrap').getBoundingClientRect().height
  })`);
  check(checks, 'legend has many models', data.legend >= 10, String(data.legend));
  check(checks, 'no horizontal overflow', !data.overflow, String(data.overflow));
  const shot = await capture(cdp, 'many-models-dark-1440x1000');
  return { checks, screenshots: [shot] };
}

async function pricedState(ctx, name, prices, expectWarning) {
  const { cdp, port } = ctx;
  const checks = [];
  await setupState(cdp, { viewport: desktop, scheme: 'dark' });
  await navigate(cdp, `http://127.0.0.1:${port}/report/?data=${encodeURIComponent(`http://127.0.0.1:${port}/examples/sessions.example.json`)}&v=${Date.now()}`, seedScript(prices),
    "document.body.classList.contains('has-data') && document.getElementById('s-cost-stat').style.display !== 'none'");
  const data = await cdp.eval(`({
    cost: document.getElementById('s-cost').textContent.trim(),
    warning: !!document.querySelector('.cost-warning'),
    costStat: getComputedStyle(document.getElementById('s-cost-stat')).display
  })`);
  check(checks, 'cost stat visible', data.costStat !== 'none', JSON.stringify(data));
  check(checks, 'cost has value', /\$/.test(data.cost), data.cost);
  check(checks, 'unpriced warning state', expectWarning ? data.warning : !data.warning, JSON.stringify(data));
  const shot = await capture(cdp, `${name}-1440x1000`);
  return { checks, screenshots: [shot] };
}

async function dailyModalState(ctx) {
  const { cdp, port } = ctx;
  const checks = [];
  const prices = fixtures.priced.prices;
  await setupState(cdp, { viewport: desktop, scheme: 'dark' });
  await navigate(cdp, `http://127.0.0.1:${port}/report/?data=${encodeURIComponent(`http://127.0.0.1:${port}/examples/sessions.example.json`)}&v=${Date.now()}`, seedScript(prices),
    "document.body.classList.contains('has-data') && !!window.Chart && !!Chart.getChart('c-daily')");
  const point = await cdp.eval(`(() => {
    const chart = Chart.getChart('c-daily');
    const meta = chart.getDatasetMeta(0);
    const el = meta.data[meta.data.length - 1];
    const rect = chart.canvas.getBoundingClientRect();
    return { x: rect.left + el.x, y: rect.top + chart.chartArea.bottom - 8 };
  })()`);
  await cdp.eval(`(() => {
    const canvas = document.getElementById('c-daily');
    canvas.dispatchEvent(new MouseEvent('click', { clientX: ${point.x}, clientY: ${point.y}, bubbles: true }));
    return true;
  })()`);
  const opened = await waitFor(() => cdp.eval("document.getElementById('daily-modal-overlay').classList.contains('open')"), 4000);
  const data = await cdp.eval(`({
    open: document.getElementById('daily-modal-overlay').classList.contains('open'),
    focusInside: document.getElementById('daily-modal-overlay').contains(document.activeElement),
    active: document.activeElement.className,
    pieLabels: [...document.querySelectorAll('.daily-modal-pie canvas')].map(c => c.getAttribute('aria-label')),
    pieRoles: [...document.querySelectorAll('.daily-modal-pie canvas')].map(c => c.getAttribute('role')),
    trigger: document.getElementById('c-daily').getAttribute('tabindex')
  })`);
  check(checks, 'daily modal opens', opened && data.open, JSON.stringify(data));
  check(checks, 'focus enters dialog', data.focusInside, JSON.stringify(data));
  check(checks, 'pie canvases labeled', data.pieLabels.every(Boolean), JSON.stringify(data.pieLabels));
  check(checks, 'pie canvases role=img', data.pieRoles.every(r => r === 'img'), JSON.stringify(data.pieRoles));
  check(checks, 'daily canvas keyboard-focusable', data.trigger === '0', String(data.trigger));
  const shot = await capture(cdp, 'daily-modal-dark-1440x1000');
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await waitFor(() => cdp.eval("!document.getElementById('daily-modal-overlay').classList.contains('open')"), 4000);
  const closed = await cdp.eval(`({
    open: document.getElementById('daily-modal-overlay').classList.contains('open'),
    focus: document.activeElement.id,
    inside: document.getElementById('daily-modal-overlay').contains(document.activeElement)
  })`);
  check(checks, 'Escape closes dialog', !closed.open, JSON.stringify(closed));
  check(checks, 'focus returns to chart', closed.focus === 'c-daily' && !closed.inside, JSON.stringify(closed));
  return { checks, screenshots: [shot] };
}

async function mobileState(ctx) {
  const { cdp, port } = ctx;
  const checks = [];
  await setupState(cdp, { viewport: mobile, scheme: 'dark' });
  await navigate(cdp, `http://127.0.0.1:${port}/report/?data=${encodeURIComponent(`http://127.0.0.1:${port}/examples/sessions.example.json`)}&v=${Date.now()}`, null,
    "document.body.classList.contains('has-data')");
  const data = await cdp.eval(`({
    overflow: document.documentElement.scrollWidth > innerWidth + 1,
    header: Math.round(document.querySelector('header').getBoundingClientRect().height),
    menu: getComputedStyle(document.getElementById('load-menu')).display,
    viewport: { inner: innerWidth, client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth },
    over: [...document.querySelectorAll('*')].filter(el => el.getBoundingClientRect().right > innerWidth + 1).slice(0, 8).map(el => ({ tag: el.tagName, id: el.id, cls: String(el.className).slice(0, 40), right: Math.round(el.getBoundingClientRect().right) }))
  })`);
  check(checks, 'mobile no horizontal overflow', !data.overflow, JSON.stringify(data));
  check(checks, 'mobile menu closed by default', data.menu === 'none', JSON.stringify(data));
  check(checks, 'mobile viewport applied', data.viewport.inner <= 420, JSON.stringify(data.viewport));
  await cdp.eval("document.getElementById('open-btn').click()");
  await sleep(250);
  const menu = await cdp.eval(`({
    open: document.getElementById('load-menu').classList.contains('open'),
    expanded: document.getElementById('open-btn').getAttribute('aria-expanded'),
    display: getComputedStyle(document.getElementById('load-menu')).display
  })`);
  check(checks, 'mobile menu opens', menu.open && menu.expanded === 'true' && menu.display !== 'none', JSON.stringify(menu));
  await cdp.eval("closeLoadMenu()");
  await sleep(200);
  const targets = await cdp.eval(`(() => {
    showUndoToast('visual check', () => {});
    const els = [...document.querySelectorAll('button, [role="button"], .sess-item, .filter-dropdown-row, .p-free-label, .toast-action')]
      .filter(el => el.offsetParent !== null && getComputedStyle(el).visibility !== 'hidden' && !el.disabled);
    const result = els.map(el => ({ tag: el.tagName, cls: el.className, h: Math.round(el.getBoundingClientRect().height), w: Math.round(el.getBoundingClientRect().width) }));
    hideToast();
    return result;
  })()`);
  const small = targets.filter(t => t.h < 44);
  check(checks, 'touch targets >=44px', small.length === 0, JSON.stringify(small.slice(0, 8)));
  check(checks, 'toast action measured', targets.some(t => String(t.cls).includes('toast-action')), JSON.stringify(targets.slice(-3)));
  const shot = await capture(cdp, 'mobile-dark-390x844');
  return { checks, screenshots: [shot] };
}

async function mediaState(ctx, name, media) {
  const { cdp, port } = ctx;
  const checks = [];
  await setupState(cdp, { viewport: desktop, scheme: 'dark', ...media });
  await navigate(cdp, `http://127.0.0.1:${port}/report/?data=${encodeURIComponent(`http://127.0.0.1:${port}/examples/sessions.example.json`)}&v=${Date.now()}`, null,
    "document.body.classList.contains('has-data') && !!window.Chart");
  const data = await cdp.eval(`({
    animationOff: typeof tokChart !== 'undefined' && !!tokChart && tokChart.options.animation === false,
    reducedMotionMatch: matchMedia('(prefers-reduced-motion: reduce)').matches,
    animation: typeof tokChart !== 'undefined' && tokChart ? JSON.stringify(tokChart.options.animation) : null,
    headerFilter: getComputedStyle(document.querySelector('.detail-header')).backdropFilter,
    overlayFilter: getComputedStyle(document.querySelector('.modal-overlay')).backdropFilter,
    tooltipFilter: getComputedStyle(document.querySelector('.chart-tooltip')).backdropFilter,
    contrastBorder: getComputedStyle(document.querySelector('.detail-header')).borderBottomWidth,
    mutedColor: getComputedStyle(document.querySelector('.stat-label')).color,
    bodyColor: getComputedStyle(document.body).color
  })`);
  if (media.reducedMotion) check(checks, 'chart animation disabled', data.animationOff, JSON.stringify(data));
  if (media.reducedTransparency) {
    check(checks, 'header transparency removed', data.headerFilter === 'none', data.headerFilter);
    check(checks, 'overlay transparency removed', data.overlayFilter === 'none', data.overlayFilter);
    check(checks, 'tooltip transparency removed', data.tooltipFilter === 'none', data.tooltipFilter);
  }
  if (media.contrast) {
    check(checks, 'contrast header border', data.contrastBorder !== '0px', data.contrastBorder);
    check(checks, 'contrast muted text', data.mutedColor === data.bodyColor, JSON.stringify(data));
  }
  const shot = await capture(cdp, `${name}-1440x1000`);
  return { checks, screenshots: [shot] };
}

async function run() {
  const { server, port } = await startServer();
  let browser;
  const results = [];
  const failures = [];
  try {
    browser = await launchBrowser();
    const cdp = browser.cdp;
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');
    await cdp.send('Network.setBlockedURLs', { urls: ['*configs.portkey.ai*', '*api.github.com*'] });

    const ctx = { cdp, port };
    const states = [
      ['empty', () => stateEmpty(ctx)],
      ['empty-file', () => stateEmptyFile(ctx)],
      ['standard-dark', () => standardState(ctx, 'standard-dark', 'dark')],
      ['standard-light', () => standardState(ctx, 'standard-light', 'light')],
      ['filtered-empty', () => filteredEmptyState(ctx)],
      ['many-models', () => manyModelsState(ctx)],
      ['priced', () => pricedState(ctx, 'priced', fixtures.priced.prices, false)],
      ['partial-priced', () => pricedState(ctx, 'partial-priced', fixtures['partial-priced'].prices, true)],
      ['daily-modal', () => dailyModalState(ctx)],
      ['mobile', () => mobileState(ctx)],
      ['reduced-motion', () => mediaState(ctx, 'reduced-motion', { reducedMotion: true })],
      ['reduced-transparency', () => mediaState(ctx, 'reduced-transparency', { reducedTransparency: true })],
      ['contrast', () => mediaState(ctx, 'contrast', { contrast: true })],
    ];
    const selected = states.filter(([name]) => !FILTER || name.includes(FILTER));
    if (!selected.length) throw new Error(`No visual state matches --filter=${FILTER}`);

    const bgs = {};
    for (const [name, fn] of selected) {
      if (cdp.exceptions.length || cdp.consoleErrors.length) {
        failures.push({ state: name, error: [...cdp.exceptions, ...cdp.consoleErrors].join('\n') });
        cdp.exceptions.length = 0;
        cdp.consoleErrors.length = 0;
      }
      try {
        const result = await fn();
        const failed = result.checks.filter(c => !c.pass);
        if (result.bg) bgs[name] = result.bg;
        results.push({ name, checks: result.checks, screenshots: result.screenshots.map(s => ({ file: s.file, bytes: s.bytes })) });
        for (const f of failed) failures.push({ state: name, check: f.name, detail: f.detail });
        if (cdp.exceptions.length || cdp.consoleErrors.length) {
          failures.push({ state: name, error: [...cdp.exceptions, ...cdp.consoleErrors].join('\n') });
          cdp.exceptions.length = 0;
          cdp.consoleErrors.length = 0;
        }
      } catch (err) {
        failures.push({ state: name, error: err.stack || err.message });
        cdp.exceptions.length = 0;
        cdp.consoleErrors.length = 0;
      }
    }
    if (bgs['standard-dark'] && bgs['standard-light']) {
      if (bgs['standard-dark'] === bgs['standard-light']) {
        failures.push({ state: 'theme', check: 'dark/light differ', detail: bgs['standard-dark'] });
      }
    }
  } finally {
    if (browser) await closeBrowser(browser);
    server.close();
  }

  const manifest = {
    runId: RUN_ID,
    generatedAt: new Date().toISOString(),
    browser: browserPath(),
    filter: FILTER || null,
    results,
    failures,
  };
  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

  console.log(`visual artifacts: ${path.relative(ROOT, OUT).split(path.sep).join('/')}`);
  console.log(`visual checks: ${failures.length ? 'FAIL' : 'PASS'} (${results.length} states, ${failures.length} failure(s))`);
  for (const failure of failures) console.log('  ' + JSON.stringify(failure));
  process.exit(failures.length ? 1 : 0);
}

run().catch(err => {
  console.error(err.stack || err.message);
  process.exit(1);
});
