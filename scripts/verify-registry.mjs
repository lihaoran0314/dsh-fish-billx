/**
 * Verify the plugin surface against the real harness registry (not just our own
 * test assertions): every tool definition must be accepted by defineTool, and
 * the reported identity must match the package name.
 *
 *   node scripts/verify-registry.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1'), '..');
const harness = process.env.DSH_TOOLS_ENTRY ||
  'C:/Users/16697/AppData/Local/Programs/DSH Desktop/resources/app/node_modules/@deepseek-ai/dsh-tools/lib/index.js';

if (!fs.existsSync(harness)) {
  console.log('harness packages not found; skipping the registry check');
  process.exit(0);
}

const { defineTool } = await import('file:///' + harness.replace(/ /g, '%20'));
const mod = await import('file:///' + path.join(repoRoot, 'src/index.js').replace(/ /g, '%20'));
const { createEngine } = await import('file:///' + path.join(repoRoot, 'src/engine.js').replace(/ /g, '%20'));

const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const engine = createEngine({ dataDir: path.join(repoRoot + '-verify', 'corpus'), config: {} });
const tools = mod.createTools(engine, async () => undefined);

let ok = 0;
for (const tool of tools) {
  try {
    defineTool(tool);
    ok++;
  } catch (error) {
    console.log(`FAIL ${tool.name}: ${error.message}`);
  }
}

console.log(`plugin name : ${mod.name}`);
console.log(`package name: ${pkg.name}`);
console.log(`state id    : ${engine.state().id}`);
console.log(`tools       : ${ok}/${tools.length} accepted by the real registry`);

const consistent = mod.name === pkg.name && engine.state().id === pkg.name && ok === tools.length;
console.log(consistent ? '\nOK: name is consistent everywhere' : '\nMISMATCH: names disagree');
process.exit(consistent ? 0 : 1);
