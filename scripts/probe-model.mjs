/**
 * Manual probe: send one learning prompt to the configured provider and print
 * the raw response, so a "the model returned nothing" case can be told apart
 * from "the model returned something unparsable".
 *
 *   node scripts/probe-model.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const credFile = path.join(os.homedir(), '.dsh', '.credentials.yaml');
let key = process.env.A_API_KEY || process.env.MODEL_KEY || '';
if (!key && fs.existsSync(credFile)) {
  const match = fs.readFileSync(credFile, 'utf8').match(/A_API_KEY:\s*(\S+)/);
  if (match) key = match[1];
}
if (!key) {
  console.error('no API key: set A_API_KEY or add it to ~/.dsh/.credentials.yaml');
  process.exit(1);
}

const baseURL = process.env.PROBE_BASE_URL || 'https://amr-link.open-design.ai/v1';
const model = process.env.PROBE_MODEL || 'deepseek-v4.1-flash';

const response = await fetch(`${baseURL}/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
  body: JSON.stringify({
    model,
    max_tokens: 500,
    messages: [{ role: 'user', content: 'Reply with exactly this JSON and nothing else: {"ok":true}' }],
  }),
});
const text = await response.text();
console.log('status:', response.status);
console.log('raw body (first 1200 chars):');
console.log(text.slice(0, 1200));
