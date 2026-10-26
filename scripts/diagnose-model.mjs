/**
 * Find out WHY a model fails the extraction, by isolating one variable at a time.
 *
 * Run against the same real material and the same suspect model:
 *
 *   node scripts/diagnose-model.mjs
 *
 * Each case reports finish_reason and whether parseable JSON came back, so the
 * failing dimension (input length / output shape / prompt complexity / budget)
 * is visible instead of guessed.
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

const baseURL = process.env.PROBE_BASE_URL || 'https://amr-link.open-design.ai/v1';
const model = process.env.PROBE_MODEL || 'deepseek-v4.1-flash';

const raw = loadRaw(path.join(os.tmpdir(), 'dsh-fish-model'));
const item = raw.items[0];
const fullInput = composeChunks(item)[0];
console.log(`model=${model}`);
console.log(`material: ${fullInput.length} chars\n`);

const TINY_SCHEMA = 'Output JSON only: {"summary":"...","memes":[{"term":"","meaning":""}]}';
const SHORT_SYSTEM = 'Extract comment-section memes as JSON. JSON only.';

async function run(label, { system, user, maxTokens = 3000, temperature = 0.3 }) {
  const started = Date.now();
  try {
    const response = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        temperature,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    });
    const json = await response.json();
    const choice = json.choices?.[0] || {};
    const content = choice.message?.content || '';
    const reasoning = json.usage?.completion_tokens_details?.reasoning_tokens;
    const parsed = parseLooseJson(content);
    console.log(
      `${label.padEnd(38)} finish=${String(choice.finish_reason).padEnd(7)} ` +
        `content=${String(content.length).padStart(4)} reasoning=${String(reasoning ?? '-').padStart(4)} ` +
        `json=${parsed ? 'YES' : 'no '} ${Date.now() - started}ms`,
    );
    if (!parsed && content) console.log(`   head: ${JSON.stringify(content.slice(0, 120))}`);
    return { parsed, content };
  } catch (error) {
    console.log(`${label.padEnd(38)} ERROR ${error.message}`);
    return { parsed: null, content: '' };
  }
}

const cases = [
  ['A. tiny task (control)', { system: SHORT_SYSTEM, user: 'comments: 好耶 / 省流 / 绷不住', maxTokens: 600 }],
  ['B. full system + tiny input', { system: SYSTEM, user: 'comments: 好耶 / 省流 / 绷不住', maxTokens: 1500 }],
  ['C. short system + full input', { system: SHORT_SYSTEM, user: fullInput }],
  ['D. tiny schema + full input', { system: 'Read the comments and output JSON only.\n' + TINY_SCHEMA, user: fullInput }],
  ['E. short prompt + 800 chars', { system: SHORT_SYSTEM, user: fullInput.slice(0, 800), maxTokens: 1500 }],
  ['F. short prompt + 1600 chars', { system: SHORT_SYSTEM, user: fullInput.slice(0, 1600), maxTokens: 2000 }],
  ['G. current system + full input', { system: SYSTEM, user: fullInput }],
  ['H. current system + 800 chars', { system: SYSTEM, user: fullInput.slice(0, 800), maxTokens: 2000 }],
];

for (const [label, options] of cases) {
  await run(label, options);
}
