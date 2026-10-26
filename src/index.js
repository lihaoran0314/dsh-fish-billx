/**
 * dsh-fish-billx -- a Bilibili corpus learner as a DeepSeek Harness plugin.
 *
 * What it does in one pass:
 *   1. crawl  -- search Bilibili for a topic and keep each video's whole
 *                material: title, description, tags, top comments (with
 *                replies) and danmaku;
 *   2. learn  -- read that material as one document and distill it into seven
 *                kinds of knowledge (memes, coinage, emergence, ethics,
 *                commonWords, gameWords, love), with a human-readable log;
 *   3. coin   -- invent new sayings from the learned memes and techniques;
 *   4. use    -- inject the relevant subset into the system prompt for the
 *                current turn, gated by what the user is talking about.
 *
 * Host contract: the plugin needs `tools` (to register its tools) and
 * `systemPrompt` (to inject the learned block). Model access is optional --
 * without it the learner falls back to local statistics and refuses to coin,
 * rather than pretending it did either.
 *
 * No `@deepseek-ai/*` imports on purpose: the host owns those instances, and
 * taking a second copy through a peer import is how plugins end up with a
 * model message that the harness refuses to accept. Message shapes and the
 * stream-block reading below are handled structurally instead.
 */

import path from 'node:path';
import { createEngine } from './engine.js';
import * as store from './store.js';

export const name = 'dsh-fish-billx';
export const inject = ['tools', 'systemPrompt'];

const DEFAULT_DATA_SUBDIR = path.join('dsh-fish-billx', 'corpus');

/**
 * Where the corpus lives. A configured `dataDir` wins; otherwise the harness
 * home (`$DSH_HOME`, then `~/.dsh`) keeps the store out of the user's workspace
 * and stable across projects. Resolved locally rather than through a host
 * service so a missing service cannot break plugin load.
 */
export function resolveDataDir(config, env = process.env) {
  if (config?.dataDir) return path.resolve(config.dataDir);
  const configured = String(env.DSH_HOME || '').trim();
  if (configured) return path.join(path.resolve(configured), DEFAULT_DATA_SUBDIR);
  const home = env.USERPROFILE || env.HOME;
  if (home) return path.join(home, '.dsh', DEFAULT_DATA_SUBDIR);
  return path.join(process.cwd(), '.dsh-fish-billx', 'corpus');
}

/** Fresh identifiers for plugin-authored model messages. */
let messageSeq = 0;
function newMessageId() {
  messageSeq += 1;
  return `dsh-fish-billx-${Date.now().toString(36)}-${messageSeq}`;
}

/**
 * Read the text out of an assembled stream. Works off the block shapes the
 * blocks carry, so it does not need the host's BlockAssembler class.
 */
export function assembleText(chunks) {
  const partials = new Map();
  const order = [];
  const ensure = (index, type) => {
    let partial = partials.get(index);
    if (!partial) {
      partial = { type, text: '' };
      partials.set(index, partial);
      order.push(index);
    }
    return partial;
  };
  for (const chunk of chunks) {
    if (!chunk || typeof chunk !== 'object') continue;
    if (chunk.type === 'block-start') {
      ensure(chunk.index, chunk.blockType);
    } else if (chunk.type === 'text-delta') {
      if (typeof chunk.text === 'string') ensure(chunk.index, 'text').text += chunk.text;
    } else if (chunk.type === 'block-end' && chunk.block?.type === 'text') {
      const partial = ensure(chunk.index, 'text');
      if (!partial.final) {
        partial.text = chunk.block.text ?? partial.text;
        partial.final = true;
      }
    }
  }
  return order
    .map((index) => partials.get(index))
    .filter((partial) => partial.type === 'text' && partial.text)
    .map((partial) => partial.text)
    .join('')
    .trim();
}

/**
 * Wrap `ctx.llm` into the engine's `complete({system, user, maxTokens})` shape.
 * Returns undefined when the host has no usable model, so callers can tell
 * "no model" apart from "model failed".
 */
export function createCompletion(ctx, route = {}) {
  const llm = ctx?.llm;
  if (!llm || typeof llm.prepareCall !== 'function') return undefined;
  return async function complete({ system, user, maxTokens = 700, signal } = {}) {
    const call = await llm.prepareCall({ ...route, maxTokens }, signal);
    const messages = [
      Object.freeze({
        id: newMessageId(),
        role: 'user',
        content: Object.freeze([Object.freeze({ type: 'text', text: String(user ?? '') })]),
        source: Object.freeze({ kind: 'dsh-fish-billx' }),
      }),
    ];
    const chunks = [];
    for await (const chunk of call.stream({ ...call.config, messages, system, signal })) {
      chunks.push(chunk);
    }
    return assembleText(chunks);
  };
}

/* -------------------------------- tool surface ------------------------------- */

const groupEnum = [...store.GROUP_KEYS];

/** A free-form string parameter. `type` is required: annotation-only nodes are rejected. */
const textParam = (description) => ({ type: 'string', description });

/**
 * Tool output schema. The harness validates result schemas too, so this must be
 * an explicit object root with `additionalProperties: true` -- an empty `{}` is
 * rejected at registration time.
 */
const OBJECT_OUTPUT = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
};

/** The tool surface: raw registry-ready definitions, delegating into the engine. */
export function createTools(engine, getComplete) {
  return [
    {
      name: 'fish_learn',
      description:
        "Crawl Bilibili for a topic and learn from it. Keeps each video's title, description, tags, top comments with replies and danmaku, then distills the whole document into seven kinds of knowledge: memes, coinage techniques, emergence, boundaries, common words, game vocabulary and ways of caring. Stores everything in the local corpus and appends a human-readable learning log. Without a keyword it takes the topic from `texts` (recent messages) or from configured keywords, and skips the run when no topic can be found.",
      parameters: {
          keyword: { type: 'string', description: 'What to search for. Omit to derive it from `texts`, then from configured keywords.' },
          texts: { type: 'array', description: 'Recent messages used to infer the topic when no keyword is given.', items: { type: 'string' } },
          videos: { type: 'integer', description: 'How many videos to crawl this run.' },
          comments: { type: 'integer', description: 'How many top comments to keep per video.' },
          danmaku: { type: 'integer', description: 'How many danmaku lines to keep per video; 0 disables them.' },
          limit: { type: 'integer', description: 'How many videos to learn this run.' },
          fromRaw: { type: 'boolean', description: 'Only learn what is already stored locally; do not crawl.' },
          useLlm: { type: 'boolean', description: 'Use the model for whole-document extraction (default true). false runs local statistics only.' },
        },
      output: OBJECT_OUTPUT,
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        const complete = await getComplete(exec);
        const result = await engine.learn({
          keyword: args.keyword,
          texts: args.texts,
          videos: args.videos,
          comments: args.comments,
          danmaku: args.danmaku,
          limit: args.limit,
          fromRaw: args.fromRaw,
          useLlm: args.useLlm !== false,
          complete,
        });
        if (!result.ok) throw new Error(result.error || 'dsh-fish-billx: the run produced nothing');
        return result;
      },
      presentCall: (args) => ({
        card: 'generic',
        title: 'Learn Bilibili corpus' + (args.keyword ? `: ${args.keyword}` : ''),
        kind: 'other',
        rawInput: args,
      }),
    },

    {
      name: 'fish_crawl',
      description:
        'Crawl Bilibili material for a topic without learning it yet. Stores each video\'s title, description, tags, top comments with replies and danmaku in the local corpus so a later fish_learn can read it. Same topic resolution as fish_learn.',
      parameters: {
          keyword: textParam('What to search for.'),
          texts: { type: 'array', description: 'Recent messages used to infer the topic.', items: { type: 'string' } },
          videos: textParam('How many videos to crawl.'),
          comments: textParam('Comments per video.'),
          danmaku: textParam('Danmaku per video; 0 disables them.'),
      },
      output: OBJECT_OUTPUT,
      isConcurrencySafe: () => false,
      async execute(args) {
        const result = await engine.crawl({
          keyword: args.keyword,
          texts: args.texts,
          videos: args.videos,
          comments: args.comments,
          danmaku: args.danmaku,
        });
        if (!result.ok) throw new Error(result.error || 'dsh-fish-billx: the crawl produced nothing');
        return result;
      },
    },

    {
      name: 'fish_state',
      description:
        'Report what the corpus currently holds: per-group counts, the top entries of every group, the most recent runs, the running job if one is in flight, and where the files live.',
      parameters: {},
      output: OBJECT_OUTPUT,
      isConcurrencySafe: () => true,
      execute() {
        return engine.state();
      },
    },

    {
      name: 'fish_knowledge',
      description:
        'Read the learned knowledge itself, optionally narrowed to one group, so it can be inspected, quoted or cleaned up. Groups: memes, coinage, emergence, ethics, commonWords, gameWords, love.',
      parameters: {
        group: { type: 'string', enum: groupEnum, description: 'Only return this group. Omit to return all of them.' },
        limit: { type: 'integer', description: 'Maximum entries per group (default 50).' },
      },
      output: OBJECT_OUTPUT,
      isConcurrencySafe: () => true,
      execute(args) {
        const knowledge = store.loadKnowledge(engine.dir);
        const limit = Math.max(1, Math.min(400, Number(args.limit) || 50));
        const groups = args.group ? [args.group] : store.GROUP_KEYS;
        const picked = {};
        for (const group of groups) {
          picked[group] = (knowledge[group] || [])
            .slice()
            .sort((a, b) => (b.weight || 1) - (a.weight || 1))
            .slice(0, limit);
        }
        return { updatedAt: knowledge.updatedAt, stats: knowledge.stats, groups: picked, labels: store.LABEL };
      },
    },

    {
      name: 'fish_coin',
      description:
        'Coin new sayings for a keyword out of the learned memes and coinage techniques. Returns candidates only; nothing enters the corpus until it is kept with fish_remember.',
      parameters: {
          keyword: { type: 'string', description: 'The topic to coin for.', required: true },
          count: { type: 'integer', description: 'How many candidates to ask for (default 5).' },
        },
      output: OBJECT_OUTPUT,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const complete = await getComplete(exec);
        return engine.coin({ keyword: args.keyword, count: args.count, complete });
      },
    },

    {
      name: 'fish_remember',
      description:
        'Keep one entry in the corpus by hand: a coined saying, a correction, or a term learned elsewhere. The entry joins the chosen group and its weight starts at one.',
      parameters: {
          group: { type: 'string', enum: groupEnum, description: 'Which group to keep it in (default memes).' },
          term: { type: 'string', description: 'The term or title to keep.', required: true },
          meaning: textParam('What it means.'),
          usage: textParam('How and when to use it.'),
          note: textParam('A note, for the idea-style groups.'),
          example: textParam('A real example fragment, if there is one.'),
        },
      output: OBJECT_OUTPUT,
      isConcurrencySafe: () => false,
      execute(args) {
        const { group, term, meaning, usage, note, example } = args;
        return engine.remember({ group, item: { term, title: term, meaning, usage, note, example } });
      },
    },

    {
      name: 'fish_forget',
      description: 'Remove one learned entry that is off-target, duplicated or wrong.',
      parameters: {
          group: { type: 'string', enum: groupEnum, description: 'Which group the entry is in (default memes).' },
          term: { type: 'string', description: 'The exact term or title to remove.', required: true },
        },
      output: OBJECT_OUTPUT,
      isConcurrencySafe: () => false,
      execute(args) {
        return engine.forget({ group: args.group, term: args.term });
      },
    },

    {
      name: 'fish_preview',
      description:
        'Show exactly which entries would be injected into the prompt for a given message, which gates fired (game / ethics / meme), and the resulting block. Worth running before trusting the injection.',
      parameters: { text: textParam('The message to preview against.') },
      output: OBJECT_OUTPUT,
      isConcurrencySafe: () => true,
      execute(args) {
        return engine.previewPrompt(args.text || '');
      },
    },

    {
      name: 'fish_log',
      description:
        'Return the human-readable corpus learning log (newest last), or clear part of the corpus.',
      parameters: {
          action: {
            type: 'string',
            enum: ['read', 'reset-knowledge', 'reset-raw', 'reset-log', 'reset-all'],
            description: 'read (default) returns the log; reset-* clears that part of the corpus.',
          },
          chars: { type: 'integer', description: 'How many trailing characters of the log to return (default 20000).' },
      },
      output: OBJECT_OUTPUT,
      isConcurrencySafe: () => true,
      execute(args) {
        const action = args.action || 'read';
        if (action === 'read') return engine.learnLog({ tailChars: Number(args.chars) || 20000 });
        const what = action.replace('reset-', '');
        return engine.reset(what === 'all' ? 'all' : what);
      },
    },
  ];
}

/* ------------------------------ prompt injection ----------------------------- */

/**
 * The latest user message of this assembly, so the injected block can be gated
 * on what is actually being discussed. Falls back to '' when unavailable.
 */
export function latestUserText(agent) {
  try {
    const messages = agent?.session?.deriveMessages?.() ?? [];
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (message?.role !== 'user') continue;
      const text = (message.content || [])
        .filter((block) => block?.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('\n')
        .trim();
      if (text) return text;
    }
  } catch {
    /* an unreadable surface just means "no gate input" */
  }
  return '';
}

/**
 * Mount the plugin: register the tools, then append the learned block to the
 * system prompt of every turn that has something to inject.
 */
export async function apply(ctx, config = {}) {
  const resolved = { ...config };
  resolved.dataDir = resolveDataDir(resolved);
  const engine = createEngine({ dataDir: resolved.dataDir, config: resolved, logger: ctx.logger });

  const getComplete = async () => createCompletion(ctx);

  for (const definition of createTools(engine, getComplete)) {
    const dispose = ctx.tools.register(definition);
    if (typeof dispose === 'function') ctx.effect?.(() => dispose);
  }

  if (resolved.enabled !== false && resolved.promptEnabled !== false) {
    ctx.on('system-prompt/assemble', async (assembly, context, next) => {
      const resolvedAssembly = await next();
      const agent = context?.agent;
      if (!agent) return resolvedAssembly;
      try {
        const text = latestUserText(agent);
        if (!text) return resolvedAssembly;
        const block = engine.promptBlock(text);
        if (!block) return resolvedAssembly;
        return {
          ...resolvedAssembly,
          sections: [
            ...resolvedAssembly.sections,
            { name: 'dsh-fish-billx:corpus', text: block, interpolate: false },
          ],
        };
      } catch {
        // Injection is best-effort: a corpus read failure must never fail a turn.
        return resolvedAssembly;
      }
    });
  }

  ctx.logger?.info?.(`[dsh-fish-billx] mounted, corpus at ${resolved.dataDir}`);
  return { engine };
}
