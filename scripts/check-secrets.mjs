/**
 * Scan everything that will be published for leaked credentials.
 * Exit code 1 means something looked like a secret, so a commit can be blocked.
 *
 *   node scripts/check-secrets.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');
const repoRoot = path.resolve(ROOT, '..');

const SKIP_DIRS = new Set(['.git', 'node_modules', '.corpus-test', 'data']);
const PATTERNS = [
  [/gh[pousr]_[A-Za-z0-9]{20,}/, 'GitHub token'],
  [/sk-[A-Za-z0-9_-]{20,}/, 'API secret key'],
  [/A_API_KEY\s*[:=]\s*['"][^'"]+['"]/, 'hard-coded API key'],
  [/Bearer\s+[A-Za-z0-9_.-]{24,}/, 'hard-coded bearer token'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key'],
];

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* walk(path.join(dir, entry.name));
      continue;
    }
    if (entry.isFile()) yield path.join(dir, entry.name);
  }
}

let findings = 0;
for (const file of walk(repoRoot)) {
  // The scanner contains its own patterns, so it would always match itself.
  if (file.endsWith('check-secrets.mjs')) continue;
  const text = fs.readFileSync(file, 'utf8');
  for (const [pattern, label] of PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      const line = text.slice(0, match.index).split('\n').length;
      console.log(`${label} at ${path.relative(repoRoot, file)}:${line}`);
      findings++;
    }
  }
}

if (findings) {
  console.log(`\n${findings} suspicious match(es) -- do not publish until resolved`);
  process.exit(1);
}
console.log('clean: no credential material in the publishable tree');
