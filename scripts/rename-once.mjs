/**
 * One-off rename: dsh-fish -> dsh-fish-billx across the plugin tree.
 *
 * Replacing plain "dsh-fish" everywhere would also rewrite the "-billx" we just
 * wrote, so every match is anchored on the old name NOT already followed by
 * "-billx". Identifiers keep their shape; only the stem changes.
 *
 *   node scripts/rename-once.mjs [--check]
 */
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1'), '..');
const checkOnly = process.argv.includes('--check');

const SKIP_DIRS = new Set(['.git', 'node_modules', '.corpus-test', 'data']);
// This script contains the old name on purpose; rewriting it would be circular.
const SKIP_FILES = new Set(['rename-once.mjs']);

const OLD = 'dsh-fish';
const NEW = 'dsh-fish-billx';
// Match the old stem only when it is not already the new stem.
const PATTERN = new RegExp(`${OLD.replace(/[-]/g, '\\-')}(?!-billx)`, 'g');

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* walk(path.join(dir, entry.name));
      continue;
    }
    if (entry.isFile() && !SKIP_FILES.has(entry.name)) yield path.join(dir, entry.name);
  }
}

let changed = 0;
for (const file of walk(repoRoot)) {
  const before = fs.readFileSync(file, 'utf8');
  const after = before.replace(PATTERN, NEW);
  if (after === before) continue;
  const hits = (before.match(PATTERN) || []).length;
  console.log(`${checkOnly ? 'would change' : 'changed'} ${path.relative(repoRoot, file)} (${hits})`);
  changed++;
  if (!checkOnly) fs.writeFileSync(file, after, 'utf8');
}
console.log(`\n${changed} file(s) ${checkOnly ? 'pending' : 'rewritten'}`);
