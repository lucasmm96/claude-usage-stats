#!/usr/bin/env node
// Zero-dependency design checks for the report.
// Default is advisory: findings print as warnings and exit 0.
// --strict exits 1 when findings remain after the baseline.
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPORT = path.join(ROOT, 'report');
const args = process.argv.slice(2);
const STRICT = args.includes('--strict');
const JSON_OUT = args.includes('--json');
const findings = [];
const notes = [];

const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = rel => fs.existsSync(path.join(ROOT, rel));
const lineAt = (text, index) => text.slice(0, index).split('\n').length;
const relOf = abs => path.relative(ROOT, abs).split(path.sep).join('/');
const normalize = s => s.replace(/\s+/g, ' ').trim();

function add(rule, file, line, message, match = '') {
  findings.push({ rule, file, line, message, match: normalize(match) });
}

function stripCssComments(text) {
  const clean = text.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '));
  return { clean, unclosed: clean.includes('/*') };
}

function stripJsComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:\\])\/\/[^\n]*/g, '$1');
}

function parseCss(text) {
  const { clean, unclosed } = stripCssComments(text);
  const rules = [];
  let buf = '';
  let quote = null;
  const stack = [];
  let negative = false;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (quote) {
      buf += ch;
      if (ch === quote && clean[i - 1] !== '\\') quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; buf += ch; continue; }
    if (ch === '{') {
      stack.push(buf.trim());
      buf = '';
    } else if (ch === '}') {
      const prelude = stack.pop();
      if (prelude === undefined) negative = true;
      else if (prelude && !prelude.startsWith('@')) {
        rules.push({ selector: prelude, body: buf, atRules: [...stack], line: lineAt(clean, i) });
      }
      buf = '';
    } else {
      buf += ch;
    }
  }
  return { rules, clean, unclosed, negative, unclosedBraces: stack.length > 0 };
}

function declarations(body) {
  return body.split(';').map(part => {
    const idx = part.indexOf(':');
    if (idx === -1) return null;
    return { property: part.slice(0, idx).trim().toLowerCase(), value: part.slice(idx + 1).trim() };
  }).filter(Boolean);
}

function selectors(rule) {
  return rule.selector.split(',').map(s => normalize(s)).filter(Boolean);
}

function normalizeSelector(sel) {
  return normalize(sel)
    .replace(/::?(hover|active|focus|focus-visible|before|after|first-child|last-child|nth-child\([^)]*\))/g, '')
    .trim();
}

const html = read('report/index.html');
const cssFiles = fs.readdirSync(path.join(REPORT, 'css')).filter(f => f.endsWith('.css')).sort();
const jsFiles = fs.readdirSync(path.join(REPORT, 'js')).filter(f => f.endsWith('.js')).sort();
const css = new Map(cssFiles.map(f => [f, parseCss(read(`report/css/${f}`))]));
const js = new Map(jsFiles.map(f => [f, stripJsComments(read(`report/js/${f}`))]));
const allCss = [...css.values()].map(v => v.clean).join('\n');
const allJs = [...js.values()].join('\n');

// --- Structure ---
for (const [file, parsed] of css) {
  if (parsed.unclosed) add('css-structure', `report/css/${file}`, 1, 'Unclosed CSS comment');
  if (parsed.negative) add('css-structure', `report/css/${file}`, 1, 'Unexpected closing brace');
  if (parsed.unclosedBraces) add('css-structure', `report/css/${file}`, 1, 'Unclosed CSS block');
}

const scriptSrcs = [...html.matchAll(/<script\s+src="(js\/[^"]+)"/g)].map(m => m[1].replace('js/', ''));
const bundled = scriptSrcs.map(f => read(`report/js/${f}`)).join('\n;\n');
try {
  new vm.Script(bundled, { filename: 'report/js/_bundle.check.js' });
} catch (err) {
  add('syntax-bundle', 'report/index.html', 1, `Bundled report scripts fail to parse: ${err.message}`, err.message);
}

for (const file of jsFiles) {
  const count = scriptSrcs.filter(f => f === file).length;
  if (count === 0) add('script-coverage', `report/js/${file}`, 1, 'Script is not loaded by report/index.html');
  if (count > 1) add('script-coverage', `report/js/${file}`, 1, 'Script is loaded more than once');
}
if (scriptSrcs[0] !== 'config.js') add('script-coverage', 'report/index.html', 1, 'config.js must load first');
if (scriptSrcs[scriptSrcs.length - 1] !== 'main.js') add('script-coverage', 'report/index.html', 1, 'main.js must load last');

// --- Assets and IDs ---
for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
  const target = m[1];
  if (/^(https?:|data:|#|mailto:)/.test(target)) continue;
  const local = path.join(REPORT, target.split('?')[0]);
  if (!fs.existsSync(local)) add('assets', 'report/index.html', lineAt(html, m.index), `Missing local asset: ${target}`, target);
}
for (const [file, parsed] of css) {
  for (const m of parsed.clean.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)) {
    const target = m[1].trim();
    if (/^(https?:|data:)/.test(target)) continue;
    const local = path.resolve(path.join(REPORT, 'css'), target);
    if (!fs.existsSync(local)) add('assets', `report/css/${file}`, lineAt(parsed.clean, m.index), `Missing CSS asset: ${target}`, target);
  }
}
const ids = new Map();
for (const m of html.matchAll(/\bid="([^"]+)"/g)) ids.set(m[1], (ids.get(m[1]) || 0) + 1);
for (const [id, count] of ids) {
  if (count > 1) add('duplicate-ids', 'report/index.html', 1, `Duplicate id: ${id}`, id);
}

// --- Tokens ---
const definitions = new Set();
for (const text of [...css.values()].map(v => v.clean)) {
  for (const m of text.matchAll(/--([\w-]+)\s*:/g)) definitions.add(m[1]);
}
const uses = new Set();
for (const m of allCss.matchAll(/var\(\s*--([\w-]+)/g)) uses.add(m[1]);
for (const m of allJs.matchAll(/cssVar\(\s*'--([\w-]+)'\s*\)/g)) uses.add(m[1]);
for (const m of html.matchAll(/var\(\s*--([\w-]+)/g)) uses.add(m[1]);
for (const name of uses) {
  if (!definitions.has(name)) add('tokens-defined', 'report', 1, `Undefined CSS token: --${name}`, `--${name}`);
}

// --- Raw colors ---
function colorFindings(file, text, isCss) {
  const clean = isCss ? stripCssComments(text).clean : stripJsComments(text);
  for (const m of clean.matchAll(/(?<!&)#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsl\([^)]*\)/g)) {
    const value = m[0];
    if (/rgba?\(\s*var\(/.test(value)) continue;
    if (value.includes('${')) continue;
    if (value.toLowerCase() === 'rgb(0 0 0 / 0)') continue;
    add('raw-color', file, lineAt(clean, m.index), `Raw color outside tokens: ${value}`, value);
  }
}
for (const [file, parsed] of css) {
  if (file !== 'tokens.css') colorFindings(`report/css/${file}`, parsed.clean, true);
}
for (const [file, text] of js) colorFindings(`report/js/${file}`, text, false);

// --- Type scale ---
for (const [file, parsed] of css) {
  if (file === 'tokens.css') continue;
  for (const rule of parsed.rules) {
    for (const d of declarations(rule.body)) {
      if (d.property !== 'font-size') continue;
      if (/^var\(--text-|^inherit$|^100%$/.test(d.value)) continue;
      add('type-scale', `report/css/${file}`, rule.line, `font-size must use a text token: ${d.value}`, d.value);
    }
  }
}
for (const [file, text] of js) {
  for (const m of text.matchAll(/font-size\s*:\s*([^;'"`\n]+)/g)) {
    if (/var\(--text-/.test(m[1])) continue;
    add('type-scale', `report/js/${file}`, lineAt(text, m.index), `font-size must use a text token: ${m[1].trim()}`, m[1]);
  }
  for (const m of text.matchAll(/(?:Chart\.defaults\.font\.size|font\s*:\s*\{\s*size)\s*[:=]\s*(\d+)/g)) {
    add('type-scale', `report/js/${file}`, lineAt(text, m.index), 'Chart font size must use chartFontSize()', m[1]);
  }
}

// --- Breakpoints ---
for (const [file, parsed] of css) {
  for (const m of parsed.clean.matchAll(/@media([^{]+)\{/g)) {
    const prelude = m[1];
    if (!/max-width\s*:/.test(prelude)) continue;
    for (const px of prelude.matchAll(/max-width\s*:\s*(\d+)px/g)) {
      if (px[1] !== '760') add('breakpoints', `report/css/${file}`, lineAt(parsed.clean, m.index), `Mobile breakpoint must be 760px, found ${px[1]}px`, px[0]);
    }
  }
}
for (const [file, text] of js) {
  if (/matchMedia\(\s*['"`]\(max-width:\s*\d+px\)/.test(text)) add('breakpoints', `report/js/${file}`, 1, 'Use MOBILE_BREAKPOINT for matchMedia', file);
}
const breakpointDecl = (js.get('config.js') || '').match(/MOBILE_BREAKPOINT\s*=\s*(\d+)/);
if (!breakpointDecl || breakpointDecl[1] !== '760') add('breakpoints', 'report/js/config.js', 1, 'MOBILE_BREAKPOINT must be 760');

// --- Motion and material coverage ---
const reducedMotionSelectors = new Set();
const reducedTransparencySelectors = new Set();
for (const parsed of css.values()) {
  for (const rule of parsed.rules) {
    const inMotion = rule.atRules.some(a => /prefers-reduced-motion/.test(a));
    const inTransparency = rule.atRules.some(a => /prefers-reduced-transparency/.test(a));
    for (const sel of selectors(rule)) {
      if (inMotion) reducedMotionSelectors.add(normalizeSelector(sel));
      if (inTransparency) reducedTransparencySelectors.add(normalizeSelector(sel));
    }
  }
}
for (const [file, parsed] of css) {
  for (const rule of parsed.rules) {
    const ds = declarations(rule.body);
    const motion = ds.some(d =>
      d.property === 'transform' ||
      d.property === 'animation' ||
      (d.property === 'transition' && /transform/.test(d.value))
    );
    const transparency = ds.some(d => /^(?:-webkit-)?backdrop-filter$/.test(d.property) && d.value !== 'none');
    for (const sel of selectors(rule)) {
      const normalized = normalizeSelector(sel);
      if (motion && !/^(@|from$|to$|\d)/.test(normalized) && !reducedMotionSelectors.has(normalized)) {
        add('motion-coverage', `report/css/${file}`, rule.line, `Missing reduced-motion fallback for ${sel}`, sel);
      }
      if (transparency && !reducedTransparencySelectors.has(normalized)) {
        add('transparency-coverage', `report/css/${file}`, rule.line, `Missing reduced-transparency fallback for ${sel}`, sel);
      }
    }
    if (ds.some(d => d.property === 'transition' && /\ball\b/.test(d.value))) {
      add('transition-all', `report/css/${file}`, rule.line, 'transition: all is not allowed', rule.selector);
    }
  }
}
for (const [file, text] of js) {
  if (/new Chart\s*\(/.test(text) && !/prefersReducedMotion\s*\(/.test(text)) {
    add('motion-coverage', `report/js/${file}`, 1, 'Chart animation must respect prefersReducedMotion()', file);
  }
}
if (!/prefers-contrast\s*:\s*more/.test(allCss)) add('contrast-block', 'report/css/motion.css', 1, 'Missing prefers-contrast: more block');
else if (!/--border/.test(allCss) || !/--muted/.test(allCss)) add('contrast-block', 'report/css/motion.css', 1, 'Contrast block must strengthen border/muted');

// --- Touch policy ---
const touchSelectors = new Set();
for (const parsed of css.values()) {
  for (const rule of parsed.rules) {
    if (rule.atRules.some(a => /max-width\s*:\s*760px/.test(a) && /pointer\s*:\s*coarse/.test(a))) {
      for (const sel of selectors(rule)) touchSelectors.add(sel);
    }
  }
}
const neededTouch = ['button', '[role="button"]', '.sess-item', '.filter-dropdown-row', '.p-free-label', '.toast-action', 'input', 'select'];
for (const sel of neededTouch) {
  if (!touchSelectors.has(sel)) add('touch-policy', 'report/css/layout.css', 1, `Touch policy does not cover ${sel}`, sel);
}

// --- Canvas accessibility ---
const canvasTags = [
  ...[...html.matchAll(/<canvas\b[^>]*>/g)].map(m => ({ file: 'report/index.html', tag: m[0] })),
  ...[...allJs.matchAll(/<canvas\b[^>]*>/g)].map(m => ({ file: 'report/js', tag: m[0] })),
];
for (const { file, tag } of canvasTags) {
  const id = (tag.match(/\bid="([^"]+)"/) || [])[1] || 'canvas';
  if (!/role="img"/.test(tag)) add('canvas-a11y', file, 1, `Canvas ${id} is missing role="img"`, id);
  if (!/aria-label(?:ledby)?="[^"]+"/.test(tag)) {
    const jsHasLabel = new RegExp(`['"]${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`).test(allJs) && /aria-label/.test(allJs);
    if (!(id === 'c-daily' && jsHasLabel)) add('canvas-a11y', file, 1, `Canvas ${id} is missing an accessible name`, id);
  }
}

// --- Hidden and external assets ---
const baseCss = (css.get('base.css') || { clean: '' }).clean;
if (!/\[hidden\]\s*\{\s*display\s*:\s*none\s*!important\s*;?\s*\}/.test(baseCss)) {
  add('hidden-guard', 'report/css/base.css', 1, 'Missing [hidden] { display: none !important; }');
}
for (const [file, parsed] of css) {
  if (file === 'base.css') continue;
  for (const rule of parsed.rules) {
    if (/\[hidden\]/.test(rule.selector) && /display\s*:/.test(rule.body)) {
      add('hidden-guard', `report/css/${file}`, rule.line, 'Selector overrides [hidden] display', rule.selector);
    }
  }
}
for (const m of html.matchAll(/<script\s+src="(https?:\/\/[^"]+)"/g)) {
  if (!/^https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/Chart\.js\/4\.4\.1\/chart\.umd\.min\.js$/.test(m[1])) {
    add('external-assets', 'report/index.html', lineAt(html, m.index), `Unexpected external script: ${m[1]}`, m[1]);
  }
}
for (const m of html.matchAll(/<link[^>]+href="(https?:\/\/[^"]+)"/g)) {
  add('external-assets', 'report/index.html', lineAt(html, m.index), `Unexpected external stylesheet: ${m[1]}`, m[1]);
}
if (/@import\s+url\(/.test(allCss)) add('external-assets', 'report/css', 1, 'CSS @import is not allowed');

// --- Contract and pinned skill integrity ---
if (!exists('docs/design.md')) add('contract-docs', 'docs/design.md', 1, 'Missing design contract');
else {
  const doc = read('docs/design.md');
  if (!doc.includes('<!-- design-contract:start -->') || !doc.includes('<!-- design-contract:end -->')) {
    add('contract-docs', 'docs/design.md', 1, 'Missing design-contract markers');
  }
  if (!read('CLAUDE.md').includes('docs/design.md')) add('contract-docs', 'CLAUDE.md', 1, 'CLAUDE.md does not link docs/design.md');
  if (!read('README.md').includes('docs/design.md')) add('contract-docs', 'README.md', 1, 'README.md does not link docs/design.md');
}
const skillA = '.claude/skills/apple-design/SKILL.md';
const skillB = '.agents/skills/apple-design/SKILL.md';
if (!exists(skillA) || !exists(skillB) || !exists('skills-lock.json')) add('skill-integrity', 'skills', 1, 'Missing pinned apple-design skill or lockfile');
else {
  const hash = f => crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, f))).digest('hex');
  if (hash(skillA) !== hash(skillB)) add('skill-integrity', 'skills', 1, 'The two apple-design skill copies differ');
}

// --- Baseline ---
const baselinePath = path.join(ROOT, 'tests/design-baseline.json');
let baseline = { version: 1, entries: [] };
if (fs.existsSync(baselinePath)) {
  try { baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8')); } catch (err) {
    add('baseline', 'tests/design-baseline.json', 1, `Invalid baseline JSON: ${err.message}`);
  }
}
const now = new Date().toISOString().slice(0, 10);
for (const entry of baseline.entries || []) {
  if (entry.expires && entry.expires < now) {
    notes.push(`Baseline entry expired: ${entry.rule} ${entry.file} (${entry.expires})`);
  }
}
const remaining = [];
for (const finding of findings) {
  const entry = (baseline.entries || []).find(e =>
    e.rule === finding.rule && e.file === finding.file && normalize(e.match || '') === finding.match
  );
  if (entry && Number(entry.count || 1) > 0) {
    entry.count = Number(entry.count || 1) - 1;
  } else {
    remaining.push(finding);
  }
}
for (const entry of baseline.entries || []) {
  if (Number(entry.count || 0) > 0 && (!entry.expires || entry.expires >= now)) {
    notes.push(`Unused baseline capacity: ${entry.rule} ${entry.file} (${entry.count})`);
  }
}

if (JSON_OUT) {
  process.stdout.write(JSON.stringify({ strict: STRICT, findings: remaining, notes }, null, 2) + '\n');
} else {
  for (const note of notes) console.log(`NOTE  ${note}`);
  for (const f of remaining) {
    const label = STRICT ? 'FAIL' : 'WARN';
    console.log(`${label}  ${f.rule}  ${f.file}:${f.line}  ${f.message}`);
  }
  console.log(`design-check: ${remaining.length} finding(s), ${notes.length} note(s) [${STRICT ? 'strict' : 'advisory'}]`);
}
process.exit(STRICT && remaining.length > 0 ? 1 : 0);
