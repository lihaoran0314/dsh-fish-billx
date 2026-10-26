/**
 * Corpus persistence. Four files under the data directory:
 *
 *   raw.json        crawled videos (title / description / tags / comments /
 *                   danmaku), capped at 300, kept for learning
 *   knowledge.json  learned knowledge across the seven groups, weighted per term
 *   state.json      one summary per run (the timeline reads this)
 *   learn-log.md    the human-readable learning log, appended per run
 *
 * The seven groups are kept apart on purpose: memes / commonWords / gameWords
 * are *what to say*, coinage / emergence are *how to make things up*, ethics is
 * *what not to say*, and love is *how to care*. Mixed together, a model ends up
 * with a bag of context-free words.
 */

import fs from 'node:fs';
import path from 'node:path';

export const GROUPS = [
  { key: 'memes', kind: 'word', label: '梗' },
  { key: 'coinage', kind: 'idea', label: '造梗手法' },
  { key: 'emergence', kind: 'idea', label: '涌现现象' },
  { key: 'ethics', kind: 'idea', label: '道德边界', hasUsage: true },
  { key: 'commonWords', kind: 'word', label: '常用词' },
  { key: 'gameWords', kind: 'word', label: '游戏词汇' },
  { key: 'love', kind: 'idea', label: '爱的能力' },
];

export const GROUP_KEYS = GROUPS.map((group) => group.key);
export const LABEL = Object.fromEntries(GROUPS.map((group) => [group.key, group.label]));

export const LIMITS = {
  rawItems: 300,
  memes: 400,
  coinage: 150,
  emergence: 150,
  ethics: 120,
  commonWords: 400,
  gameWords: 300,
  love: 150,
  sources: 8,
  examples: 4,
};

export function emptyKnowledge() {
  const knowledge = {
    version: 2,
    updatedAt: '',
    stats: { learnedVideos: 0, learnedRuns: 0, methods: {}, summaries: [] },
  };
  for (const key of GROUP_KEYS) knowledge[key] = [];
  return knowledge;
}

export function fileFor(dir, name) {
  return path.join(dir, name);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

/* ------------------------------- raw corpus ------------------------------- */

export function loadRaw(dir) {
  const raw = readJson(fileFor(dir, 'raw.json'), null);
  return { items: Array.isArray(raw?.items) ? raw.items : [] };
}

export function saveRaw(dir, raw) {
  writeJson(fileFor(dir, 'raw.json'), { items: raw.items.slice(-LIMITS.rawItems) });
}

/** Add crawled videos: dedupe by bvid, newer wins (comment counts move). */
export function addRawItems(dir, items) {
  const raw = loadRaw(dir);
  const map = new Map(raw.items.map((item) => [item.bvid, item]));
  let added = 0;
  for (const item of items || []) {
    if (!item?.bvid) continue;
    if (!map.has(item.bvid)) added += 1;
    map.set(item.bvid, item);
  }
  raw.items = [...map.values()].slice(-LIMITS.rawItems);
  saveRaw(dir, raw);
  return { total: raw.items.length, added };
}

/** Items not learned yet (empty learnedAt), newest first. */
export function unlearnedItems(dir, { limit = 8 } = {}) {
  return loadRaw(dir)
    .items.filter((item) => !item.learnedAt)
    .sort((a, b) => (b.pubdate || 0) - (a.pubdate || 0))
    .slice(0, limit);
}

export function markLearned(dir, bvids, method) {
  const raw = loadRaw(dir);
  const set = new Set(bvids || []);
  const at = new Date().toISOString();
  for (const item of raw.items) {
    if (!set.has(item.bvid)) continue;
    item.learnedAt = at;
    item.learnMethod = method || '';
  }
  saveRaw(dir, raw);
}

/* ------------------------------- knowledge -------------------------------- */

/** Older files (only memes/emergence/love) stay usable: missing groups get []. */
export function loadKnowledge(dir) {
  const saved = readJson(fileFor(dir, 'knowledge.json'), null);
  const base = emptyKnowledge();
  if (!saved || typeof saved !== 'object') return base;
  const out = { ...base, ...saved, stats: { ...base.stats, ...(saved.stats || {}) } };
  for (const key of GROUP_KEYS) if (!Array.isArray(out[key])) out[key] = [];
  if (!Array.isArray(out.stats.summaries)) out.stats.summaries = [];
  return out;
}

export function saveKnowledge(dir, knowledge) {
  knowledge.version = 2;
  knowledge.updatedAt = new Date().toISOString();
  for (const key of GROUP_KEYS) {
    const cap = LIMITS[key] || 200;
    if (knowledge[key].length > cap) {
      knowledge[key] = knowledge[key]
        .slice()
        .sort(
          (a, b) =>
            (b.weight || 1) - (a.weight || 1) ||
            String(b.lastSeen || '').localeCompare(String(a.lastSeen || '')),
        )
        .slice(0, cap);
    }
  }
  knowledge.stats.summaries = knowledge.stats.summaries.slice(0, 40);
  writeJson(fileFor(dir, 'knowledge.json'), knowledge);
  return knowledge;
}

export function groupMeta(group) {
  return GROUPS.find((entry) => entry.key === group) || null;
}

export function keyOf(item) {
  return String(item && (item.term || item.title) || '')
    .toLowerCase()
    .replace(/[\s，,。.!！?？~～、:：;；"'“”‘’()（）[\]【】]+/g, '')
    .slice(0, 60);
}

/**
 * Merge one learning run into the knowledge base. Seeing a term again bumps
 * its weight (+1), examples cap at 4, sources at 8. The ethics group stores no
 * original example at all — the original may itself carry a slur.
 */
export function mergeKnowledge(dir, batch, { source = '' } = {}) {
  const knowledge = loadKnowledge(dir);
  const now = new Date().toISOString();
  const added = {};
  for (const key of GROUP_KEYS) added[key] = 0;
  added.updated = 0;
  const addedItems = [];

  for (const group of GROUP_KEYS) {
    const meta = groupMeta(group);
    const incoming = Array.isArray(batch?.[group]) ? batch[group] : [];
    const index = new Map(knowledge[group].map((item) => [keyOf(item), item]));
    for (const raw of incoming) {
      const key = keyOf(raw);
      if (!key) continue;
      const example = meta.kind === 'word' ? String(raw?.example || '').trim() : '';
      const hit = index.get(key);
      if (hit) {
        hit.weight = Number(hit.weight || 1) + 1;
        hit.lastSeen = now;
        if (raw.meaning && (!hit.meaning || String(raw.meaning).length > String(hit.meaning).length)) {
          hit.meaning = String(raw.meaning).slice(0, 120);
        }
        if (raw.usage) hit.usage = String(raw.usage).slice(0, 140);
        if (raw.note) hit.note = String(raw.note).slice(0, 220);
        hit.examples = hit.examples || [];
        if (example && !hit.examples.includes(example)) hit.examples.unshift(example.slice(0, 120));
        hit.examples = hit.examples.slice(0, LIMITS.examples);
        hit.sources = hit.sources || [];
        if (source && !hit.sources.includes(source)) hit.sources.unshift(source);
        hit.sources = hit.sources.slice(0, LIMITS.sources);
        added.updated += 1;
        continue;
      }
      const item = {
        weight: 1,
        firstSeen: now,
        lastSeen: now,
        examples: example ? [example.slice(0, 120)] : [],
        sources: source ? [source] : [],
      };
      if (meta.kind === 'word') {
        item.term = String(raw.term || '').slice(0, 40);
        item.meaning = String(raw.meaning || '').slice(0, 120);
        item.usage = String(raw.usage || '').slice(0, 140);
      } else {
        item.title = String(raw.title || '').slice(0, 40);
        item.note = String(raw.note || '').slice(0, 220);
        if (meta.hasUsage) item.usage = String(raw.usage || '').slice(0, 140);
      }
      knowledge[group].push(item);
      index.set(key, item);
      added[group] += 1;
      addedItems.push({ group, title: item.term || item.title });
    }
  }

  knowledge.stats.learnedVideos =
    Number(knowledge.stats.learnedVideos || 0) + (batch?.videos ? batch.videos : 0);
  knowledge.stats.learnedRuns = Number(knowledge.stats.learnedRuns || 0) + 1;
  const method = batch?.method || 'unknown';
  knowledge.stats.methods[method] = (knowledge.stats.methods[method] || 0) + 1;
  if (batch?.summary) {
    knowledge.stats.summaries.unshift({ at: now, text: String(batch.summary).slice(0, 200), source });
    knowledge.stats.summaries = knowledge.stats.summaries.slice(0, 40);
  }
  saveKnowledge(dir, knowledge);
  return { added, addedItems, knowledge };
}

/** Drop one entry by hand (off-target, duplicated, wrong). */
export function forget(dir, group, term) {
  if (!GROUP_KEYS.includes(group)) return { removed: 0 };
  const knowledge = loadKnowledge(dir);
  const key = keyOf({ term, title: term });
  const before = knowledge[group].length;
  knowledge[group] = knowledge[group].filter((item) => keyOf(item) !== key);
  saveKnowledge(dir, knowledge);
  return { removed: before - knowledge[group].length };
}

/** Summary used by the state tool: counts plus the top few of each group. */
export function summary(dir, { top = 6 } = {}) {
  const knowledge = loadKnowledge(dir);
  const pick = (arr) =>
    arr
      .slice()
      .sort((a, b) => (b.weight || 1) - (a.weight || 1))
      .slice(0, top);
  const raw = loadRaw(dir);
  const counts = {
    raw: raw.items.length,
    unlearned: raw.items.filter((item) => !item.learnedAt).length,
  };
  const topLists = {};
  for (const key of GROUP_KEYS) {
    counts[key] = knowledge[key].length;
    topLists[key] = pick(knowledge[key]);
  }
  return {
    counts,
    labels: LABEL,
    updatedAt: knowledge.updatedAt || '',
    stats: knowledge.stats,
    top: topLists,
  };
}

/* --------------------------------- state ---------------------------------- */

export function loadState(dir) {
  const state = readJson(fileFor(dir, 'state.json'), null);
  return state && typeof state === 'object' ? state : { lastRunAt: '', lastRun: null, runs: [] };
}

export function saveState(dir, state) {
  writeJson(fileFor(dir, 'state.json'), state);
}

export function recordRun(dir, run) {
  const state = loadState(dir);
  state.lastRunAt = new Date().toISOString();
  state.lastRun = run;
  state.runs = [run, ...(Array.isArray(state.runs) ? state.runs : [])].slice(0, 30);
  saveState(dir, state);
  return state;
}

/* ---------------------------- human-readable log -------------------------- */

export const LOG_FILE = 'learn-log.md';

export function logPath(dir) {
  return fileFor(dir, LOG_FILE);
}

export function stamp(at = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())} ${p(at.getHours())}:${p(at.getMinutes())}`;
}

function groupCountsText(counts) {
  const parts = [];
  for (const key of GROUP_KEYS) {
    const n = Number(counts?.[key] || 0);
    if (n > 0) parts.push(`${LABEL[key]} ${n}`);
  }
  return parts.length ? parts.join(', ') : 'nothing new';
}

/**
 * Append one human-readable run. One block per run: keyword, which videos,
 * what each one taught, which terms were new.
 */
export function appendLearnLog(dir, run) {
  const lines = [];
  const title = run.kind === 'crawl' ? 'crawl' : 'learn';
  lines.push('');
  lines.push(`## ${stamp(new Date(run.at || Date.now()))} · ${title} · keyword "${run.keyword || '-'}"`);
  if (run.kind === 'crawl') {
    lines.push(
      `- crawled ${run.fetched || 0} videos, ${run.added || 0} new (${run.total || 0} stored locally)`,
    );
    for (const video of run.videos || []) {
      lines.push(
        `  - ${video.title} (${video.bvid}) ${video.comments || 0} comments / ${video.danmaku || 0} danmaku`,
      );
    }
  } else if (run.ok === false) {
    lines.push(`- FAILED: ${run.error || 'unknown error'}`);
  } else {
    lines.push(
      `- learned ${run.learned || 0} videos via ${run.method === 'llm' ? 'model extraction' : run.method === 'heuristic' ? 'local statistics' : 'mixed'}`,
    );
    lines.push(`- this run added: ${groupCountsText(run.counts)}`);
    for (const video of run.videos || []) {
      lines.push('');
      lines.push(`### ${video.title} (${video.bvid})`);
      if (video.summary) lines.push(`- what the comment section is doing: ${video.summary}`);
      lines.push(`- learned here: ${groupCountsText(video.counts)}`);
      for (const group of GROUP_KEYS) {
        const list = video.added?.[group] || [];
        if (!list.length) continue;
        lines.push(`- ${LABEL[group]}: ${list.join(', ')}`);
      }
    }
  }
  lines.push('');
  try {
    fs.mkdirSync(dir, { recursive: true });
    const header = fs.existsSync(logPath(dir))
      ? ''
      : '# Corpus learning log\n\nOne block per crawl / learning run, newest last.\n';
    fs.appendFileSync(logPath(dir), header + lines.join('\n'), 'utf8');
  } catch {
    /* a log write failure must not fail the learning run */
  }
  return lines.join('\n');
}

export function readLearnLog(dir, { tailChars = 40000 } = {}) {
  try {
    const text = fs.readFileSync(logPath(dir), 'utf8');
    return text.length > tailChars ? '...(earlier entries omitted)\n' + text.slice(-tailChars) : text;
  } catch {
    return '';
  }
}

export function reset(dir, what = 'all') {
  const targets =
    what === 'knowledge'
      ? ['knowledge.json']
      : what === 'raw'
        ? ['raw.json']
        : what === 'log'
          ? [LOG_FILE]
          : ['knowledge.json', 'raw.json', 'state.json', LOG_FILE];
  for (const name of targets) {
    try {
      fs.unlinkSync(path.join(dir, name));
    } catch {
      /* already gone */
    }
  }
  return targets;
}
