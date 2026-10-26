/**
 * Compare token budgets: this provider spends completion budget on reasoning
 * first, so a tight maxTokens returns an empty `content` with finish_reason
 * "stop". Run this to confirm the threshold before changing plugin defaults.
 *
 *   node scripts/probe-budget.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

const question = 'Output JSON only: {"items":[{"term":"a"}]}';

for (const maxTokens of [300, 900, 2000, 4000]) {
  const response = await fetch(`${baseURL}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: question }],
    }),
  });
  const json = await response.json();
  const message = json.choices?.[0]?.message || {};
  const reasoning = json.usage?.completion_tokens_details?.reasoning_tokens;
  console.log(
    `max_tokens=${String(maxTokens).padStart(4)}  content=${String((message.content || '').length).padStart(4)}  ` +
      `finish=${json.choices?.[0]?.finish_reason}  reasoning_tokens=${reasoning ?? 'n/a'}`,
  );
}
