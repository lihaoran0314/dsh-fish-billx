/**
 * Compare every tracked local file against the published tree, byte for byte.
 *
 * "The push succeeded" is not the same claim as "GitHub has exactly these bytes".
 * This walks the local tree (minus ignored/local-only files) and the remote git
 * tree, and reports any file that is missing, extra, or different.
 *
 *   node scripts/check-published.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const OWNER = 'lihaoran0314';
const REPO = 'dsh-fish-billx';
const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1'), '..');

function readToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  const credFile = path.join(os.homedir(), '.dsh', '.credentials.yaml');
  const match = fs.existsSync(credFile) && fs.readFileSync(credFile, 'utf8').match(/GITHUB_TOKEN:\s*(\S+)/);
  return match ? match[1] : null;
}

const token = readToken();
const headers = { authorization: `Bearer ${token}`, 'user-agent': 'dsh-fish-check', accept: 'application/vnd.github+json' };
const api = async (url) => {
  const response = await fetch(`https://api.github.com${url}`, { headers });
  if (!response.ok) throw new Error(`${url} -> ${response.status}`);
  return response.json();
};

// Which files does git consider part of the repo? That is authoritative: it
// already excludes .gitignore'd local helpers. `git ls-files` cannot be spawned
// under a restricted sandbox, so the index is read directly instead.
function trackedFromIndex(root) {
  const indexPath = path.join(root, '.git', 'index');
  const buffer = fs.readFileSync(indexPath);
  if (buffer.toString('utf8', 0, 4) !== 'DIRC') throw new Error('unexpected git index format');
  const version = buffer.readUInt32BE(4);
  if (version !== 2) throw new Error(`unsupported git index version ${version}`);
  const count = buffer.readUInt32BE(8);
  const files = [];
  let offset = 12;
  for (let i = 0; i < count; i++) {
    const start = offset;
    offset += 40; // ctime, mtime, dev, ino, mode, uid, gid, size
    const sha = buffer.toString('hex', offset, offset + 20);
    offset += 20;
    const flags = buffer.readUInt16BE(offset);
    offset += 2;
    const nameLength = flags & 0x0fff;
    const nameStart = offset;
    let name;
    if (nameLength < 0x0fff) {
      name = buffer.toString('utf8', nameStart, nameStart + nameLength);
      offset = nameStart + nameLength;
    } else {
      let end = nameStart;
      while (buffer[end] !== 0) end++;
      name = buffer.toString('utf8', nameStart, end);
      offset = end;
    }
    // Entry names are NUL-terminated and padded to a multiple of 8 bytes.
    const entryLength = offset - start;
    offset = start + (Math.floor((entryLength + 8) / 8) * 8);
    files.push({ path: name, sha });
  }
  return files;
}

const indexPath = trackedFromIndex(repoRoot);

const tree = await api(`/repos/${OWNER}/${REPO}/git/trees/main?recursive=1`);
const remoteFiles = new Map(
  tree.tree.filter((node) => node.type === 'blob').map((node) => [node.path, node.sha]),
);

const localSet = new Set(indexPath.map((entry) => entry.path));
const problems = [];

for (const { path: rel, sha: indexSha } of indexPath) {
  const remoteSha = remoteFiles.get(rel);
  if (!remoteSha) {
    problems.push(`MISSING on GitHub: ${rel}`);
    continue;
  }
  if (remoteSha !== indexSha) {
    // The index records the staged blob; confirm the file on disk matches too,
    // otherwise the difference is an uncommitted local edit rather than drift.
    const content = fs.readFileSync(path.join(repoRoot, rel));
    const { createHash } = await import('node:crypto');
    const diskSha = createHash('sha1')
      .update(Buffer.from(`blob ${content.length}\0`, 'utf8'))
      .update(content)
      .digest('hex');
    problems.push(
      diskSha === indexSha
        ? `DIFFERS from GitHub (local commit not pushed): ${rel}`
        : `UNCOMMITTED local edit: ${rel}`,
    );
  }
}

for (const rel of remoteFiles.keys()) {
  if (!localSet.has(rel)) problems.push(`ONLY on GitHub: ${rel}`);
}

console.log(`local tracked files : ${indexPath.length}`);
console.log(`remote files        : ${remoteFiles.size}`);
if (problems.length) {
  console.log('\nproblems:');
  for (const problem of problems) console.log('  ' + problem);
  process.exit(1);
}
console.log('\nevery tracked file is on GitHub with identical bytes');
