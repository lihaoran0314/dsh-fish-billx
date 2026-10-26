/**
 * Find a request shape that makes this provider emit content instead of
 * reasoning forever on a long Chinese prompt. Tries several switches and
 * reports which one actually yields JSON.
 *
 *   node scripts/probe-reasoning.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadRaw } from '../src/store.js';
import { composeChunks, SYSTEM, parseLooseJson } from '../src/learner.js';

const credFile = path.join(os.homedir(), '.dsh', '.credentials.yaml');
const key =
  process.env.A_API_KEY ||
  (fs.readFileSync(credFile, 'utf8').match(/A_API_KEY:\s*(\S+)/) || [])[1];
if (!key) {
  console.error('no API key found');
  process.exit(1);
}

const dir = process.env.CORPUS_DIR || path.join(os.tmpdir(), 'dsh-fish-billx-model');
const raw = loadRaw(dir);
const item = raw.items[0];
const user = composeChunks(item)[0];

const baseURL = process.env.PROBE_BASE_URL || 'https://amr-link.open-design.ai/v1';
const model = process.env.PROBE_MODEL || 'deepseek-v4.1-flash';

const variants = [
  { label: 'baseline 4000', body: { max_tokens: 4000, temperature: 0.3 } },
  { label: 'reasoning_effort=low', body: { max_tokens: 4000, temperature: 0.3, reasoning_effort: 'low' } },
  { label: 'reasoning_effort=minimal', body: { max_tokens: 4000, reasoning_effort: 'minimal' } },
  { label: 'no-reasoning param', body: { max_tokens: 4000, temperature: 0.3, enable_thinking: false } },
  { label: 'temperature 0', body: { max_tokens: 4000, temperature: 0 } },
  { label: 'short system', body: { max_tokens: 4000, temperature: 0.3, shortSystem: true } },
];

for (const variant of variants) {
  const { shortSystem, ...rest } = variant.body;
  const system = shortSystem
    ? 'Extract Bilibili comment-section knowledge as JSON. JSON only, no prose.'
    : SYSTEM;
  const started = Date.now();
  try {
    const response = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        ...rest,
      }),
    });
    const json = await response.json();
    const content = json.choices?.[0]?.message?.content || '';
    const parsed = parseLooseJson(content);
    console.log(
      `${variant.label.padEnd(24)} status=${response.status} finish=${String(json.choices?.[0]?.finish_reason).padEnd(7)} ` +
        `len=${String(content.length).padStart(5)} json=${parsed ? 'yes' : 'no '} ${Date.now() - started}ms`,
    );
  } catch (error) {
    console.log(`${variant.label.padEnd(24)} ERROR ${error.message}`);
  }
}
