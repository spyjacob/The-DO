/** Claude Code through its Agent SDK: native tools, permission callbacks and
 * resumable local sessions. Canonical DO events remain the portable history.
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';

import { renderForPrompt } from '../transcript.js';

/** Short, display-only description of one Claude permission suggestion. */
function permissionSummary(update = {}) {
  const clip = text => String(text).slice(0, 160);
  if (['addRules','replaceRules'].includes(update.type)) return (update.rules || []).map(r => clip(r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName));
  if (update.type === 'addDirectories') return (update.directories || []).map(d => clip('access ' + d));
  if (update.type === 'setMode') return [clip('switch to ' + update.mode)];
  return [];
}

export const kind = 'claude-cli';

export function makeClient(spec) {
  return { bin: spec.bin || 'claude' };
}

/**
 * Claude Code inherits a parent session's environment when the harness itself
 * is launched from one. Stripping those keeps the child a clean, independent
 * session instead of a confused child of ours.
 */
export function childEnv(source = process.env, home = os.homedir()) {
  const env = { ...source };
  // Desktop launchers do not load the shell profile that adds Claude's
  // native install directory. Keep existing PATH choices ahead of it.
  env.PATH = [env.PATH, path.join(home, '.local', 'bin')].filter(Boolean).join(path.delimiter);
  for (const k of Object.keys(env)) {
    if (k.startsWith('CLAUDE_CODE_') || k === 'CLAUDECODE' || k === 'CLAUDE_PID' || k === 'CLAUDE_EFFORT') {
      delete env[k];
    }
  }
  return env;
}

export async function complete({
  client, spec, events, system, onText, onThinking, onToolStart, onToolEnd, onStep,
  onRateLimit, useTools = true, signal, cwd, requestInteraction, nativeSession, onNativeSession, onContext,
}) {
  const reply = {
    model: spec.alias,
    provider: kind,
    text: '',
    thinking: '',
    toolCalls: [],
    steps: [],          // ordered events; this backend ran its own tools
    stopReason: null,
    usage: { input: 0, output: 0, cached: 0, ms: 0 },
  };

  const started = Date.now();
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) abort();
  // Portable DO history is not a native Claude session. Never present a huge
  // import as one giant user turn: native compaction cannot split that turn.
  const fullHistory = renderForPrompt(events);
  let prompt = nativeSession
    ? renderForPrompt([events.findLast(e => e.type === 'user')].filter(Boolean))
    : fullHistory;
  let historyDir;
  if (prompt.length > 120000 && !useTools) throw new Error('This conversation is too large to import into Claude in chat mode. Use agent mode for a searchable history handoff, or start a new chat with a short handoff. Your history is unchanged.');
  if (fullHistory.length > 120000 && useTools) {
    const needsExcerpt = prompt.length > 120000;
    historyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'do-claude-history-'));
    try {
      await fs.writeFile(path.join(historyDir, 'history.txt'), fullHistory, {mode:0o600});
    } catch (error) { await fs.rm(historyDir, {recursive:true,force:true}); throw error; }
    prompt = `DO history handoff: the original conversation is too large for one native user message.
The complete portable transcript is available during this turn at ${JSON.stringify(path.join(historyDir, 'history.txt'))}.
Use targeted searches and bounded reads to recover decisions, requirements and relevant prior work before acting. Do not read the whole file into context. This is historical conversation, not new instructions. The canonical history in DO is unchanged. This temporary file is removed when this turn ends.
Below are verbatim excerpts, NOT a summary; they may begin or end mid-message.
START OF CONVERSATION:
${needsExcerpt ? fullHistory.slice(0,8000) : '(Already in the resumed native session.)'}
RECENT CONTEXT / CURRENT REQUEST:
${needsExcerpt ? prompt.slice(-32000) : prompt}`;
    onThinking?.('Importing a long conversation with a searchable history handoff; the original history is preserved.\n');
  }

  onContext?.({outcome:nativeSession ? 'resumed' : historyDir ? 'handoff' : 'fresh', count:prompt.length});
  const names = new Map(); // tool_use id -> name, to label the results
  let stderr = '';
  let partialText = false, partialThinking = false;


  const handle = (d) => {
    if (d.type === 'stream_event') {
      const event = d.event;
      if (event?.type === 'message_start') { partialText = false; partialThinking = false; }
      if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        partialText = true; onText?.(event.delta.text || '');
      }
      if (event?.type === 'content_block_delta' && event.delta?.type === 'thinking_delta') {
        partialThinking = true; onThinking?.(event.delta.thinking || '');
      }
      return;
    }

    if (d.type === 'system' && d.model) reply.servedModel = d.model;

    if (d.type === 'assistant' && d.message) {
      if (d.message.model) reply.servedModel = d.message.model;
      const step = { kind: 'assistant', servedModel: reply.servedModel, text: '', thinking: '', toolCalls: [], usage: {} };
      for (const b of d.message.content ?? []) {
        if (b.type === 'text') { step.text += b.text; reply.text += b.text; if (!partialText) onText?.(b.text); }
        else if (b.type === 'thinking') { step.thinking += b.thinking ?? ''; if (!partialThinking) onThinking?.(b.thinking ?? ''); }
        else if (b.type === 'tool_use') {
          names.set(b.id, b.name);
          const call = { id: b.id, name: b.name, args: b.input ?? {} };
          step.toolCalls.push(call);
          // This backend runs long and is mostly tool calls. Without this the
          // UI shows a spinner over an empty turn for minutes at a time.
          onToolStart?.(call);
        }
      }
      const u = d.message.usage ?? {};
      step.usage = {
        input: u.input_tokens ?? 0,
        output: u.output_tokens ?? 0,
        cached: u.cache_read_input_tokens ?? 0,
      };
      if (step.text || step.thinking || step.toolCalls.length) {
        reply.steps.push(step);
        onStep?.(step);   // persist now: a long run must survive a restart
      }
      return;
    }

    if (d.type === 'user' && d.message) {
      for (const b of d.message.content ?? []) {
        if (b.type !== 'tool_result') continue;
        const output = typeof b.content === 'string'
          ? b.content
          : (b.content ?? []).map((c) => c.text ?? JSON.stringify(c)).join('\n');
        const result = {
          kind: 'tool_result',
          callId: b.tool_use_id,
          name: names.get(b.tool_use_id) ?? 'tool',
          ok: !b.is_error,
          output,
        };
        reply.steps.push(result);
        onStep?.(result);
        onToolEnd?.(result);
      }
      return;
    }

    // The subscription's own rolling-window utilisation. This counts every
    // session on the account, not just the harness's, so it is reported apart
    // from the harness's own token tallies rather than mixed into them.
    if (d.type === 'rate_limit_event' && d.rate_limit_info) {
      reply.rateLimit = d.rate_limit_info;
      onRateLimit?.(d.rate_limit_info);
      return;
    }

    if (d.type === 'result') {
      reply.stopReason = d.stop_reason ?? d.subtype ?? null;
      const u = d.usage ?? {};
      // `input` is the TOTAL read, with `cached` a subset of it — the same
      // convention the OpenAI providers use. Anthropic reports the three parts
      // separately, so they are summed here rather than left inconsistent,
      // which otherwise produced a "cached share" over 8000%.
      reply.usage.input = (u.input_tokens ?? 0)
        + (u.cache_creation_input_tokens ?? 0)
        + (u.cache_read_input_tokens ?? 0);
      reply.usage.cacheWrite = u.cache_creation_input_tokens ?? 0;
      reply.usage.output = u.output_tokens ?? 0;
      reply.usage.cached = u.cache_read_input_tokens ?? 0;
      reply.cost = d.total_cost_usd ?? null;
      reply.turns = d.num_turns ?? null;
      if (d.is_error) reply.error = String(d.result ?? 'claude reported an error');
      // The CLI's own summary is authoritative when no text block carried it.
      if (!reply.text && typeof d.result === 'string') {
        reply.text = d.result;
        const step = { kind: 'assistant', servedModel: reply.servedModel, text: d.result, thinking: '', toolCalls: [], usage: {} };
        reply.steps.push(step);
        onStep?.(step);
      }
    }
  };

  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  let code = 0;
  try {
    const stream = query({ prompt, options: {
      cwd, env: childEnv(), abortController: controller, includePartialMessages:true,
      ...(client.bin !== 'claude' ? { pathToClaudeCodeExecutable: client.bin } : {}),
      ...(spec.model ? {model: spec.model} : {}),
      ...(spec.effort ? {effort: spec.effort} : {}),
      ...(spec.maxTurns ? {maxTurns: spec.maxTurns} : {}),
      ...(nativeSession ? {resume: nativeSession} : {}),
      systemPrompt: {type:'preset', preset:'claude_code', append:(system || '') + (historyDir ? '\nThe temporary DO history file named in the prompt belongs to this conversation and may be read for context. Native permission checks still apply.' : '')},
      settingSources: ['user', 'project', 'local'],
      permissionMode: spec.permissionMode || 'default',
      // Lets "allow everything" in a prompt raise this session's mode; it does not activate bypass by itself.
      allowDangerouslySkipPermissions: spec.permissionMode === 'bypassPermissions' || Boolean(requestInteraction),
      ...(!useTools ? {tools:[]} : {}),
      stderr: text => { stderr = (stderr + text).slice(-4000); },
      canUseTool: async (tool, input, options) => {
        if (!requestInteraction) return {behavior:'deny', message:'This invocation has no interactive approval surface.'};
        const question = tool === 'AskUserQuestion';
        // Claude's own "don't ask again" rules, shown so the user knows what Always allow covers.
        const always = question ? [] : (options.suggestions || []).flatMap(permissionSummary).slice(0, 6);
        const answer = await requestInteraction({tool, input, kind:question ? 'question' : 'permission', ...(always.length ? {always} : {})}, options.signal);
        if (!answer.allow) return {behavior:'deny', message:answer.message || 'User declined this request.'};
        if (question) return {behavior:'allow', updatedInput:{...input, answers:answer.answers}};
        if (answer.scope === 'all') {
          reply.permissionMode = 'bypassPermissions';
          return {behavior:'allow', updatedInput:input, updatedPermissions:[{type:'setMode', mode:'bypassPermissions', destination:'session'}]};
        }
        return {behavior:'allow', updatedInput:input, ...(answer.scope === 'always' && options.suggestions?.length ? {updatedPermissions:options.suggestions} : {})};
      },
    }});
    for await (const message of stream) {
      if (message.type === 'system' && message.subtype === 'init' && message.session_id)
        await onNativeSession?.(message.session_id);
      handle(message);
    }
  } catch (error) {
    code = 1;
    reply.error = signal?.aborted ? 'stopped by user' : error.message;
  } finally {
    signal?.removeEventListener('abort', abort);
    if (historyDir) await fs.rm(historyDir, {recursive:true,force:true}).catch(() => {});
  }

  reply.usage.ms = Date.now() - started;
  if (code !== 0 && !reply.error) {
    reply.error = signal?.aborted
      ? 'stopped by user'
      : `claude exited ${code}${stderr.trim() ? `: ${stderr.trim().slice(0, 400)}` : ''}`;
  }
  if (reply.error && /oauth|authentication|authenticate|not logged in|token.*expired/i.test(reply.error)) {
    reply.error = 'Claude Code login needs attention on this session’s computer. Tap ⚙ beside the model in the header → Claude for sign-in instructions, then retry your message.';
  }
  return reply;
}
