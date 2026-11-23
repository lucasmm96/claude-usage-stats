#!/usr/bin/env node
// Adds a design reminder before editing report files. Never blocks or changes
// permissions. Project-local only: paths outside this repo produce no context.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const VISUAL_TOOLS = new Set(['Edit', 'Write', 'MultiEdit']);
const REMINDER = [
  'Report visual change detected.',
  'Read docs/design.md and .claude/skills/apple-design/SKILL.md before proceeding.',
  'Use tokens, then run `node tests/design-check.mjs --static` and `node tests/visual.mjs`.',
].join(' ');

function projectRoot() {
  if (process.env.CLAUDE_PROJECT_DIR) return process.env.CLAUDE_PROJECT_DIR;
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..');
}

function emit(context) {
  const output = context
    ? { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: context } }
    : {};
  process.stdout.write(JSON.stringify(output));
}

let payload = {};
try {
  payload = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
} catch (err) {
  console.error(err.message);
}

const root = projectRoot();
const input = payload.tool_input || {};
const rawPath = input.file_path || input.path || '';
const name = payload.tool_name || '';

if (!VISUAL_TOOLS.has(name) || !rawPath) {
  emit(null);
  process.exit(0);
}

const absolute = path.isAbsolute(rawPath)
  ? path.normalize(rawPath)
  : path.resolve(payload.cwd || root, rawPath);
const relative = path.relative(root, absolute);

if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
  emit(null);
  process.exit(0);
}

const normalized = relative.split(path.sep).join('/');
if (normalized.startsWith('report/')) emit(REMINDER);
else emit(null);
