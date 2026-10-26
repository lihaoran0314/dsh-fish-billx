/**
 * Corpus learning: turn one video's *whole* material (title / description /
 * tags / top comments with replies / danmaku) into seven kinds of transferable
 * knowledge.
 *
 *   memes       — black slang you can answer with
 *   coinage     — how these people *invent* new sayings (homophone, splice, abbreviation)
 *   emergence   — collective behaviour nobody organised
 *   ethics      — what crosses a line, and how to react instead
 *   commonWords — everyday words and verbal tics of this crowd
 *   gameWords   — game titles and in-group jargon, never guessed from the characters
 *   love        — ways of actually caring that do not sound fake
 *
 * "Whole-document learning": the material is not shredded into isolated gags.
 * It is packed into ~3200-char batches (at most three) and the model is asked
 * for a one-line summary of what the comment section is doing before it
 * extracts anything — that summary is what makes the learning log readable.
 *
 * With a model this is model extraction; without one it falls back to pure
 * local statistics, so the button always lands something on disk.
 */

export const MAX = {
  memes: 5,
  coinage: 2,
  emergence: 2,
  ethics: 2,
  commonWords: 6,
  gameWords: 5,
  love: 2,
};

export const GROUPS = [
  'memes',
  'coinage',
  'emergence',
  'ethics',
  'commonWords',
  'gameWords',
  'love',
];

export const WORD_GROUPS = new Set(['memes', 'commonWords', 'gameWords']);

const SCHEMA_HINT = `Output format (JSON only, no code fence, no prose):
{"summary":"one line on what this comment section is doing (<=40 chars)",
 "memes":[{"term":"","meaning":"","usage":"","example":""}],
 "coinage":[{"title":"technique name","note":"how to coin a new word with it","example":""}],
 "emergence":[{"title":"","note":"","example":""}],
 "ethics":[{"title":"the kind of transgression","note":"why it hurts / how to spot it","usage":"what to do instead"}],
 "commonWords":[{"term":"","meaning":"","usage":"","example":""}],
 "gameWords":[{"term":"","meaning":"","usage":"","example":""}],
 "love":[{"title":"","note":"","example":""}]}
Use an empty array for any category with nothing to report.`;

export const SYSTEM = `You are a Chinese-internet corpus analyst. The input is one Bilibili video's whole material (possibly in several batches):
title, uploader, partition, description, tags, top comments (with replies), danmaku.

Read the whole thing before writing. Then use "summary" for one line on what this comment section is doing, and finally extract across seven categories:

1) memes: slang, abbreviations, fixed sentence patterns, comment-section games. Test: this crowd repeats it, and it still works away from the original video.
2) coinage: how these people *coin new sayings* — homophone substitution, splicing an old meme onto a new topic, abbreviation, rhyme, reversal, deliberate typos.
   Abstract it into a technique, not another meme; "note" says how to apply it to a different topic.
3) emergence: nobody organised it, yet a crowd grows an order, a game, a chain, a tacit understanding, or an expression everyone suddenly adopts.
4) ethics: did anyone cross a line here — joking about disaster/illness/death/accidents (hell jokes), regional/gender/racial/body/education/occupation discrimination, shaming a person or group, making a meme of a tragedy.
   Extract it only if present; otherwise leave the array empty. This is NOT a "risk notice": account-theft ads or boosting scams belong to cyber-security, do not put them here.
   NEVER quote the original sentence and never copy a slur. Summarise instead: "note" says why it hurts and how to recognise it, "usage" says what she should do (do not play along, do not laugh, reply coldly or say it is not funny).
5) commonWords: words, interjections, verbal tics this crowd uses every day (not necessarily memes, but very frequent).
6) gameWords: game titles and in-group jargon (Delta Force, Genshin, Honor of Kings, Valorant, PUBG Mobile, Zenless Zone Zero, Honkai: Star Rail, Naraka, CS, LOL, ...). Give the in-group meaning; never guess from the characters.
7) love: ways of genuinely caring, defending, missing someone, comforting, or being cute that do not ring false.

Strict requirements:
- "example" must be a fragment that really exists in the input. Do not rewrite it, do not invent it. ethics gets no example at all.
- Drop memes you do not understand. Fewer and right beats padded.
- term/title <= 12 chars; meaning/note/usage <= 40 chars.
${SCHEMA_HINT}`;

export function clip(s, n) {
  return String(s == null ? '' : s)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, n);
}

/** Split the material into blocks; the packing step below decides the batches. */
export function blocksFor(item) {
  const blocks = [];
  const head = ['[title] ' + clip(item.title, 90)];
  if (item.owner) head.push('[uploader] ' + clip(item.owner, 30));
  if (item.tname) head.push('[partition] ' + clip(item.tname, 20));
  if (item.desc) head.push('[description] ' + clip(item.desc, 1200));
  if (item.tags?.length) head.push('[tags] ' + item.tags.slice(0, 20).join(' / '));
  blocks.push(head.join('\n'));

  const comments = item.comments || [];
  // Eight comments per block: an oversized block breaks the char-based packing
  // and the first batch ends up holding nothing but the header.
  for (let i = 0; i < comments.length; i += 8) {
    const parts = [i === 0 ? '[top comments]' : '[top comments (cont.)]'];
    comments.slice(i, i + 8).forEach((comment, j) => {
      parts.push(`${i + j + 1}. (${comment.like || 0} likes) ${clip(comment.text, 140)}`);
      for (const reply of (comment.replies || []).slice(0, 3)) {
        parts.push(`   reply: ${clip(reply, 80)}`);
      }
    });
    blocks.push(parts.join('\n'));
  }

  const danmaku = item.danmaku || [];
  for (let i = 0; i < danmaku.length; i += 24) {
    blocks.push(
      '[danmaku] ' +
        danmaku
          .slice(i, i + 24)
          .map((d) => `${d.count}x ${clip(d.text, 22)}`)
          .join(' | '),
    );
  }
  return blocks;
}

/** Pack blocks into batches by character budget. Nothing is truncated, only batched. */
export function composeChunks(item, { maxChars = 3200, maxChunks = 3 } = {}) {
  const blocks = blocksFor(item);
  const chunks = [];
  let current = '';
  for (const block of blocks) {
    if (current && current.length + block.length + 1 > maxChars) {
      chunks.push(current);
      current = '';
      if (chunks.length >= maxChunks) break;
    }
    current = current ? current + '\n' + block : block;
  }
  if (current && chunks.length < maxChunks) chunks.push(current);
  if (!chunks.length) chunks.push(clip(item.title || '', 60));
  return chunks.map((c, i) =>
    chunks.length > 1 ? `[whole material, batch ${i + 1}/${chunks.length}]\n${c}` : c,
  );
}

/** Compatibility: one-batch view of the same material. */
export function composeInput(item) {
  return composeChunks(item, { maxChunks: 1 })[0];
}

/**
 * Pull JSON out of a model reply: drop the fence, take first `{` to last `}`,
 * then rescue what can be rescued when the reply was cut off mid-object.
 */
export function parseLooseJson(text) {
  let s = String(text || '').trim();
  s = s
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/, '')
    .trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0) return null;
  const body = end > start ? s.slice(start, end + 1) : s.slice(start);
  try {
    return JSON.parse(body);
  } catch {
    const fixed = body
      .replace(/,\s*([}\]])/g, '$1')
      .replace(/[“”]/g, '"')
      .replace(/[‘’]/g, "'");
    try {
      return JSON.parse(fixed);
    } catch {
      /* fall through to object-by-object rescue */
    }
  }
  // Truncated by max_tokens: grab every complete object per category.
  const out = { summary: '' };
  for (const key of GROUPS) out[key] = [];
  const summary = body.match(/"summary"\s*:\s*"([^"]{0,200})"/);
  if (summary) out.summary = summary[1];
  for (const key of GROUPS) {
    const from = body.indexOf('"' + key + '"');
    if (from < 0) continue;
    let to = body.length;
    for (const other of GROUPS) {
      if (other === key) continue;
      const i = body.indexOf('"' + other + '"', from + 1);
      if (i > from && i < to) to = i;
    }
    for (const obj of body.slice(from, to).matchAll(/\{[^{}]*\}/g)) {
      try {
        out[key].push(JSON.parse(obj[0]));
      } catch {
        /* this object is broken too; skip it */
      }
    }
  }
  return GROUPS.some((key) => out[key].length) || out.summary ? out : null;
}

/** Profanity / slurs never enter the word lists. */
export const PROFANITY_RE =
  /(傻逼|沙比|煞笔|他妈的|你妈的|操你|尼玛|婊子|贱人|尼哥|黑鬼|支那|死全家|孤儿东西)/;

export function sanitizeBatch(raw) {
  const out = { summary: clip(raw?.summary, 80) };
  for (const key of GROUPS) out[key] = [];
  const arr = (v) => (Array.isArray(v) ? v : []);
  for (const group of GROUPS) {
    const need = MAX[group];
    for (const item of arr(raw?.[group])) {
      const title = clip(item && (item.term || item.title), 24);
      if (!title) continue;
      if (WORD_GROUPS.has(group) && PROFANITY_RE.test(title + clip(item.meaning, 40))) continue;
      if (WORD_GROUPS.has(group)) {
        out[group].push({
          term: title,
          meaning: clip(item.meaning, 80),
          usage: clip(item.usage, 80),
          example: clip(item.example, 60),
        });
      } else if (group === 'ethics') {
        // Keep "what / why / what to do"; not one character of the original.
        out[group].push({ title, note: clip(item.note, 100), usage: clip(item.usage, 100) });
      } else {
        out[group].push({ title, note: clip(item.note, 100), example: clip(item.example, 60) });
      }
      if (out[group].length >= need) break;
    }
  }
  return out;
}

export function emptyBatch(summary = '') {
  const batch = { summary };
  for (const key of GROUPS) batch[key] = [];
  return batch;
}

/* ------------------------------ safety gate ------------------------------ */

/**
 * Content gate. ASMR / borderline / maternity material has no conversational
 * value to learn from and only sours the corpus, so a hit means: do not store
 * it, do not learn it. Losing one video beats flooding the profile.
 */
export const UNSAFE_RE =
  /(音声|ASMR|asmr|助眠|擦边|福利姬|福利向|色情|成人向|成人内容|涩涩|黄游|里番|R18|r18|肉体|做爱|性爱|口交|怀孕|孕晚期|哺乳|产子|露点|无码|裸|脱衣|调教)/;

export function isUnsafeText(text) {
  return UNSAFE_RE.test(String(text || ''));
}

export function isUnsafeItem(item) {
  if (!item) return false;
  const text = [item.title, item.desc, (item.tags || []).join(' ')].join(' ');
  if (isUnsafeText(text)) return true;
  const hits = (item.comments || []).filter((comment) => isUnsafeText(comment.text)).length;
  return hits >= 3;
}

/* --------------------------- heuristic fallback --------------------------- */

const LOVE_RE =
  /(抱抱|摸摸头|辛苦了|别熬夜|早点睡|早点休息|注意身体|照顾好自己|好好吃饭|记得吃饭|吃了吗|多喝水|别累着|我在的|我在呢|陪你|心疼|想你了|想你|别怕|没事的|有我呢|你很重要|喜欢你|爱你|好好的)/;

const EMERGE_RE = /(全员|所有人|大家|集体|一起|都来|接力|接龙|队形|跟上|自发|都在刷|统一|整齐)/;

/** Signals that a line crossed a line: used only to mark presence, never stored. */
const ETHICS_RE =
  /(地狱笑话|地狱梗|开香槟|好似|死了活该|歧视|种族|地域黑|黑鬼|尼哥|残废|娘炮|死肥宅|智障|废物东西)/;

/** Game names -> in-group meaning. A hit on title or comments fills gameWords. */
export const GAME_LEXICON = [
  ['三角洲行动', 'extraction shooter, usually shortened to "Delta"'],
  ['三角洲', 'Delta Force, an extraction shooter'],
  ['原神', 'HoYoverse open-world game; "Genshin, start!" is self-mockery'],
  ['王者荣耀', 'MOBA mobile game, usually "Honor of Kings"'],
  ['无畏契约', 'Valorant, the CN name; usually shortened to "Va"'],
  ['瓦罗兰特', 'the global name of Valorant'],
  ['和平精英', 'PUBG Mobile CN'],
  ['绝区零', 'HoYoverse action game, usually "ZZZ"'],
  ['星穹铁道', 'HoYoverse turn-based game, usually "Star Rail"'],
  ['崩坏', 'the Honkai series, usually "Honkai"'],
  ['永劫无间', 'Naraka: Bladepoint, wuxia battle royale'],
  ['英雄联盟', 'League of Legends, usually "LOL"'],
  ['我的世界', 'Minecraft, usually "MC"'],
  ['蛋仔派对', 'Eggy Party, casual competitive mobile'],
  ['第五人格', 'Identity V, asymmetric 1v4 mobile'],
];

export function normalizePhrase(s) {
  return String(s || '')
    .replace(/[\s，,。.!！?？~～、:：;；"'“”‘’()（）[\]【】]/g, '')
    .trim();
}

export function textPool(item) {
  const out = [];
  for (const comment of item.comments || []) {
    out.push(String(comment.text || ''));
    for (const reply of comment.replies || []) out.push(String(reply || ''));
  }
  for (const d of item.danmaku || []) out.push(String(d.text || ''));
  return out
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

/** Split one line into the fragments a person would read as separate phrases. */
export function phraseFragments(text) {
  return String(text || '')
    .split(/[，,。.!！?？~～、;；:：\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Pure statistics: repeat = meme / tic; caring line = love; game name = game word. */
export function heuristicBatch(item) {
  const pool = textPool(item);
  const all = [item.title || '', item.desc || ''].concat(pool).join('\n');
  const counter = new Map();
  const bump = (raw) => {
    const norm = normalizePhrase(raw);
    // A meme has to be short enough to be dropped into another sentence. Counting
    // whole 14-character comments as "repeated" is how a full sentence ends up
    // looking like slang, so this cap is deliberately tighter than elsewhere.
    if (norm.length < 2 || norm.length > 8) return;
    if (/^[0-9]+$/.test(norm)) return;
    if (/^(哈+|啊+|嗯+|哦+)$/.test(norm)) return;
    counter.set(norm, (counter.get(norm) || 0) + 1);
  };
  for (const raw of pool) {
    // Count every candidate once per line: the line itself, plus the phrases
    // inside it ("赌狗赌狗，梭哈是一种智慧" is two sayings). Counting the line
    // and its single fragment separately would make every comment "repeat".
    const candidates = new Set([normalizePhrase(raw), ...phraseFragments(raw).map(normalizePhrase)]);
    for (const candidate of candidates) bump(candidate);
  }
  const repeated = [...counter.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]);

  const batch = emptyBatch('(local statistics, no model read the whole document)');
  batch.memes = repeated.slice(0, MAX.memes).map(([term, n]) => ({
    term,
    meaning: 'a line the comment section repeats',
    usage: n >= 4 ? 'safe to answer with directly' : 'use it when the mood matches',
    example: pool.find((p) => normalizePhrase(p) === term) || term,
  }));
  // Abbreviations get their own pass (kskbl / xswl and friends).
  const abbrev = new Map();
  for (const raw of pool) {
    for (const m of String(raw).matchAll(/\b[a-zA-Z]{2,8}\b/g)) {
      const word = m[0].toLowerCase();
      if (/^(bv|av|up|http|www|com|hh|hhh|2333)$/.test(word)) continue;
      abbrev.set(word, (abbrev.get(word) || 0) + 1);
    }
  }
  for (const [word, n] of [...abbrev.entries()]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1])) {
    if (batch.memes.some((m) => m.term.toLowerCase() === word)) continue;
    batch.memes.push({
      term: word,
      meaning: 'an abbreviation the comment section uses',
      usage: 'wait until the other side uses it first',
      example: word,
    });
    if (batch.memes.length >= MAX.memes) break;
  }

  // Common words: frequent short phrases that did not make the meme cut.
  batch.commonWords = repeated
    .slice(MAX.memes, MAX.memes + MAX.commonWords)
    .map(([term]) => ({
      term,
      meaning: 'high-frequency comment-section phrasing',
      usage: 'pick it up, do not force it',
      example: term,
    }));

  for (const [name, meaning] of GAME_LEXICON) {
    if (!all.includes(name)) continue;
    batch.gameWords.push({ term: name, meaning, usage: 'only when games come up', example: name });
    if (batch.gameWords.length >= MAX.gameWords) break;
  }

  const flooded = repeated.find(([, n]) => n >= 3);
  if (flooded) {
    batch.emergence.push({
      title: 'the comment section spams the same line',
      note: 'nobody organised it, everyone fires the same line at the same beat',
      example: flooded[0],
    });
  }
  const crowd = pool.find((p) => EMERGE_RE.test(p) && p.length <= 40);
  if (crowd && batch.emergence.length < MAX.emergence) {
    batch.emergence.push({
      title: 'the comment section self-organises',
      note: 'one person starts, others follow, a game grows on its own',
      example: crowd,
    });
  }

  const ethicsHit = pool.find((p) => ETHICS_RE.test(p));
  if (ethicsHit) {
    batch.ethics.push({
      title: 'a joke that crosses a line (hell joke / discrimination)',
      note: 'joking about disaster, illness or identity is a second injury',
      usage: 'do not play along, do not laugh; go cold or say it is not funny',
    });
  }

  const seen = new Set();
  for (const p of pool) {
    if (!LOVE_RE.test(p)) continue;
    const key = normalizePhrase(p);
    if (seen.has(key) || p.length > 40) continue;
    seen.add(key);
    batch.love.push({ title: 'how this comment section cares', note: 'short, concrete, unpretentious', example: p });
    if (batch.love.length >= MAX.love) break;
  }

  return batch;
}

/** Merge batches from multiple chunks / videos, one entry per term. */
export function mergeBatches(batches) {
  const out = emptyBatch('');
  const seen = {};
  for (const key of GROUPS) seen[key] = new Set();
  for (const batch of batches) {
    if (!batch) continue;
    if (!out.summary && batch.summary) out.summary = batch.summary;
    for (const group of GROUPS) {
      for (const item of batch[group] || []) {
        const key = String(item.term || item.title || '').toLowerCase();
        if (!key || seen[group].has(key)) continue;
        seen[group].add(key);
        out[group].push(item);
      }
    }
  }
  return out;
}

export function batchCounts(batch) {
  const counts = {};
  for (const key of GROUPS) counts[key] = (batch[key] || []).length;
  return counts;
}

/**
 * Learn one video (whole document, read in batches).
 * @param {object} item crawled video material.
 * @param {{complete?:Function, logger?:object}} opts `complete` is a
 *   `{system, user, maxTokens}` -> Promise<string> model call, if available.
 * @returns {Promise<{batch:object, method:'llm'|'heuristic', chunks:number, error?:string}>}
 */
export async function learnOne(item, { complete, logger } = {}) {
  const usable = typeof complete === 'function';
  if (usable) {
    const chunks = composeChunks(item);
    const batches = [];
    let firstError = '';
    for (const chunk of chunks) {
      try {
        const text = await complete({ system: SYSTEM, user: chunk, maxTokens: 3000 });
        if (!text) {
          // Some reasoning models spend the entire completion budget thinking and
          // return finish_reason "length" with empty content. That is a provider
          // limitation, not an empty comment section -- say so instead of
          // silently recording "learned nothing".
          firstError = 'the model returned no text (it may have spent the whole token budget on reasoning)';
          logger?.warn?.('[dsh-fish] ' + firstError);
          continue;
        }
        const parsed = parseLooseJson(text);
        if (!parsed) {
          logger?.warn?.('[dsh-fish] model reply was not valid JSON; skipping this batch: ' + clip(text, 60));
          continue;
        }
        batches.push(sanitizeBatch(parsed));
      } catch (error) {
        firstError = String(error?.message || error);
        logger?.warn?.('[dsh-fish] batch ' + (batches.length + 1) + ' extraction failed: ' + firstError);
      }
    }
    if (batches.length) {
      const merged = mergeBatches(batches);
      if (GROUPS.some((g) => merged[g].length)) {
        return { batch: merged, method: 'llm', chunks: chunks.length };
      }
      logger?.warn?.('[dsh-fish] the model extracted nothing: ' + clip(item.title, 30));
    }
    if (firstError) {
      return { batch: heuristicBatch(item), method: 'heuristic', chunks: chunks.length, error: firstError };
    }
  }
  return { batch: heuristicBatch(item), method: 'heuristic', chunks: 1 };
}

/* --------------------------------- coinage -------------------------------- */

/**
 * Coinage prompt: hand the model the learned memes *and* the learned techniques
 * so it coins something usable instead of free-associating four-character words.
 */
export function buildCoinPrompt(keyword, knowledge, { count = 5 } = {}) {
  const memes = (knowledge.memes || [])
    .slice()
    .sort((a, b) => (b.weight || 1) - (a.weight || 1))
    .slice(0, 24)
    .map((m) => `${m.term} (${m.meaning || ''})`)
    .join(', ');
  const methods = (knowledge.coinage || [])
    .slice()
    .sort((a, b) => (b.weight || 1) - (a.weight || 1))
    .slice(0, 8)
    .map((c) => `${c.title}: ${c.note || ''}`)
    .join('; ');
  const kw = clip(keyword, 20);
  const system = `You coin Chinese internet slang for a chat assistant. Given one keyword, use the memes and coinage techniques below to coin ${count} sayings that could actually be used in a conversation.

Learned memes: ${memes || '(nothing learned yet; rely on homophones and splicing)'}
Coinage techniques: ${methods || 'homophone substitution, old-meme splicing, abbreviation, reversal, deliberate typo'}

Requirements:
- Every entry must be understandable and answerable. No invented four-character words.
- Prefer homophones and "old meme + keyword" splices. Do not pad.
- No sex, no jokes about disaster/illness/identity, no discrimination.
- Output JSON only: {"items":[{"term":"new saying (<=10 chars)","meaning":"what it means","how":"which technique, e.g. homophone: Genshin -> Genshen"}]}`;
  return { system, user: `keyword: ${kw}` };
}

export function parseCoin(text) {
  const parsed = parseLooseJson(text);
  const list = Array.isArray(parsed?.items) ? parsed.items : [];
  return list
    .map((item) => ({
      term: clip(item?.term, 20),
      meaning: clip(item?.meaning, 60),
      how: clip(item?.how, 60),
    }))
    .filter((item) => item.term)
    .slice(0, 8);
}
