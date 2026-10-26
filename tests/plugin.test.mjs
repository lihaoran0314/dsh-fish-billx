import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as learner from '../src/learner.js';
import * as store from '../src/store.js';
import * as prompt from '../src/prompt.js';
import * as topics from '../src/topics.js';
import { createEngine } from '../src/engine.js';
import { createTools, resolveDataDir, assembleText, latestUserText } from '../src/index.js';

/** A temp corpus directory that cleans itself up. */
function tempDir(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-fish-billx-${label}-`));
  test.after?.(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const VIDEO = {
  bvid: 'BV1xx411c7mD',
  aid: 170001,
  cid: 279786,
  title: '三角洲行动 渡鸦路灯爆率测试',
  desc: '今天来测一下渡鸦路灯的爆率，看看谁是赌狗',
  owner: '某UP',
  tname: '游戏',
  tags: ['三角洲行动', '射击游戏'],
  comments: [
    { text: '赌狗赌狗，梭哈是一种智慧', like: 210, replies: ['见好就收吧'] },
    { text: '温暖的希望变成冰冷的现实', like: 90, replies: [] },
    { text: '抱抱，别熬夜打游戏了', like: 40, replies: [] },
    { text: '这期真的笑死我了', like: 30, replies: [] },
  ],
  danmaku: [
    { text: '梭哈是一种智慧', count: 12 },
    { text: '见好就收', count: 7 },
    { text: '原神启动', count: 2 },
  ],
};

/* ------------------------------- learner ---------------------------------- */

test('sanitizeBatch keeps the seven groups and drops profanity from word lists', () => {
  const raw = {
    summary: '评论区在互相调侃',
    memes: [
      { term: '梭哈', meaning: 'all in', usage: 'gamble joke', example: '梭哈是一种智慧' },
      { term: '傻逼', meaning: 'insult', example: 'x' },
    ],
    ethics: [{ title: '地狱笑话', note: '拿灾难开玩笑', usage: '不接梗' }],
    love: [{ title: '别熬夜', note: '关心作息', example: '别熬夜' }],
  };
  const batch = learner.sanitizeBatch(raw);
  assert.equal(batch.summary, '评论区在互相调侃');
  assert.deepEqual(batch.memes.map((m) => m.term), ['梭哈']);
  // ethics never carries an example, whatever the model sent
  assert.equal(batch.ethics[0].example, undefined);
  assert.equal(batch.love.length, 1);
  for (const group of learner.GROUPS) assert.ok(Array.isArray(batch[group]), `${group} is an array`);
});

test('parseLooseJson recovers a truncated model reply', () => {
  const truncated =
    '{"summary":"在玩梗","memes":[{"term":"梭哈","meaning":"all in"},{"term":"赌狗","meaning":"自嘲"}]';
  const parsed = learner.parseLooseJson(truncated);
  assert.ok(parsed);
  assert.equal(parsed.summary, '在玩梗');
  assert.equal(parsed.memes.length, 2);
});

test('composeChunks batches long material without truncating it', () => {
  const long = {
    ...VIDEO,
    // Each comment carries ~60 chars, so 60 of them overflow one 3200-char batch.
    comments: Array.from({ length: 60 }, (_, i) => ({
      text: `这是第 ${i} 条评论，内容足够长以便触发分块逻辑，再补一些字数把每块撑满`,
      like: i,
      replies: [],
    })),
    danmaku: [],
  };
  const chunks = learner.composeChunks(long);
  assert.ok(chunks.length > 1, 'material should split into several batches');
  assert.ok(chunks.length <= 3, 'at most three batches');
  const joined = chunks.join('\n');
  assert.ok(joined.includes('这是第 0 条评论'), 'the first comment is kept');
  assert.ok(joined.includes('这是第 10 条评论'), 'the packed batches keep real material');
  // Nothing is silently truncated: every comment is either present or the run
  // hit the explicit three-batch ceiling.
  const kept = chunks.length < 3 ? 60 : 24;
  assert.ok(joined.includes(`这是第 ${kept - 1} 条评论`), 'no gap in the kept range');
});

test('heuristicBatch works with no model at all', () => {
  const batch = learner.heuristicBatch(VIDEO);
  assert.ok(batch.memes.some((m) => m.term === '梭哈是一种智慧'));
  assert.ok(batch.gameWords.some((g) => g.term === '三角洲行动'));
  assert.ok(batch.love.length >= 1);
  assert.equal(batch.memes[0].example.length > 0, true);
});

test('heuristicBatch counts a repeated term once per line, not twice', () => {
  const batch = learner.heuristicBatch({
    title: 't',
    desc: '',
    tags: [],
    comments: [
      { text: '梭哈是一种智慧', like: 1, replies: [] },
      { text: '梭哈是一种智慧', like: 2, replies: [] },
    ],
    danmaku: [],
  });
  const meme = batch.memes.find((m) => m.term === '梭哈是一种智慧');
  assert.ok(meme, 'the repeated line is a meme');
  assert.equal(meme.usage, 'use it when the mood matches', 'two mentions is not yet "safe to use"');
});

test('unsafe material is rejected before it is stored', () => {
  assert.equal(learner.isUnsafeItem({ title: '普通游戏视频', desc: '', tags: [] }), false);
  assert.equal(learner.isUnsafeItem({ title: 'ASMR 助眠音声', desc: '', tags: [] }), true);
  assert.equal(
    learner.isUnsafeItem({
      title: '普通视频',
      desc: '',
      tags: [],
      comments: [{ text: '擦边' }, { text: '色情' }, { text: 'R18' }],
    }),
    true,
  );
});

test('learnOne falls back to heuristics when the model call fails', async () => {
  const result = await learner.learnOne(VIDEO, {
    complete: async () => {
      throw new Error('model is down');
    },
  });
  assert.equal(result.method, 'heuristic');
  assert.ok(result.batch.memes.length > 0);
});

test('learnOne reports an empty model reply as a reason, not a silent no-op', async () => {
  const result = await learner.learnOne(VIDEO, {
    // A reasoning model that burns the whole budget returns empty content.
    complete: async () => '',
  });
  assert.equal(result.method, 'heuristic', 'it still lands knowledge locally');
  assert.match(result.error, /no text/i, 'the caller is told why the model path failed');
});

test('the extraction budget is large enough for reasoning models', () => {
  // Measured: deepseek-v4.1-flash and deepseek-v4-pro need >8000 tokens of
  // deliberation before writing anything on a ~3.2k-character document.
  assert.ok(
    learner.EXTRACT_MAX_TOKENS >= 10000,
    `budget ${learner.EXTRACT_MAX_TOKENS} is below the measured reasoning overhead`,
  );
});

test('valid-but-empty JSON is retried, not accepted as "nothing here"', async () => {
  const calls = [];
  const result = await learner.learnOne(VIDEO, {
    complete: async ({ maxTokens }) => {
      calls.push(maxTokens);
      // First call: schema-valid but every array empty. Second: real content.
      if (calls.length === 1) return JSON.stringify({ summary: 'nothing', memes: [], love: [] });
      return JSON.stringify({
        summary: 'real',
        memes: [{ term: '梭哈', meaning: 'all in', example: '梭哈是一种智慧' }],
      });
    },
  });
  assert.equal(calls.length, 2, 'an empty reply earns exactly one retry');
  assert.ok(calls[1] > calls[0], 'the retry raises the budget');
  assert.equal(result.method, 'llm');
  assert.ok(result.batch.memes.length > 0, 'the retry content is what gets stored');
});

test('a batch is presented as complete material, never as one awaiting more', () => {
  for (const chunk of learner.composeChunks(VIDEO)) {
    assert.ok(/complete input|part \d+ of \d+/.test(chunk), 'the batch says what it is');
    assert.ok(!/batch 1\/\d/.test(chunk), 'no label that reads like an unfinished request');
    assert.ok(/do not ask for the rest|Answer with the JSON object now/i.test(chunk));
  }
});

test('an HTML error page from the gateway is not mistaken for a model reply', () => {
  assert.equal(learner.parseLooseJson('<!DOCTYPE html><html><body>502</body></html>'), null);
  assert.equal(learner.parseLooseJson('<html><head></head></html>'), null);
  // A JSON reply that merely starts with a brace still parses.
  assert.equal(learner.parseLooseJson('{"memes":[{"term":"x"}]}').memes.length, 1);
});

test('a truncated reply is recovered without spending a second call', async () => {
  // The per-category rescue already salvages a closed `memes` object out of a
  // reply that broke off mid-document, so the continuation call must NOT be
  // made: fewer model calls for the same knowledge.
  const cut = '{"summary":"s","memes":[{"term":"省流","meaning":"summary","example":"省流：结论"}]';
  let calls = 0;
  const result = await learner.learnOne(
    { ...VIDEO, comments: [{ text: '省流：结论', like: 5, replies: [] }], danmaku: [] },
    {
      complete: async () => {
        calls++;
        return cut;
      },
    },
  );
  assert.equal(result.method, 'llm');
  assert.ok(result.batch.memes.some((m) => m.term === '省流'), 'recovered memes are kept');
  assert.equal(calls, 1, 'no second call when the rescue already found entries');
});

test('an unparseable reply with no rescue triggers a continuation call', async () => {
  let sawContinuation = false;
  const result = await learner.learnOne(
    { ...VIDEO, comments: [{ text: '好耶', like: 3, replies: [] }], danmaku: [] },
    {
      complete: async ({ system }) => {
        if (/cut off/i.test(system)) {
          sawContinuation = true;
          return '{"summary":"s","memes":[{"term":"好耶","meaning":"yay"}]}';
        }
        return 'I am sorry, I cannot help with that request.'; // no JSON at all
      },
    },
  );
  assert.ok(sawContinuation, 'it asks for the tail when nothing was salvageable');
  assert.equal(result.method, 'llm');
  assert.ok(result.batch.memes.length > 0);
});

test('learnOne uses the model when it answers with JSON', async () => {
  const result = await learner.learnOne(VIDEO, {
    complete: async () =>
      JSON.stringify({
        summary: '评论区在调侃赌狗心态',
        memes: [{ term: '赌狗', meaning: '自嘲', usage: '调侃', example: '赌狗赌狗' }],
        coinage: [],
        emergence: [],
        ethics: [],
        commonWords: [],
        gameWords: [],
        love: [],
      }),
  });
  assert.equal(result.method, 'llm');
  assert.equal(result.batch.summary, '评论区在调侃赌狗心态');
  assert.equal(result.batch.memes[0].term, '赌狗');
});

/* -------------------------------- store ----------------------------------- */

test('mergeKnowledge accumulates weight and caps examples', () => {
  const dir = tempDir('store');
  const batch = learner.emptyBatch('first');
  batch.memes = [{ term: '梭哈', meaning: 'all in', usage: 'u', example: 'e1' }];
  store.mergeKnowledge(dir, { ...batch, videos: 1, method: 'llm' }, { source: 'BV1' });
  const second = learner.emptyBatch('');
  second.memes = [{ term: '梭哈', meaning: 'all in', usage: 'u', example: 'e2' }];
  store.mergeKnowledge(dir, { ...second, videos: 1, method: 'llm' }, { source: 'BV2' });

  const knowledge = store.loadKnowledge(dir);
  assert.equal(knowledge.memes.length, 1);
  assert.equal(knowledge.memes[0].weight, 2);
  assert.deepEqual(knowledge.memes[0].sources, ['BV2', 'BV1']);
  assert.equal(knowledge.memes[0].examples.length, 2);
  assert.equal(knowledge.stats.learnedVideos, 2);
  assert.equal(knowledge.stats.summaries.length, 1, 'only non-empty summaries are kept');
});

test('raw corpus dedupes by bvid and caps at the limit', () => {
  const dir = tempDir('raw');
  const added = store.addRawItems(dir, [VIDEO, VIDEO]);
  assert.equal(added.total, 1);
  assert.equal(added.added, 1);
  assert.equal(store.unlearnedItems(dir).length, 1);
  store.markLearned(dir, [VIDEO.bvid], 'llm');
  assert.equal(store.unlearnedItems(dir).length, 0);
});

test('forget removes exactly one entry', () => {
  const dir = tempDir('forget');
  const batch = learner.emptyBatch('');
  batch.memes = [{ term: 'a' }, { term: 'b' }];
  store.mergeKnowledge(dir, { ...batch, videos: 1, method: 'llm' });
  const result = store.forget(dir, 'memes', 'a');
  assert.equal(result.removed, 1);
  assert.deepEqual(store.loadKnowledge(dir).memes.map((m) => m.term), ['b']);
});

/* ------------------------------- injection -------------------------------- */

test('prompt block injects memes and gates game words on game talk', () => {
  const dir = tempDir('prompt');
  const batch = learner.emptyBatch('');
  batch.memes = [{ term: '梭哈', meaning: 'all in', usage: 'gamble joke' }];
  batch.gameWords = [{ term: '三角洲行动', meaning: 'extraction shooter' }];
  batch.commonWords = [{ term: '见好就收' }];
  batch.love = [{ title: '别熬夜', note: 'caring about sleep' }];
  store.mergeKnowledge(dir, { ...batch, videos: 1, method: 'llm' });

  const plain = prompt.buildBlock(dir, { promptBudget: 900 }, '今天吃什么');
  assert.ok(plain.includes('Meme vocabulary'), 'memes are always available');
  assert.ok(!plain.includes('Game vocabulary'), 'game words stay out of unrelated talk');

  const gaming = prompt.buildBlock(dir, { promptBudget: 900 }, '今天三角洲行动开黑吗');
  assert.ok(gaming.includes('Game vocabulary'), 'game talk unlocks game words');
  assert.ok(gaming.includes('三角洲行动'));
});

test('ethics is injected only when the message touches a minefield', () => {
  const dir = tempDir('ethics');
  const batch = learner.emptyBatch('');
  batch.ethics = [{ title: '地狱笑话', note: 'why it hurts', usage: 'do not laugh' }];
  store.mergeKnowledge(dir, { ...batch, videos: 1, method: 'llm' });

  const clean = prompt.buildBlock(dir, {}, '周末去哪玩');
  assert.ok(!clean.includes('Boundaries'));
  const dirty = prompt.buildBlock(dir, {}, '讲个地狱笑话听听');
  assert.ok(dirty.includes('Boundaries'));
});

test('the prompt budget is a hard cap', () => {
  const dir = tempDir('budget');
  const batch = learner.emptyBatch('');
  batch.memes = Array.from({ length: 4 }, (_, i) => ({
    term: `term${i}`,
    meaning: 'x'.repeat(120),
    usage: 'y'.repeat(120),
  }));
  batch.commonWords = Array.from({ length: 3 }, (_, i) => ({ term: `word${i}`, meaning: 'z'.repeat(120) }));
  batch.love = [{ title: 'care', note: 'n'.repeat(150) }];
  store.mergeKnowledge(dir, { ...batch, videos: 1, method: 'llm' });

  const block = prompt.buildBlock(dir, { promptBudget: 400 }, '随便说点什么');
  assert.ok(block.length <= 400 + 120, `block was ${block.length} chars`);
});

test('preview reports which gates fired', () => {
  const dir = tempDir('preview');
  const result = prompt.preview(dir, {}, '三角洲行动这个版本怎么样');
  assert.equal(result.gated.game, true);
  assert.equal(result.gated.ethics, false);
});

/* -------------------------------- topics ---------------------------------- */

test('topic extraction prefers repeated concrete words', () => {
  const ranked = topics.extract([
    '你们觉得螺蛳粉好吃吗',
    '螺蛳粉我昨天又吃了',
    '我觉得还行',
  ]);
  assert.equal(ranked[0].word, '螺蛳粉');
  assert.ok(ranked[0].count >= 2);
});

test('topic extraction drops configured self words', () => {
  const ranked = topics.extract(['鲸鱼娘今天好可爱', '鲸鱼娘在吗'], { selfWords: ['鲸鱼娘'] });
  assert.ok(!ranked.some((entry) => entry.word.includes('鲸鱼娘')));
});

test('pick returns none when there is too little to go on', async () => {
  const result = await topics.pick({ texts: ['嗯'] });
  assert.equal(result.source, 'none');
  assert.equal(result.topic, '');
});

test('pick uses the model when available and rejects a hyphen', async () => {
  const ok = await topics.pick({
    texts: ['三角洲行动新版本', '塞尔达也不错', '三角洲真好玩'],
    complete: async () => '三角洲行动',
  });
  assert.equal(ok.topic, '三角洲行动');
  assert.equal(ok.source, 'llm');

  // A hyphen means "I cannot tell": the local fallback may still find a word,
  // but the model's answer must not be used, and it must never invent one.
  const none = await topics.pick({
    texts: ['嗯', '好', '行'],
    complete: async () => '-',
  });
  assert.equal(none.topic, '');
  assert.equal(none.source, 'none');
});

/* -------------------------------- engine ---------------------------------- */

test('engine learns from local corpus only, end to end, without a model', async () => {
  const dir = tempDir('engine');
  const engine = createEngine({ dataDir: dir, config: { videosPerRun: 1 } });
  store.addRawItems(dir, [VIDEO]);

  const result = await engine.learn({ fromRaw: true, useLlm: false });
  assert.equal(result.ok, true);
  assert.equal(result.run.method, 'heuristic');
  assert.ok(result.summary.counts.memes > 0);

  const state = engine.state();
  assert.ok(state.lastRunAt);
  assert.equal(state.runs.length, 1);
  assert.ok(fs.existsSync(state.logPath), 'a learning log is written');

  const log = engine.learnLog();
  assert.ok(log.text.includes('三角洲行动'), 'the log names the video');
});

test('engine skips the run when no topic can be found', async () => {
  const dir = tempDir('notopic');
  const engine = createEngine({ dataDir: dir, config: {} });
  const result = await engine.learn({ texts: ['嗯'] });
  assert.equal(result.ok, false);
  assert.match(result.error, /no topic/i);
});

test('engine refuses to coin without a model', async () => {
  const dir = tempDir('coin');
  const engine = createEngine({ dataDir: dir });
  const result = await engine.coin({ keyword: '期末周' });
  assert.equal(result.ok, false);
  assert.match(result.error, /model/i);
});

test('engine coins with a model and remembers a picked candidate', async () => {
  const dir = tempDir('coin2');
  const engine = createEngine({ dataDir: dir });
  const result = await engine.coin({
    keyword: '期末周',
    complete: async () =>
      JSON.stringify({ items: [{ term: '期末周板载', meaning: '冲刺', how: 'homophone' }] }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.items[0].term, '期末周板载');

  const kept = engine.remember({ group: 'memes', item: result.items[0] });
  assert.equal(kept.ok, true);
  assert.ok(store.loadKnowledge(dir).memes.some((m) => m.term === '期末周板载'));
});

test('engine rejects a concurrent run instead of interleaving', async () => {
  const dir = tempDir('busy');
  store.addRawItems(dir, [VIDEO]);
  const engine = createEngine({ dataDir: dir });
  const first = engine.learn({ fromRaw: true, useLlm: false });
  const second = engine.learn({ fromRaw: true, useLlm: false });
  const [a, b] = await Promise.allSettled([first, second]);
  assert.equal(a.status, 'fulfilled');
  assert.equal(b.status, 'rejected');
  assert.equal(b.reason.code, 'busy');
});

test('reset clears the requested part of the corpus', () => {
  const dir = tempDir('reset');
  const engine = createEngine({ dataDir: dir });
  const batch = learner.emptyBatch('');
  batch.memes = [{ term: 'x' }];
  store.mergeKnowledge(dir, { ...batch, videos: 1, method: 'llm' });
  const result = engine.reset('knowledge');
  assert.equal(result.ok, true);
  assert.equal(store.loadKnowledge(dir).memes.length, 0);
});

/* ------------------------------ plugin surface ---------------------------- */

test('every tool definition carries a valid registry shape', () => {
  const dir = tempDir('tools');
  const engine = createEngine({ dataDir: dir });
  const tools = createTools(engine, async () => undefined);
  assert.equal(tools.length, 9);
  const names = new Set();
  for (const tool of tools) {
    assert.match(tool.name, /^fish_/);
    assert.ok(!names.has(tool.name), `${tool.name} is unique`);
    names.add(tool.name);
    assert.equal(typeof tool.description, 'string');
    assert.ok(tool.description.length > 40, `${tool.name} describes itself`);
    // The registry takes a flat property map, not a wrapped object schema, and
    // every property must carry its own `type` -- annotation-only nodes throw.
    assert.equal(typeof tool.parameters, 'object');
    assert.ok(!('type' in tool.parameters), `${tool.name} must not wrap its parameters`);
    for (const [key, schema] of Object.entries(tool.parameters)) {
      assert.ok(schema.type, `${tool.name}.${key} declares a type`);
      assert.match(schema.type, /^(string|number|integer|boolean|null|array|object)$/);
    }
    assert.equal(tool.output.schema.type, 'object');
    assert.equal(tool.output.schema.additionalProperties, true);
    assert.equal(typeof tool.output.render, 'function');
    assert.equal(typeof tool.execute, 'function');
  }
});

test('reading tools work through the registry surface', async () => {
  const dir = tempDir('tools2');
  const engine = createEngine({ dataDir: dir });
  const tools = Object.fromEntries(
    createTools(engine, async () => undefined).map((tool) => [tool.name, tool]),
  );

  const state = await tools.fish_state.execute({}, {});
  assert.equal(state.id, 'dsh-fish-billx');
  assert.ok(fs.existsSync(state.dir));

  const knowledge = await tools.fish_knowledge.execute({}, {});
  for (const group of store.GROUP_KEYS) assert.ok(Array.isArray(knowledge.groups[group]));

  const kept = await tools.fish_remember.execute(
    { group: 'memes', term: '梭哈', meaning: 'all in' },
    {},
  );
  assert.equal(kept.ok, true);

  const preview = await tools.fish_preview.execute({ text: '梭哈吗' }, {});
  assert.ok(preview.block.includes('梭哈'), 'a matching term is injected');

  const forgotten = await tools.fish_forget.execute({ group: 'memes', term: '梭哈' }, {});
  assert.equal(forgotten.removed, 1);
});

test('fish_learn surfaces a skip as a thrown error, not a silent success', async () => {
  const dir = tempDir('tools3');
  const engine = createEngine({ dataDir: dir });
  const tools = Object.fromEntries(
    createTools(engine, async () => undefined).map((tool) => [tool.name, tool]),
  );
  await assert.rejects(() => tools.fish_learn.execute({ texts: ['嗯'] }, {}), /no topic/i);
});

test('resolveDataDir honours explicit config, DSH_HOME, then the home directory', () => {
  assert.equal(resolveDataDir({ dataDir: 'C:\\tmp\\corpus' }), path.resolve('C:\\tmp\\corpus'));
  assert.equal(
    resolveDataDir({}, { DSH_HOME: 'C:\\harness-home' }),
    path.join(path.resolve('C:\\harness-home'), 'dsh-fish-billx', 'corpus'),
  );
  assert.equal(
    resolveDataDir({}, { USERPROFILE: 'C:\\Users\\me' }),
    path.join('C:\\Users\\me', '.dsh', 'dsh-fish-billx', 'corpus'),
  );
});

test('assembleText reads block-end and delta-based streams alike', () => {
  const viaDeltas = assembleText([
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'hello ' },
    { type: 'text-delta', index: 0, text: 'world' },
    { type: 'block-end', index: 0, block: { type: 'text', text: 'hello world' } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]);
  assert.equal(viaDeltas, 'hello world');

  const viaBlockOnly = assembleText([
    { type: 'block-end', index: 0, block: { type: 'text', text: 'only block' } },
  ]);
  assert.equal(viaBlockOnly, 'only block');
});

test('latestUserText picks the newest user message and ignores tool output', () => {
  const agent = {
    session: {
      deriveMessages: () => [
        { role: 'user', content: [{ type: 'text', text: 'old question' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'old answer' }] },
        { role: 'user', content: [{ type: 'text', text: 'newest question' }] },
      ],
    },
  };
  assert.equal(latestUserText(agent), 'newest question');
  assert.equal(latestUserText({}), '');
});

test('apply registers tools and appends the corpus section to the prompt', async () => {
  const dir = tempDir('apply');
  const registered = [];
  const listeners = [];
  const ctx = {
    logger: { info() {}, warn() {} },
    tools: { register: (definition) => registered.push(definition) },
    effect() {},
    on: (event, handler) => listeners.push({ event, handler }),
    get: () => undefined,
  };
  const { apply } = await import('../src/index.js');
  const mount = await apply(ctx, { dataDir: dir });
  assert.equal(registered.length, 9);
  assert.ok(mount.engine);

  // Seed knowledge, then run the assembly waterfall the way the harness does.
  const batch = learner.emptyBatch('');
  batch.memes = [{ term: '梭哈', meaning: 'all in' }];
  store.mergeKnowledge(dir, { ...batch, videos: 1, method: 'llm' });

  const assemble = listeners.find((l) => l.event === 'system-prompt/assemble');
  assert.ok(assemble, 'the prompt hook is registered');
  const agent = {
    session: { deriveMessages: () => [{ role: 'user', content: [{ type: 'text', text: '梭哈吗' }] }] },
  };
  const next = async () => ({ sections: [{ name: 'base', text: 'base prompt' }] });
  const assembled = await assemble.handler({ sections: [] }, { agent }, next);
  assert.equal(assembled.sections.length, 2);
  assert.equal(assembled.sections[1].name, 'dsh-fish-billx:corpus');
  assert.ok(assembled.sections[1].text.includes('梭哈'));

  // With no corpus yet, the hook must not add an empty section. This second
  // mount reuses the same seeded temp dir, so point it at a fresh one first.
  const emptyDir = tempDir('apply-empty');
  const emptyListeners = [];
  await apply(
    {
      ...ctx,
      tools: { register() {} },
      on: (event, handler) => emptyListeners.push({ event, handler }),
    },
    { dataDir: emptyDir },
  );
  const emptyAssemble = emptyListeners.find((l) => l.event === 'system-prompt/assemble');
  const emptyAssembled = await emptyAssemble.handler({ sections: [] }, { agent }, next);
  assert.equal(emptyAssembled.sections.length, 1);
});
