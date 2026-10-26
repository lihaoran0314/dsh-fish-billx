/**
 * End-to-end proof for the model fix: run the real learnOne() against real
 * crawled material on every model that previously failed, and report how many
 * entries each one actually landed.
 *
 *   node scripts/probe-verify.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadRaw, loadKnowledge, emptyKnowledge } from '../src/store.js';
import { learnOne, EXTRACT_MAX_TOKENS, GROUPS } from '../src/learner.js';

const credFile = path.join(os.homedir(), '.dsh', '.credentials.yaml');
const key =
  process.env.A_API_KEY ||
  (fs.readFileSync(credFile, 'utf8').match(/A_API_KEY:\s*(\S+)/) || [])[1];
if (!key) {
  console.error('no API key');
  process.exit(1);
}

const baseURL = process.env.PROBE_BASE_URL || 'https://amr-link.open-design.ai/v1';
const models = (process.env.VERIFY_MODELS || 'deepseek-v4.1-flash,glm-5.3-flash,kimi-k2.7-code')
  .split(',')
  .map((m) => m.trim())
  .filter(Boolean);

const raw = loadRaw(path.join(os.tmpdir(), 'dsh-fish-model'));
const item = raw.items[0];
console.log(`material: ${item.title.slice(0, 40)}`);
console.log(`budget  : ${EXTRACT_MAX_TOKENS} tokens\n`);

/** A complete() that honours maxTokens, mirroring what the plugin passes through. */
function makeComplete(model) {
  return async ({ system, user, maxTokens }) => {
    const response = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        temperature: 0.3,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    });
    const text = await response.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`non-JSON gateway reply: ${text.slice(0, 80)}`);
    }
    return json.choices?.[0]?.message?.content || '';
  };
}

for (const model of models) {
  const started = Date.now();
  try {
    const result = await learnOne(item, { complete: makeComplete(model) });
    const counts = {};
    for (const group of GROUPS) counts[group] = (result.batch[group] || []).length;
    const total = GROUPS.reduce((n, g) => n + counts[g], 0);
    console.log(
      `${model.padEnd(22)} method=${result.method.padEnd(9)} entries=${String(total).padStart(3)} ` +
        `${JSON.stringify(counts)}${result.error ? '  note=' + result.error.slice(0, 40) : ''} ${Date.now() - started}ms`,
    );
    if (total) {
      const top = GROUPS.filter((g) => counts[g]).map((g) => `${g}:${result.batch[g][0].term || result.batch[g][0].title}`).join(', ');
      console.log(`   sample: ${top.slice(0, 150)}`);
    }
  } catch (error) {
    console.log(`${model.padEnd(22)} THREW ${error.message}`);
  }
}
