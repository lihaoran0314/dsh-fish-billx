/**
 * Turn learned knowledge into a prompt fragment for the current turn.
 *
 * The seven groups are not dumped in wholesale. They are selected by what the
 * user is actually talking about:
 *   - memes: ones that appear in the user's message first, then by weight
 *     (at most 4, and only 2 when nothing matches -- otherwise every casual
 *     reply drags in game-specific slang and the tone drifts)
 *   - commonWords: always on, but only 3 (more than that becomes mimicry)
 *   - gameWords: only when the message is about games
 *   - ethics: only when the message touches a minefield; carrying it all the
 *     time just reminds the model to think about those things
 *   - coinage: 1~2, teaching *how* to coin rather than handing over lines
 *   - emergence / love: 1~2 each
 *   - total hard budget (default 900 chars), trimmed from the last group
 */

import fs from 'node:fs';
import { fileFor, loadKnowledge } from './store.js';

const cache = { key: '', data: null };

/** Game talk gates game lexicons. */
export const GAME_HINT =
  /(三角洲|原神|王者|瓦罗兰特|无畏契约|和平精英|绝区零|星穹铁道|星铁|崩坏|永劫|英雄联盟|LOL|lol|CS2|CSGO|我的世界|蛋仔|第五人格|游戏|开黑|上分|抽卡|爆率|复刻|深渊|副本|排位|匹配|打野|辅助|ADC|版本|新角色|池子)/;

/** Touching these injects the ethics group. */
export const ETHICS_HINT =
  /(地狱笑话|地狱梗|开香槟|好似|活该|死了|自杀|抑郁|歧视|种族|黑人|尼哥|地域|乡下|农村|残障|残疾|娘炮|死肥宅|胖子|丑|学历|大专|保安|外卖|性别|女拳|男凝)/;

/** Meme talk unlocks more coinage techniques. */
export const MEME_HINT = /(梗|典|急了|破防|绷不住|笑死|草|乐子|难绷|抽象|阴阳|阴阳怪气|怎么造|来点新词)/;

/** Knowledge with a one-file mtime cache; the prompt path is hot. */
export function knowledge(dir) {
  const file = fileFor(dir, 'knowledge.json');
  try {
    const st = fs.statSync(file);
    const key = file + '|' + st.mtimeMs;
    if (cache.key === key && cache.data) return cache.data;
    const data = loadKnowledge(dir);
    cache.key = key;
    cache.data = data;
    return data;
  } catch {
    return loadKnowledge(dir);
  }
}

export function enabled(config) {
  const c = config || {};
  if (c.enabled === false) return false;
  if (c.promptEnabled === false) return false;
  return true;
}

export function byWeight(list) {
  return (list || []).slice().sort((a, b) => (b.weight || 1) - (a.weight || 1));
}

/**
 * Memes: terms present in the user's message win; if none matched, fall back
 * to only `memeFallback` high-weight ones so ordinary small talk stays clean.
 */
export function pickMemes(dir, config, text, limit) {
  const all = byWeight(knowledge(dir).memes);
  if (!all.length) return [];
  const t = String(text || '');
  const hit = [];
  const rest = [];
  for (const meme of all) {
    const term = String(meme.term || '');
    if (term && t.includes(term)) hit.push(meme);
    else rest.push(meme);
  }
  const fallback = Number(config?.memeFallback || 2);
  if (hit.length) return hit.slice(0, Math.max(1, limit));
  return rest.slice(0, Math.max(1, Math.min(limit, fallback)));
}

function wordLine(item) {
  const parts = [item.term];
  if (item.meaning) parts.push(item.meaning);
  if (item.usage) parts.push('usage: ' + item.usage);
  return '- ' + parts.join(' | ');
}

function ideaLine(item) {
  return '- ' + [item.title, item.note].filter(Boolean).join(': ');
}

/**
 * Build the injectable block for one message.
 * @param {string} dir corpus directory.
 * @param {object} config plugin config (promptBudget, memeFallback, gates).
 * @param {string} text the user's latest message.
 * @param {object} opts per-group count overrides.
 * @returns {string} the fragment, or '' when there is nothing to teach.
 */
export function buildBlock(dir, config, text, opts = {}) {
  if (!enabled(config)) return '';
  const k = knowledge(dir);
  const t = String(text || '');
  const budget = Number(opts.budget) || Number(config?.promptBudget) || 900;
  const gameOn = GAME_HINT.test(t);
  const ethicsOn = ETHICS_HINT.test(t);
  const memeOn = MEME_HINT.test(t);
  const sections = [];

  const memes = pickMemes(dir, config, t, opts.memes == null ? 4 : Number(opts.memes));
  if (memes.length) {
    sections.push([
      '【Meme vocabulary learned from comment sections】These are slang you already know and use. Do not treat them as new words, do not ask what they mean. Use them naturally, at most one per sentence; do not explain a term and do not admit not knowing it.',
      ...memes.map(wordLine),
    ]);
  }

  const coinage = byWeight(k.coinage).slice(
    0,
    opts.coinage == null ? (memeOn ? 2 : 1) : Number(opts.coinage),
  );
  if (coinage.length) {
    sections.push([
      '【Coinage techniques learned】(follow these when you need to invent a word; never explain which technique you used)',
      ...coinage.map(ideaLine),
    ]);
  }

  const commonWords = byWeight(k.commonWords).slice(
    0,
    opts.commonWords == null ? 3 : Number(opts.commonWords),
  );
  if (commonWords.length) {
    sections.push([
      '【Words this crowd uses】(bring them out naturally, one per sentence at most, do not stack them into a tic)',
      ...commonWords.map(wordLine),
    ]);
  }

  const gameWords = gameOn
    ? byWeight(k.gameWords).slice(0, opts.gameWords == null ? 4 : Number(opts.gameWords))
    : [];
  if (gameWords.length) {
    sections.push([
      '【Game vocabulary】(the user is talking about games; use the right meaning, do not pretend to know, do not hand out guides)',
      ...gameWords.map(wordLine),
    ]);
  }

  const emergence = byWeight(k.emergence).slice(0, opts.emergence == null ? 2 : Number(opts.emergence));
  if (emergence.length) {
    sections.push([
      '【Collective behaviour seen in comment sections】(understanding how a crowd grows a game is enough; do not quote this literally and do not use it as a script)',
      ...emergence.map(ideaLine),
    ]);
  }

  const ethics = ethicsOn ? byWeight(k.ethics).slice(0, opts.ethics == null ? 2 : Number(opts.ethics)) : [];
  if (ethics.length) {
    sections.push([
      '【Boundaries: this message may be touching these. Do not play along, do not laugh, do not repeat any of the words in them】',
      ...ethics.map(
        (e) => '- ' + [e.title, e.note, e.usage ? 'what to do: ' + e.usage : ''].filter(Boolean).join(' | '),
      ),
    ]);
  }

  const love = byWeight(k.love).slice(0, opts.love == null ? 2 : Number(opts.love));
  if (love.length) {
    sections.push([
      '【Ways of caring that were learned】(say it in your own words, do not copy the original line, do not use them all at once)',
      ...love.map(ideaLine),
    ]);
  }

  // Over budget: trim from the last section backwards, keeping headers and leads.
  while (sections.length && sections.map((s) => s.join('\n')).join('\n').length > budget) {
    const last = sections[sections.length - 1];
    if (last.length > 2) last.pop();
    else sections.pop();
  }
  const out = sections.map((section) => section.join('\n')).join('\n');
  if (!out.trim()) return '';
  return out.slice(0, budget + 120);
}

/** Preview for a debug/inspection tool: what was picked, and why some groups were not. */
export function preview(dir, config, text = '') {
  const k = knowledge(dir);
  const t = String(text || '');
  const gameOn = GAME_HINT.test(t);
  const ethicsOn = ETHICS_HINT.test(t);
  const memeOn = MEME_HINT.test(t);
  return {
    enabled: enabled(config),
    block: buildBlock(dir, config, t),
    gated: { game: gameOn, ethics: ethicsOn, meme: memeOn },
    picked: {
      memes: pickMemes(dir, config, t, 4),
      coinage: byWeight(k.coinage).slice(0, memeOn ? 2 : 1),
      commonWords: byWeight(k.commonWords).slice(0, 3),
      gameWords: gameOn ? byWeight(k.gameWords).slice(0, 4) : [],
      emergence: byWeight(k.emergence).slice(0, 2),
      ethics: ethicsOn ? byWeight(k.ethics).slice(0, 2) : [],
      love: byWeight(k.love).slice(0, 2),
    },
    updatedAt: k.updatedAt || '',
  };
}
