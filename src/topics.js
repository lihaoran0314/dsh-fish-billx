/**
 * Topic extraction: find "what is being talked about right now" from real
 * messages, to use as a Bilibili search term.
 *
 * The rule that matters: a search term must come from what the user actually
 * said. Guessing "no topic" is always better than searching a stand-in word --
 * a corpus that keeps searching one fixed word only learns about itself.
 *
 * Two tiers:
 *   pick()  -- if a model is available, let it read the messages and name one
 *              concrete topic (best quality, one call)
 *   fallback-- without a model, slice locally on stop characters and take the
 *              most repeated fragment
 */

/** Characters that cut a fragment or disqualify it entirely. */
const STOP_CHARS = new Set(
  (
    '的了是我你他她它们在有着过很太还又再要会能可把被给让从到对跟与及或但而如果因为所以然后而且不过就是还是这样那样这个那个什么怎么为什么可以一个一下一点一些时候现在今天明天昨天感觉好像真的没有我们你们他们自己已经知道觉得应该可能需要喜欢东西事情问题有点一直不是不会不要他们她们它们咱们咋啥呢吗啊吧呀哦嗯哈呗嘛啦咯喔诶嘿喂哎唉嗯哪' +
    '叫只吃玩买喝睡走去说看听做想拿放站坐来发给问帮找用练打写读唱跳跑拍画学教改换装穿脱洗煮炒烤蒸个条张次遍顿碗杯件种场位岁块元毛加配拌弄搞整真超巨贼挺蛮'
  ).split(''),
);

const STOP_WORDS = new Set(
  '今天 明天 昨天 现在 刚才 刚刚 时候 一个 一下 一点 一些 什么 怎么 为什么 可以 这个 那个 这样 那样 我们 你们 他们 自己 已经 知道 觉得 应该 可能 需要 喜欢 东西 事情 问题 有点 一直 不是 不会 不要 就是 还是 但是 因为 所以 然后 而且 不过 如果 好像 真的 没有 感觉 其实 反正 确实 随便 处理 情况 内容 视频 表情 图片 群友 主人 早上 中午 下午 晚上 半夜 周末 今年 去年 明年 上班 上学 下班 吃饭 睡觉 起床 出门 回家 意思 时间 地方 大家 朋友 老板 老师 同学 办法 方面 关系 结果 开始 结束'.split(
    ' ',
  ),
);

/** Names that must never become a search term (configured by the user). */
export function selfWords(config) {
  const extra = Array.isArray(config?.selfWords) ? config.selfWords : [];
  return [
    ...new Set(
      extra
        .map((s) => String(s || '').trim().toLowerCase())
        .filter((s) => s.length >= 1),
    ),
  ];
}

/** Strip links, mentions, bracketed placeholders, emoji and stray punctuation. */
export function clean(text) {
  return String(text || '')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/[@＠]\S+/g, ' ')
    .replace(/\[[^\]]{1,8}\]/g, ' ')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, ' ')
    .replace(/[，。！？、,.!?;；:："'“”‘’（）()【】[\]…—\-~～]+/g, ' ')
    .trim()
    .slice(0, 200);
}

/**
 * Fragments starting or ending with these are cross-word noise: without a
 * Chinese dictionary, "青岛上" / "微信聊" / "版新角色" are the main source of
 * garbage search terms.
 */
const BAD_TAIL = new Set('上下聊说看玩做想新老版本门些点次种样般么着过得很'.split(''));
const BAD_HEAD = new Set('版本个些点次种样般么'.split(''));

function isStopFragment(s) {
  if (STOP_WORDS.has(s)) return true;
  if (STOP_CHARS.has(s[0]) || STOP_CHARS.has(s[s.length - 1])) return true;
  if (BAD_HEAD.has(s[0]) || BAD_TAIL.has(s[s.length - 1])) return true;
  if (/^\d+$/.test(s)) return true;
  if (/(.)\1{2,}/.test(s)) return true;
  return false;
}

/**
 * Pure function: rank candidate topic words from messages.
 * @param {string[]} texts
 * @param {{selfWords?:string[], limit?:number, minLen?:number, maxLen?:number}} opts
 * @returns {{word:string, count:number, score:number}[]}
 */
export function extract(texts, opts = {}) {
  const self = (opts.selfWords || []).map((s) => String(s).toLowerCase());
  const limit = Number(opts.limit) || 8;
  const minLen = Math.max(2, Number(opts.minLen) || 2);
  const maxLen = Math.min(12, Number(opts.maxLen) || 6);
  const counts = new Map();
  const order = new Map();
  let seq = 0;

  for (const raw of Array.isArray(texts) ? texts : []) {
    const text = clean(raw);
    if (!text) continue;
    seq += 1;
    for (const chunk of text.split(/[^\u4e00-\u9fa5A-Za-z0-9]+/)) {
      if (!chunk) continue;
      if (/^[A-Za-z0-9]+$/.test(chunk)) {
        if (chunk.length >= 2 && chunk.length <= 12 && !/(.)\1{2,}/.test(chunk)) {
          const key = chunk.toLowerCase();
          counts.set(key, (counts.get(key) || 0) + 1);
          if (!order.has(key)) order.set(key, seq);
        }
        continue;
      }
      // Chinese: slice on stop characters. No n-grams -- too noisy to search.
      let buf = '';
      const push = (frag) => {
        const s = frag.trim();
        if (s.length < minLen || s.length > maxLen) return;
        if (isStopFragment(s)) return;
        if (self.some((w) => w && (s.includes(w) || w.includes(s)))) return;
        counts.set(s, (counts.get(s) || 0) + 1);
        if (!order.has(s)) order.set(s, seq);
      };
      for (const ch of chunk) {
        if (STOP_CHARS.has(ch)) {
          if (buf) push(buf);
          buf = '';
        } else {
          buf += ch;
        }
      }
      if (buf) push(buf);
    }
  }

  const out = [];
  for (const [word, count] of counts) {
    // Longer reads more like a proper noun; slightly later appearances count more.
    const lenBonus = word.length >= 3 ? 1.4 : 1;
    const recentBonus = 1 + Math.min(0.3, (order.get(word) || 0) * 0.02);
    out.push({ word, count, score: count * lenBonus * recentBonus });
  }
  out.sort((a, b) => b.score - a.score || b.word.length - a.word.length);
  return out.slice(0, limit);
}

export const TOPIC_SYSTEM = `You are reading recent chat messages and must pick one "searchable topic" for a friend.
Requirements:
1. Output exactly one word or short phrase, max 8 characters, no punctuation, no explanation, no quotes.
2. It must be a concrete thing that actually appears in the conversation (a game, a food, a place, a person, a task being done, the thing being argued about).
3. No generic words (chatting, everyone, today, funny, interesting...) and no nicknames of the people talking.
4. If you genuinely cannot tell, output a single hyphen -.`;

/**
 * Local fallback choice: prefer repeated mentions, then 3-5 char words that
 * look like proper nouns, and otherwise return '' -- empty means the caller
 * should skip this run rather than search a sliced-up fragment.
 */
export function localChoice(ranked) {
  if (!Array.isArray(ranked) || !ranked.length) return '';
  const strong = ranked.filter((entry) => entry.count >= 2);
  if (strong.length) return strong[0].word;
  const decent = ranked.filter((entry) => entry.word.length >= 3 && entry.word.length <= 5);
  return decent.length ? decent[0].word : '';
}

/**
 * Pick one topic: model first, local statistics second.
 * @returns {Promise<{topic:string, source:'llm'|'local'|'none', candidates:string[], reason?:string}>}
 */
export async function pick({ complete, config, texts = [], minTexts = 3 } = {}) {
  const lines = Array.isArray(texts) ? texts : [];
  const ranked = extract(lines, { selfWords: selfWords(config) });
  const candidates = ranked.map((x) => x.word);
  if (lines.length < minTexts) {
    return { topic: '', source: 'none', candidates, reason: 'not enough recent messages to guess a topic' };
  }

  if (typeof complete === 'function') {
    try {
      const raw = await complete({
        system: TOPIC_SYSTEM,
        user: lines.slice(-24).join('\n').slice(0, 1500),
        maxTokens: 40,
      });
      const word = String(raw || '')
        .replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '')
        .trim()
        .slice(0, 10);
      const self = selfWords(config);
      const bad =
        !word || word === '-' || STOP_WORDS.has(word) || self.some((w) => word.includes(w) || w.includes(word));
      if (!bad) return { topic: word, source: 'llm', candidates };
      const local = localChoice(ranked);
      return { topic: local, source: local ? 'local' : 'none', candidates };
    } catch {
      /* model failed; fall through to local */
    }
  }
  const local = localChoice(ranked);
  return { topic: local, source: local ? 'local' : 'none', candidates };
}

export { STOP_CHARS, STOP_WORDS };
