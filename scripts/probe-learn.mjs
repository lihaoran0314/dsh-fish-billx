/**
 * Replay the exact long-document learning prompt against the provider and print
 * why the reply came back empty (finish reason, reasoning tokens, content).
 *
 *   node scripts/probe-learn.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadRaw } from '../src/store.js';
import { composeChunks, SYSTEM } from '../src/learner.js';

const credFile = path.join(os.homedir(), '.dsh', '.credentials.yaml');
const key =
  process.env.A_API_KEY ||
  (fs.readFileSync(credFile, 'utf8').match(/A_API_KEY:\s*(\S+)/) || [])[1];
if (!key) {
  console.error('no API key found');
  process.exit(1);
}

const dir = process.env.CORPUS_DIR || path.join(os.tmpdir(), 'dsh-fish-model');
const raw = loadRaw(dir);
if (!raw.items.length) {
  console.error('no corpus at', dir, '- run a crawl first');
  process.exit(1);
}

const item = raw.items[0];
const chunks = composeChunks(item);
console.log('video:', item.title.slice(0, 50));
console.log('batches:', chunks.length, '| batch 1 chars:', chunks[0].length);

const baseURL = process.env.PROBE_BASE_URL || 'https://amr-link.open-design.ai/v1';
const model = process.env.PROBE_MODEL || 'deepseek-v4.1-flash';

for (const maxTokens of [900, 2500, 5000]) {
  const response = await fetch(`${baseURL}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      temperature: 0.3,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: chunks[0] },
      ],
    }),
  });
  const json = await response.json();
  const message = json.choices?.[0]?.message || {};
  const content = message.content || '';
  console.log(
    `\nmax_tokens=${maxTokens} finish=${json.choices?.[0]?.finish_reason} ` +
      `reasoning=${json.usage?.completion_tokens_details?.reasoning_tokens ?? 'n/a'} ` +
      `content_len=${content.length}`,
  );
  console.log('content head:', JSON.stringify(content.slice(0, 200)));
}
