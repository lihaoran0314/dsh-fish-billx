/**
 * Same material, same prompt, several models, a few token budgets.
 *
 * The point is to find a budget that clears every model's reasoning overhead,
 * instead of concluding "only one model works".
 *
 *   node scripts/probe-matrix.mjs
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
if (!key) process.exit(1);

const baseURL = process.env.PROBE_BASE_URL || 'https://amr-link.open-design.ai/v1';
const raw = loadRaw(path.join(os.tmpdir(), 'dsh-fish-model'));
const fullInput = composeChunks(raw.items[0])[0];

const models = (process.env.MATRIX_MODELS || 'deepseek-v4.1-flash,deepseek-v4-pro,kimi-k2.7-code,glm-5.3-flash')
  .split(',')
  .map((m) => m.trim())
  .filter(Boolean);
const budgets = (process.env.MATRIX_BUDGETS || '3000,8000,12000')
  .split(',')
  .map((n) => Number(n.trim()));

console.log(`material=${fullInput.length} chars\n`);

async function attempt(model, maxTokens) {
  const started = Date.now();
  try {
    const response = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        temperature: 0.3,
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: fullInput },
        ],
      }),
    });
    const json = await response.json();
    const choice = json.choices?.[0] || {};
    const content = choice.message?.content || '';
    return {
      ok: Boolean(parseLooseJson(content)),
      finish: choice.finish_reason,
      len: content.length,
      reasoning: json.usage?.completion_tokens_details?.reasoning_tokens,
      ms: Date.now() - started,
    };
  } catch (error) {
    return { ok: false, finish: 'ERROR', len: 0, reasoning: null, ms: Date.now() - started, error: error.message };
  }
}

const results = {};
for (const model of models) {
  results[model] = {};
  for (const budget of budgets) {
    const r = await attempt(model, budget);
    results[model][budget] = r;
    console.log(
      `${model.padEnd(22)} budget=${String(budget).padStart(5)}  finish=${String(r.finish).padEnd(7)} ` +
        `content=${String(r.len).padStart(4)} reasoning=${String(r.reasoning ?? '-').padStart(5)} ${r.ok ? 'JSON OK' : 'FAILED'} ${r.ms}ms`,
    );
  }
  console.log('');
}

console.log('smallest working budget per model:');
for (const model of models) {
  const working = budgets.filter((b) => results[model][b]?.ok);
  console.log(`  ${model.padEnd(22)} ${working.length ? working[0] : 'none of ' + budgets.join('/')}`);
}
