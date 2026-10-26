/**
 * The corpus engine: everything the plugin does, with no Cordis or DSH imports.
 *
 * Keeping it host-free is deliberate -- the engine can be driven from a test,
 * a CLI, or the plugin entry, and the tool layer stays a thin adapter. The only
 * capability it needs from the host is a `complete()` model call, injected.
 */

import * as bili from './bili.js';
import * as learner from './learner.js';
import * as store from './store.js';
import * as prompt from './prompt.js';
import * as topics from './topics.js';

export function createEngine({ dataDir, config = {}, logger = null } = {}) {
  if (!dataDir) throw new Error('dsh-fish-billx: dataDir is required');
  const dir = dataDir;
  const cfg = () => config || {};
  let job = null;

  const log = (line) => {
    if (job) {
      job.log.push(line);
      if (job.log.length > 80) job.log.shift();
    }
    logger?.info?.('[dsh-fish-billx] ' + line);
  };

  /**
   * What to search this round:
   *   explicit keyword > config.keywords > topic of the supplied messages > nothing.
   * Nothing means: do not learn this round. Searching a stand-in word is the
   * failure mode this ordering exists to prevent.
   */
  async function resolveKeyword({ keyword = '', texts = [], complete = null } = {}) {
    const kw = String(keyword || '').trim();
    if (kw) return { keyword: kw, source: 'manual' };
    const list = (cfg().keywords || []).map((s) => String(s || '').trim()).filter(Boolean);
    if (list.length) {
      return { keyword: list[Math.floor(Math.random() * list.length)], source: 'config' };
    }
    const picked = await topics.pick({ complete, config: cfg(), texts });
    if (picked.topic) return { keyword: picked.topic, source: picked.source, candidates: picked.candidates };
    return { keyword: '', source: 'none', candidates: picked.candidates || [], reason: picked.reason };
  }

  function limits(over = {}) {
    const c = cfg();
    return {
      videos: Number(over.videos) || Number(c.videosPerRun) || 3,
      comments: Number(over.comments) || Number(c.commentsPerVideo) || 40,
      danmaku:
        over.danmaku === 0 ? 0 : Number(over.danmaku) || Number(c.danmakuPerVideo) || 60,
      cookie: String(over.cookie || c.cookie || ''),
      limit: Number(over.limit) || Number(over.videos) || Number(c.videosPerRun) || 3,
    };
  }

  function begin(phase, keyword) {
    if (job) {
      const error = new Error(`the previous run is still going (${job.phase}); wait for it to finish`);
      error.code = 'busy';
      throw error;
    }
    job = { phase, keyword: keyword || '', done: 0, total: 0, startedAt: Date.now(), log: [] };
    return job;
  }

  function sumCounts(list) {
    const out = {};
    for (const key of store.GROUP_KEYS) out[key] = 0;
    for (const counts of list) {
      for (const key of store.GROUP_KEYS) out[key] += Number(counts?.[key] || 0);
    }
    return out;
  }

  function countText(counts) {
    const parts = [];
    for (const key of store.GROUP_KEYS) {
      const n = Number(counts?.[key] || 0);
      if (n > 0) parts.push(store.LABEL[key] + ' ' + n);
    }
    return parts.length ? parts.join(', ') : 'nothing new';
  }

  function groupText(counts) {
    return store.GROUP_KEYS.map((key) => store.LABEL[key] + ' ' + (counts[key] || 0)).join(' / ');
  }

  /** Crawl only: store the material now, learn it later in bulk. */
  async function crawl({ keyword = '', texts = [], ...over } = {}) {
    const picked = await resolveKeyword({ keyword, texts });
    const kw = picked.keyword;
    if (!kw) {
      return {
        ok: false,
        error:
          'no topic to search: not enough conversation and no keywords configured, so this round is skipped',
        candidates: picked.candidates || [],
      };
    }
    const lim = limits(over);
    begin('crawl', kw);
    try {
      log(`crawling "${kw}" (source: ${picked.source}), up to ${lim.videos} videos`);
      const items = await bili.crawlKeyword(kw, {
        videos: lim.videos,
        comments: lim.comments,
        danmaku: lim.danmaku,
        cookie: lim.cookie,
        logger,
        onProgress: (p) => {
          job.done = p.done;
          job.total = p.total;
          job.current = p.title || '';
        },
      });
      // Content gate: ASMR / borderline / maternity items never enter the store.
      const safe = [];
      for (const item of items) {
        if (learner.isUnsafeItem(item)) {
          log(`skipping unsafe content: ${String(item.title).slice(0, 24)}`);
          continue;
        }
        safe.push(item);
      }
      const added = store.addRawItems(dir, safe);
      const run = {
        at: new Date().toISOString(),
        kind: 'crawl',
        keyword: kw,
        fetched: items.length,
        added: added.added,
        total: added.total,
        skipped: items.length - safe.length,
        videos: safe.map((item) => ({
          bvid: item.bvid,
          title: item.title,
          comments: (item.comments || []).length,
          danmaku: (item.danmaku || []).length,
        })),
      };
      store.recordRun(dir, run);
      store.appendLearnLog(dir, run);
      log(`crawl finished: ${added.added} new, ${added.total} stored locally`);
      return { ok: true, run, summary: store.summary(dir) };
    } finally {
      job = null;
    }
  }

  /**
   * Crawl + learn (fromRaw = only learn what is already stored).
   * Whole-document learning: each video's material is not truncated; the
   * learner batches it by ~3200 characters, at most three batches.
   */
  async function learn({
    keyword = '',
    texts = [],
    fromRaw = false,
    useLlm = true,
    complete = null,
    ...over
  } = {}) {
    const picked = fromRaw
      ? { keyword: String(keyword || '').trim() || '(local corpus)', source: 'local' }
      : await resolveKeyword({ keyword, texts, complete });
    const kw = picked.keyword;
    if (!kw) {
      return {
        ok: false,
        error:
          'no topic to search: not enough conversation and no keywords configured, so this round is skipped',
        candidates: picked.candidates || [],
      };
    }
    const lim = limits(over);
    const modelCall = useLlm && typeof complete === 'function' ? complete : null;
    begin('learn', kw);
    try {
      let freshBvids = new Set();
      if (!fromRaw) {
        log(`crawling "${kw}" (source: ${picked.source}), up to ${lim.videos} videos`);
        const fresh = await bili.crawlKeyword(kw, {
          videos: lim.videos,
          comments: lim.comments,
          danmaku: lim.danmaku,
          cookie: lim.cookie,
          logger,
          onProgress: (p) => {
            job.done = p.done;
            job.total = p.total;
            job.current = p.title || '';
          },
        });
        const safe = fresh.filter((item) => !learner.isUnsafeItem(item));
        if (safe.length !== fresh.length) log(`skipped ${fresh.length - safe.length} unsafe items`);
        store.addRawItems(dir, safe);
        freshBvids = new Set(safe.map((item) => item.bvid));
        log(`crawled ${safe.length} videos, starting whole-document extraction`);
      }

      // Learn this batch first (the user asked for this keyword); top up with
      // whatever else is still unlearned.
      let items = [];
      if (freshBvids.size) {
        items = store
          .loadRaw(dir)
          .items.filter((item) => freshBvids.has(item.bvid) && !item.learnedAt);
      }
      if (items.length < lim.limit) {
        const pool = store
          .unlearnedItems(dir, { limit: lim.limit + items.length })
          .filter((item) => !freshBvids.has(item.bvid));
        items = items.concat(pool.slice(0, Math.max(0, lim.limit - items.length)));
      }
      if (!items.length) {
        const message = 'nothing learnable locally: crawl a batch first, or turn off "only learn stored corpus"';
        const run = { at: new Date().toISOString(), kind: 'learn', ok: false, keyword: kw, error: message };
        store.recordRun(dir, run);
        store.appendLearnLog(dir, run);
        return { ok: false, error: message, summary: store.summary(dir) };
      }

      job.phase = 'learn';
      job.done = 0;
      job.total = items.length;
      const videos = [];
      for (let i = 0; i < items.length; i += 1) {
        const item = items[i];
        job.current = item.title;
        // Old corpus may already hold unsafe material; re-check and mark it skipped.
        if (learner.isUnsafeItem(item)) {
          store.markLearned(dir, [item.bvid], 'skipped');
          log(`skipping unsafe content: ${String(item.title).slice(0, 24)}`);
          job.done = i + 1;
          continue;
        }
        const { batch, method, chunks } = await learner.learnOne(item, {
          complete: modelCall,
          logger,
        });
        const counts = learner.batchCounts(batch);
        const merged = store.mergeKnowledge(
          dir,
          { ...batch, videos: 1, method },
          { source: item.bvid },
        );
        store.markLearned(dir, [item.bvid], method);
        const added = {};
        for (const key of store.GROUP_KEYS) added[key] = [];
        for (const entry of merged.addedItems) added[entry.group].push(entry.title);
        videos.push({
          bvid: item.bvid,
          title: item.title,
          method,
          chunks: chunks || 1,
          summary: batch.summary || '',
          counts,
          added,
        });
        log(
          `"${String(item.title).slice(0, 18)}"${chunks > 1 ? ` (${chunks} batches)` : ''} -> ` +
            `${countText(counts)} (${method === 'llm' ? 'model' : 'local statistics'})`,
        );
        if (batch.summary) log('  gist: ' + batch.summary);
        job.done = i + 1;
      }

      const totals = sumCounts(videos.map((v) => v.counts));
      const method = videos.every((v) => v.method === 'llm')
        ? 'llm'
        : videos.some((v) => v.method === 'llm')
          ? 'mixed'
          : 'heuristic';
      const run = {
        at: new Date().toISOString(),
        kind: 'learn',
        ok: true,
        keyword: kw,
        method,
        videos,
        learned: videos.length,
        counts: totals,
      };
      store.recordRun(dir, run);
      store.appendLearnLog(dir, run);
      const summary = store.summary(dir);
      log(`learned ${videos.length} videos, added: ${groupText(summary.counts)}`);
      return { ok: true, run, summary };
    } catch (error) {
      const run = {
        at: new Date().toISOString(),
        kind: 'learn',
        ok: false,
        keyword: kw,
        error: String(error?.message || error),
      };
      store.recordRun(dir, run);
      store.appendLearnLog(dir, run);
      throw error;
    } finally {
      job = null;
    }
  }

  /**
   * Coinage machine: coin fresh sayings for a keyword out of learned memes and
   * techniques. Returns candidates only -- nothing is stored until the caller
   * explicitly remembers one.
   */
  async function coin({ keyword = '', count = 5, complete = null } = {}) {
    const kw = String(keyword || '').trim();
    if (!kw) {
      const error = new Error('a keyword is required to coin something');
      error.code = 'bad';
      throw error;
    }
    if (typeof complete !== 'function') {
      return { ok: false, error: 'coining needs a model; no sayings are hard-coded locally', items: [] };
    }
    const knowledge = store.loadKnowledge(dir);
    const p = learner.buildCoinPrompt(kw, knowledge, { count });
    const text = await complete({ ...p, maxTokens: 700 });
    const items = learner.parseCoin(text);
    if (!items.length) {
      return { ok: false, error: 'the model produced nothing usable (reply was not valid JSON)', items: [] };
    }
    return { ok: true, keyword: kw, items, method: 'llm' };
  }

  /** Keep one coined saying (default group: memes). */
  function remember({ group = 'memes', item = null } = {}) {
    const target = store.GROUP_KEYS.includes(group) ? group : 'memes';
    const title = String(item && (item.term || item.title) || '').trim();
    if (!title) {
      const error = new Error('the entry to keep is empty');
      error.code = 'bad';
      throw error;
    }
    const payload = { videos: 0, method: 'coin', [target]: [item] };
    const merged = store.mergeKnowledge(dir, payload, { source: 'coining' });
    log(`kept "${title}" -> ${store.LABEL[target]}`);
    return { ok: true, group: target, added: merged.added, summary: store.summary(dir) };
  }

  /** Delete one entry by hand (off-target / wrong). */
  function forget({ group = 'memes', term = '' } = {}) {
    const name = String(term || '').trim();
    if (!name) {
      const error = new Error('which entry should be removed?');
      error.code = 'bad';
      throw error;
    }
    const result = store.forget(dir, group, name);
    log(`forgot ${store.LABEL[group] || group} "${name}" (${result.removed})`);
    return { ok: true, removed: result.removed, summary: store.summary(dir) };
  }

  function state() {
    const s = store.summary(dir);
    const st = store.loadState(dir);
    return {
      id: 'dsh-fish-billx',
      enabled: cfg().enabled !== false,
      promptEnabled: cfg().promptEnabled !== false,
      keywords: cfg().keywords || [],
      promptBudget: Number(cfg().promptBudget) || 900,
      groups: store.GROUPS,
      job: job
        ? {
            phase: job.phase,
            keyword: job.keyword,
            done: job.done,
            total: job.total,
            current: job.current || '',
            startedAt: job.startedAt,
            log: job.log.slice(-14),
          }
        : null,
      summary: s,
      lastRunAt: st.lastRunAt || '',
      runs: (st.runs || []).slice(0, 12),
      logPath: store.logPath(dir),
      dir,
    };
  }

  function reset(what) {
    const files = store.reset(dir, what || 'all');
    log(`cleared: ${files.join(', ')}`);
    return { ok: true, cleared: files, summary: store.summary(dir) };
  }

  function previewPrompt(text = '') {
    return { ...prompt.preview(dir, cfg(), text), summary: store.summary(dir) };
  }

  function learnLog(opts) {
    return { ok: true, path: store.logPath(dir), text: store.readLearnLog(dir, opts) };
  }

  /** One-turn injection fragment for the given user text. */
  function promptBlock(text) {
    return prompt.buildBlock(dir, cfg(), text);
  }

  return {
    dir,
    state,
    crawl,
    learn,
    coin,
    remember,
    forget,
    reset,
    previewPrompt,
    learnLog,
    promptBlock,
    resolveKeyword,
  };
}
