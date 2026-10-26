/**
 * Bilibili crawler: search -> video detail -> top comments (with replies) -> danmaku.
 *
 * Node built-ins only, no dependencies. Four scars, all already paid for:
 *   1. The server may answer gzip / deflate, and for danmaku it sends *raw*
 *      deflate -- `zlib.createInflate` throws and the whole block is lost.
 *      So we decode by content-encoding and fall back across all variants.
 *   2. Search-result titles carry <em class="keyword"> highlight tags -- stripTags.
 *   3. The old /x/v2/reply only returns 3 comments now; 20 needs
 *      /x/v2/reply/wbi/main plus a `w_rid` signature (md5 of sorted query +
 *      mixinKey, mixinKey derived from the nav endpoint's img/sub keys).
 *   4. `ps` has an upper bound (30 -> -400 ps out of bounds), and firing
 *      detail/tags/comments/danmaku concurrently earns -352. Everything is
 *      serial with a small gap.
 */

import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { URL } from 'node:url';

const API = 'https://api.bilibili.com';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One HTTP GET, always resolved with a decoded string body. Transport
 * failures reject so the caller can decide whether they are worth a retry.
 */
export function request(url, { timeoutMs = 15000, cookie = '' } = {}) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(url);
    } catch (error) {
      reject(error);
      return;
    }
    const mod = target.protocol === 'http:' ? http : https;
    const req = mod.get(
      target,
      {
        headers: {
          'User-Agent': UA,
          Referer: 'https://www.bilibili.com/',
          Origin: 'https://www.bilibili.com',
          Accept: 'application/json, text/plain, */*',
          'Accept-Language': 'zh-CN,zh;q=0.9',
          ...(cookie ? { Cookie: cookie } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: decodeBody(Buffer.concat(chunks), res.headers['content-encoding']),
          });
        });
        res.on('error', reject);
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

/**
 * Manual decompression. The danmaku endpoint sends bare deflate regardless of
 * what you ask for, so try raw, then zlib-wrapped, then the bytes as-is.
 */
export function decodeBody(buf, encoding) {
  const enc = String(encoding || '').toLowerCase();
  const tryOne = (fn) => {
    try {
      return fn(buf).toString('utf8');
    } catch {
      return null;
    }
  };
  if (enc.includes('br')) return tryOne(zlib.brotliDecompressSync) ?? buf.toString('utf8');
  if (enc.includes('gzip')) {
    return tryOne(zlib.gunzipSync) ?? tryOne(zlib.inflateSync) ?? buf.toString('utf8');
  }
  if (enc.includes('deflate')) {
    return tryOne(zlib.inflateRawSync) ?? tryOne(zlib.inflateSync) ?? buf.toString('utf8');
  }
  return buf.toString('utf8');
}

/** Strip highlight tags and the handful of entities search titles actually use. */
export function stripTags(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

/**
 * Fetch JSON. Bilibili signals business errors in the body with HTTP 200, so
 * the code field is what matters. Risk-control codes (-412 / -352) are retried;
 * anything else is fatal and bubbles up immediately.
 */
export async function getJson(pathOrUrl, { cookie = '', timeoutMs = 15000, retries = 2 } = {}) {
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : API + pathOrUrl;
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const res = await request(url, { timeoutMs, cookie });
      if (res.status >= 500 || res.status === 412) throw new Error(`HTTP ${res.status}`);
      const json = JSON.parse(res.body);
      if (json && typeof json.code === 'number' && json.code !== 0) {
        const error = new Error(
          `bilibili code=${json.code}${json.message ? ' ' + json.message : ''}`,
        );
        error.code = json.code;
        if (json.code !== -412 && json.code !== -352) {
          error.fatal = true;
          throw error;
        }
        throw error;
      }
      return json;
    } catch (error) {
      lastError = error;
      if (error && error.fatal) break;
      if (attempt < retries) await sleep(600 + attempt * 900);
    }
  }
  throw lastError || new Error('request failed');
}

/** Video search (no wbi signature needed; a risk-control error propagates). */
export async function searchVideos(keyword, { limit = 8, cookie = '' } = {}) {
  const kw = String(keyword || '').trim();
  if (!kw) return [];
  const data = await getJson(
    `/x/web-interface/search/type?search_type=video&page=1&keyword=${encodeURIComponent(kw)}`,
    { cookie },
  );
  const list = Array.isArray(data?.data?.result) ? data.data.result : [];
  return list
    .filter((v) => v && v.bvid && v.title)
    .slice(0, Math.max(1, limit))
    .map((v) => ({
      bvid: v.bvid,
      title: stripTags(v.title).replace(/\s+/g, ' '),
      desc: stripTags(v.description || v.desc || '').slice(0, 300),
      owner: stripTags(v.author || ''),
      play: Number(v.play) || 0,
      danmakuCount: Number(v.video_review) || 0,
      duration: String(v.duration || ''),
      pubdate: Number(v.pubdate) || 0,
    }));
}

/** Popular fallback: filter the hot list by the keyword's own words. */
export async function hotFallback(keyword, { limit = 4, cookie = '' } = {}) {
  const data = await getJson('/x/web-interface/popular?ps=50&pn=1', { cookie });
  const list = Array.isArray(data?.data?.list) ? data.data.list : [];
  const words = String(keyword || '')
    .split(/[\s,，、]+/)
    .filter((word) => word.length >= 2);
  const hit = list.filter((video) => {
    const text = stripTags(video.title || '') + ' ' + stripTags(video.desc || '');
    return words.some((word) => text.includes(word));
  });
  return hit.slice(0, limit).map((video) => ({
    bvid: video.bvid,
    title: stripTags(video.title || ''),
    desc: stripTags(video.desc || '').slice(0, 300),
    owner: video.owner?.name || '',
    play: Number(video.stat?.view) || 0,
    danmakuCount: Number(video.stat?.danmaku) || 0,
    duration: String(video.duration || ''),
    pubdate: Number(video.pubdate) || 0,
  }));
}

function unescapeXml(s) {
  return String(s || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Danmaku. The XML carries `<d p="time,mode,...">text</d>`; repeats are
 * counted, because the more often a line is fired the more it behaves like a
 * meme rather than an aside.
 */
export async function fetchDanmaku(cid, { limit = 60, cookie = '' } = {}) {
  if (!cid) return [];
  try {
    const res = await request(`${API}/x/v1/dm/list.so?oid=${encodeURIComponent(cid)}`, { cookie });
    const xml = res.body || '';
    if (!xml.includes('<d ')) return [];
    const counter = new Map();
    const re = /<d\s+p="[^"]*">([\s\S]*?)<\/d>/g;
    let match;
    while ((match = re.exec(xml))) {
      const text = unescapeXml(match[1]).replace(/\s+/g, ' ').trim();
      if (!text || text.length > 40) continue;
      counter.set(text, (counter.get(text) || 0) + 1);
    }
    return [...counter.entries()]
      .map(([text, count]) => ({ text, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, Math.max(1, limit));
  } catch {
    return [];
  }
}

/* ------------------------- wbi signing (comments need it) ------------------------- */

/**
 * The mixin table is fixed by Bilibili: it permutes (imgKey + subKey) into the
 * 32-character signing key.
 */
const MIXIN_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28,
  14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54,
  21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

let wbiCache = { at: 0, keys: null };

export function mixinKeyOf(orig) {
  return MIXIN_TAB.map((i) => orig[i]).join('').slice(0, 32);
}

export async function getWbiKeys({ cookie = '', timeoutMs = 12000 } = {}) {
  if (wbiCache.keys && Date.now() - wbiCache.at < 30 * 60 * 1000) return wbiCache.keys;
  const res = await request(`${API}/x/web-interface/nav`, { timeoutMs, cookie });
  const json = JSON.parse(res.body);
  const img = json?.data?.wbi_img;
  if (!img?.img_url || !img?.sub_url) {
    throw new Error('no wbi key (nav endpoint returned no wbi_img)');
  }
  const imgKey = img.img_url.split('/').pop().split('.')[0];
  const subKey = img.sub_url.split('/').pop().split('.')[0];
  const keys = { imgKey, subKey, mixin: mixinKeyOf(imgKey + subKey) };
  wbiCache = { at: Date.now(), keys };
  return keys;
}

/** Sort the params, append `wts`, and sign with md5(query + mixinKey). */
export function signWbi(params, mixin, now = Date.now()) {
  const wts = Math.floor(now / 1000);
  const all = { ...params, wts };
  const query = Object.keys(all)
    .sort()
    .map((key) => {
      const value = String(all[key]).replace(/[!'()*]/g, '');
      return encodeURIComponent(key) + '=' + encodeURIComponent(value);
    })
    .join('&');
  const w_rid = crypto.createHash('md5').update(query + mixin).digest('hex');
  return query + '&w_rid=' + w_rid;
}

function toComment(reply) {
  const text = String(reply?.content?.message || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return null;
  const subs = (Array.isArray(reply.replies) ? reply.replies : [])
    .map((sub) =>
      String(sub?.content?.message || '')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter(Boolean)
    .slice(0, 3);
  return {
    text,
    like: Number(reply.like) || 0,
    rcount: Number(reply.rcount) || 0,
    replies: subs,
    uname: reply.member?.uname || '',
  };
}

/** New comment endpoint (signed), 20 per page, up to three pages. */
export async function fetchCommentsWbi(aid, { limit = 40, cookie = '' } = {}) {
  const keys = await getWbiKeys({ cookie });
  const out = [];
  const seen = new Set();
  let offset = '';
  const pages = Math.max(1, Math.min(3, Math.ceil(limit / 20)));
  for (let page = 0; page < pages; page += 1) {
    const query = signWbi(
      {
        oid: aid,
        type: 1,
        mode: 3,
        pagination_str: JSON.stringify({ offset }),
        plat: 1,
        seek_rpid: '',
        web_location: 1315875,
      },
      keys.mixin,
    );
    const res = await request(`${API}/x/v2/reply/wbi/main?${query}`, { cookie });
    const json = JSON.parse(res.body);
    if (!json || json.code !== 0) throw new Error('comment endpoint code=' + (json && json.code));
    const list = Array.isArray(json?.data?.replies) ? json.data.replies : [];
    if (!list.length) break;
    for (const reply of list) {
      const comment = toComment(reply);
      if (!comment || seen.has(reply.rpid)) continue;
      seen.add(reply.rpid);
      out.push(comment);
    }
    const next = json?.data?.cursor?.pagination_reply?.next_offset;
    if (!next || out.length >= limit) break;
    offset = next;
    await sleep(260);
  }
  return out.slice(0, limit);
}

/** Legacy endpoint: only 3 hot comments now, but better than nothing. */
export async function fetchCommentsLegacy(aid, { limit = 20, cookie = '' } = {}) {
  const data = await getJson(
    `/x/v2/reply?type=1&oid=${encodeURIComponent(aid)}&sort=2&ps=20&pn=1`,
    { cookie },
  );
  const replies = Array.isArray(data?.data?.replies) ? data.data.replies : [];
  return replies.map(toComment).filter(Boolean).slice(0, limit);
}

/** Comments: signed endpoint first, legacy as fallback, empty on double failure. */
export async function fetchComments(aid, opts = {}) {
  if (!aid) return [];
  try {
    const list = await fetchCommentsWbi(aid, opts);
    if (list.length) return list;
  } catch {
    /* fall through to the legacy endpoint */
  }
  try {
    return await fetchCommentsLegacy(aid, opts);
  } catch {
    return [];
  }
}

export async function fetchTags(bvid, { cookie = '' } = {}) {
  try {
    const data = await getJson(`/x/tag/archive/tags?bvid=${encodeURIComponent(bvid)}`, { cookie });
    const list = Array.isArray(data?.data) ? data.data : [];
    return list
      .map((tag) => String(tag.tag_name || '').trim())
      .filter(Boolean)
      .slice(0, 20);
  } catch {
    return [];
  }
}

/** Video detail: title / description / uploader / stats / partition. */
export async function videoDetail(bvid, { cookie = '' } = {}) {
  const data = await getJson(`/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`, { cookie });
  const d = data?.data || null;
  if (!d) throw new Error('no video detail for ' + bvid);
  return {
    bvid: d.bvid,
    aid: d.aid,
    cid: d.cid,
    title: stripTags(d.title || ''),
    desc: stripTags(d.desc || '').slice(0, 600),
    owner: d.owner?.name || '',
    play: Number(d.stat?.view || 0),
    danmakuCount: Number(d.stat?.danmaku || 0),
    reply: Number(d.stat?.reply || 0),
    like: Number(d.stat?.like || 0),
    pubdate: Number(d.pubdate) || 0,
    duration: Number(d.duration) || 0,
    tname: d.tname || '',
    pages: Number(d.videos) || 1,
  };
}

/**
 * One complete video: detail + tags + comments + danmaku.
 * Every sub-step degrades to empty on its own, so a video with comments
 * disabled still contributes its title and tags.
 */
export async function fetchVideo(bvid, { comments = 40, danmaku = 60, cookie = '' } = {}) {
  const detail = await videoDetail(bvid, { cookie });
  const tags = await fetchTags(bvid, { cookie });
  await sleep(180);
  const cmts = await fetchComments(detail.aid, { limit: comments, cookie });
  await sleep(180);
  const dms = danmaku > 0 ? await fetchDanmaku(detail.cid, { limit: danmaku, cookie }) : [];
  return { ...detail, tags, comments: cmts, danmaku: dms, fetchedAt: new Date().toISOString() };
}

/**
 * Crawl a batch of videos for one keyword.
 * @param {string} keyword search term.
 * @param {{videos?:number, comments?:number, danmaku?:number, cookie?:string,
 *          logger?:object, onProgress?:Function, signal?:AbortSignal}} opts
 */
export async function crawlKeyword(
  keyword,
  { videos = 4, comments = 40, danmaku = 60, cookie = '', logger, onProgress, signal } = {},
) {
  const log = (message) => logger?.info?.('[dsh-fish] ' + message);
  let list = [];
  try {
    list = await searchVideos(keyword, { limit: videos, cookie });
    log(`search "${keyword}" returned ${list.length} videos`);
  } catch (error) {
    log(`search "${keyword}" failed: ${error.message}; falling back to popular`);
  }
  if (!list.length) {
    try {
      list = await hotFallback(keyword, { limit: videos, cookie });
      log(`popular fallback matched ${list.length}`);
    } catch (error) {
      log('popular fallback also failed: ' + error.message);
    }
  }
  const out = [];
  for (let i = 0; i < list.length; i += 1) {
    signal?.throwIfAborted();
    const video = list[i];
    try {
      const full = await fetchVideo(video.bvid, { comments, danmaku, cookie });
      out.push(full);
      onProgress?.({ phase: 'crawl', done: i + 1, total: list.length, title: full.title });
      log(`got ${full.title} (${full.comments.length} comments, ${full.danmaku.length} danmaku)`);
    } catch (error) {
      log(`skip ${video.bvid}: ${error.message}`);
      onProgress?.({
        phase: 'crawl',
        done: i + 1,
        total: list.length,
        title: video.title,
        error: error.message,
      });
    }
    if (i < list.length - 1) await sleep(400);
  }
  return out;
}
