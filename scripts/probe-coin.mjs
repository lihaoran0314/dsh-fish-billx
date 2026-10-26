/**
 * Verify coining end to end with a real model. Coining used to request only 700
 * tokens, which a reasoning model spends on thinking, so the old code could fail
 * on a task that looks trivial.
 *
 *   node scripts/probe-coin.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createEngine } from '../src/engine.js';

const credFile = path.join(os.homedir(), '.dsh', '.credentials.yaml');
const key =
  process.env.A_API_KEY ||
  (fs.readFileSync(credFile, 'utf8').match(/A_API_KEY:\s*(\S+)/) || [])[1];
if (!key) process.exit(1);

const baseURL = process.env.PROBE_BASE_URL || 'https://amr-link.open-design.ai/v1';
const model = process.env.PROBE_MODEL || 'deepseek-v4.1-flash';

const complete = async ({ system, user, maxTokens }) => {
  const response = await fetch(`${baseURL}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      temperature: 0.8,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });
  const json = await response.json();
  return json.choices?.[0]?.message?.content || '';
};

// Reuse the corpus that already holds learned knowledge from probe-verify.
const engine = createEngine({ dataDir: path.join(os.tmpdir(), 'dsh-fish-glm'), config: {} });
const state = engine.state();
console.log(`corpus: ${JSON.stringify(state.counts || state.groups || {})}`.slice(0, 200));
console.log(`model : ${model}\n`);

for (const keyword of ['期末周', '加班']) {
  const started = Date.now();
  const result = await engine.coin({ keyword, count: 4, complete });
  if (!result.ok) {
    console.log(`${keyword}: FAILED ${result.error}`);
    continue;
  }
  console.log(`${keyword}: ${result.items.length} candidates in ${Date.now() - started}ms`);
  for (const item of result.items) {
    console.log(`   ${item.term}  —  ${item.meaning}  (${item.how || 'n/a'})`);
  }
}
