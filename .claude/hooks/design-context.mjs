#!/usr/bin/env node
// Injects the project report design contract at session start.
// Project-local only: reads CLAUDE_PROJECT_DIR or the repo containing this hook.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const FALLBACK = [
  'DESIGN CONTRACT (report/):',
  '- Before visual work, read docs/design.md and .claude/skills/apple-design/SKILL.md; never edit the skill.',
  '- Tokens only: no raw colors or type sizes outside report/css/tokens.css.',
  '- Ship reduced-motion, reduced-transparency, contrast, 44px touch, focus, and canvas aria with the component.',
  '- Breakpoint 760 only (JS: MOBILE_BREAKPOINT).',
  '- Run `node tests/design-check.mjs --static`; visual changes also run `node tests/visual.mjs`.',
].join('\n');

function projectRoot() {
  if (process.env.CLAUDE_PROJECT_DIR) return process.env.CLAUDE_PROJECT_DIR;
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..');
}

function contractText() {
  const file = path.join(projectRoot(), 'docs', 'design.md');
  const text = fs.readFileSync(file, 'utf8');
  const start = '<!-- design-contract:start -->';
  const end = '<!-- design-contract:end -->';
  const from = text.indexOf(start);
  const to = text.indexOf(end);
  if (from === -1 || to === -1 || to <= from) return FALLBACK;
  return text.slice(from + start.length, to).trim() || FALLBACK;
}

let context;
try {
  context = contractText();
} catch (err) {
  console.error(err.message);
  context = FALLBACK;
}

process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'SessionStart',
    additionalContext: context,
  },
}));
