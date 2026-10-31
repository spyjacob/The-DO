import { validateEffort } from './model-effort.js';
/**
 * The agent loop: send the transcript, run whatever tools come back, repeat
 * until the model stops asking for tools.
 *
 * The loop is provider-agnostic. It reads `session.model` fresh on every step,
 * so a model swapped in the middle of a session takes effect on the next step
 * with the whole history intact.
 */

import crypto from 'node:crypto';
import { toBase64, toDataUrl } from './attachments.js';
import { clientFor, providerFor } from './providers/index.js';
import { runTool } from './tools.js';
import { assistantEvent, noteEvent, toolResultEvent, userEvent } from './transcript.js';


/**
 * Run a tool, but never wait on it forever.
 *
 * Some calls block in ways nothing here can cancel - a macOS consent dialog for
 * ~/Documents blocks readdir until somebody clicks it, and if the laptop lid is
 * shut nobody can. Without this the whole turn wedges and Stop does nothing,
 * because the loop only checks the abort signal between tools.
 *
 * The underlying operation cannot truly be cancelled; what changes is that the
 * harness stops waiting on it, reports why, and stays responsive.
 */
async function boundedTool(call, ctx, { signal, ms }) {
  let timer;
  let onAbort;
  const controller = new AbortController();
  const cancellation = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  try {
    return await Promise.race([
      runTool(call, {...ctx, signal:cancellation}),
      new Promise((resolve) => {
        timer = setTimeout(
          () => { controller.abort(); resolve({ ok: false, output: `timed out after ${Math.round(ms / 1000)}s — the tool did not return. If it touched ~/Documents, ~/Downloads or ~/Desktop, macOS may be waiting on a permission dialog. Cancellation was requested; external effects may already have occurred.` }); },
          ms,
        );
      }),
      new Promise((resolve) => {
        if (signal?.aborted) return resolve({ ok: false, output: 'stopped by user' });
        onAbort = () => resolve({ ok: false, output: 'stopped by user' });
        signal?.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
  }
}

const BASE_SYSTEM = `You are a capable assistant working with the user. You have tools to list, read, write and edit files, and to run shell commands in a project directory. You are not limited to coding: answer whatever the user actually asks.

Answering:
- If you can answer from your own knowledge, just answer, in your message. Do not run a command to produce an answer, and never use the shell to speak to the user - echo is not how you reply.
- Reach for a tool when the task genuinely needs the machine: reading or changing files, running builds or tests, inspecting the system.
- After a tool runs, say what it means in your own words. The user usually has tool output collapsed, so a tool call with no explanation reads as no answer at all.
- If the request is a plain question, a plain answer is the whole job. Do not invent project work around it.

Working on the project:
- The project directory is the working directory for every tool call. Use paths relative to it.
- Look before you leap: list_dir and read_file before editing something you have not seen.
- Prefer edit_file over write_file when changing part of an existing file.
- After making changes, verify them - run the tests, the build, or the program itself.
- If a command fails, read the error and fix it rather than reporting the failure back verbatim.

Serving an app the user can open from their phone:
- For generated documents and other downloadable files, link the absolute file path in Markdown so Harness serves it through its existing file preview and download controls. Do not start a temporary web server just to deliver a file. A localhost link only works on the hosting laptop, never on the phone.
- The harness itself runs on port 8787 and owns its Tailscale hostname on ports 80, 443 and 8787. Never take those over, never point a tailscale serve rule at them, and never bind 8787. The user needs the harness reachable at all times, including while your app is running.
- Give your app its own port and its own Tailscale entry, choosing a port nothing else is using. For example, to expose a server on port 4320:
    tailscale serve --bg --https=8443 http://127.0.0.1:4320
  Use the installed Tailscale client. Respect explicit ORCHESTRATOR_TAILSCALE_BIN and ORCHESTRATOR_TAILSCALE_SOCKET overrides; never assume a custom daemon. The orchestrator’s own phone route is managed through Settings → Phone access.
- Tell the user BOTH addresses once it is up, and say which is which:
    phone / away from home:  https://TAILNET_HOST:8443
    the laptop itself:       http://127.0.0.1:4320
  Both are needed. Loopback works on the host even when a custom userspace Tailscale daemon cannot resolve its own tailnet hostname.
- Leave the app running in the background so it stays reachable after your turn ends.
- Do not narrate routine tool calls blow by blow, but always finish with the outcome.
- Follow the user’s intent: perform authorized work, answer questions directly, or ask for missing information when needed. State what changed and how it was verified when you made changes. A clarification question is a valid turn outcome; never invent a completion summary or claim unfinished work is done.`;

const MONITORING = `Monitoring (the user watches this from their phone):
- If you start long-running or background work, redirect its output to a log file so it can be followed.
- The user can watch anything you register in their monitors file. To add one, read that JSON file (an array), append an object, and write it back. To stop watching something, remove its entry.
- Each entry is: { "id": "short-slug", "label": "Human name", "kind": ..., "refresh": 3000 } plus one field for the kind:
  - "kind":"command" with "command": any shell one-liner; its output is shown. Use this when nothing else fits - it covers containers, launchd, queues, database counts, anything.
  - "kind":"file"    with "path": a log file; its tail is shown.
  - "kind":"process" with "match": a string matched against the process list; shows whether it is running.
  - "kind":"http"    with "url": shows the status and body.
  - "kind":"panel"   with "command": a shell command that PRINTS HTML, which is rendered as the user's interface. This is how you build them a custom view: emit a table, a progress bar, a list, whatever suits what they asked to see. Keep it small and self-contained; inline any styles. The panel renders in a DARK interface, and any text colour you set is overridden so it stays legible - so do not set colours on text at all. For emphasis use class="ok" (green), class="warn" (amber), class="bad" (red) or class="muted" (grey). Backgrounds are left as you set them, so coloured bars, chips and fills work normally.
- Add "session": "<this session's id>" to show a monitor inside this session's own panel rather than in the global list. The session id is in the project context below. Prefer session-scoped monitors for work belonging to this session.
- Register a monitor whenever you start something the user would reasonably want to watch, and whenever they ask to monitor anything. Prefer a command monitor that prints a short, current summary over one that dumps a lot of text.`;

const MONITOR_ROLE = `You control the monitoring view the user is looking at right now. The panel above this chat renders whatever monitors exist for the session you are attached to, and the user is talking to you to change it.

What that means in practice:
- "Is this up to date?" - check the underlying source yourself (read the file, run the command, look at the process) and say whether the panel reflects it. Do not just repeat what the panel says.
- "Refresh this" - re-run the monitor's command and report what changed.
- "Change this" / "show it like that" - edit the monitor's entry in the monitors file. The panel picks the change up on its next refresh.
- "Add a monitor for X" - work out the cheapest way to sample X, then add it.
- Keep panel commands fast; they are re-run every few seconds. Precompute into a file if the work is heavy.
You have the same shell and file tools as any session, so you can inspect anything you need in order to answer.

Taking over the view. The panel shows a built-in default until you replace it. To own the whole surface, write a monitor with "role":"view" (kind "panel", scoped to the watched session) - when one exists it becomes the entire panel and the default is not drawn. Rules for it:
- The raw data behind the default view is one command away, so do not reimplement process discovery:
    ACTIVITY_CMD
  That returns JSON with: running (a turn is in flight), procs (pid, etime, cpu, rssMb, detached, command, cwd, log) and projectDir. Keep the raw=1 flag: without it the request would re-enter the sampler that is running your view and loop forever.
- Your HTML keeps working buttons if you use these attributes: data-log="/path/to/log" gives a tail-and-follow button, data-stop="<pid>" gives a stop button. Reuse them so the user does not lose those controls.
- Print the whole panel every time; it is replaced wholesale on each refresh.
- If the user asks for something the view does not cover, change the view rather than explaining why it cannot be shown.
- To hand the panel back to the default, delete the "role":"view" monitor.`;

const CHAT_SYSTEM = `You are a helpful assistant talking with the user. Answer what they ask, directly and accurately. You have no tools in this conversation, so do not offer to run commands or edit files - if something genuinely needs the machine, say so and suggest they switch this session to agent mode.`;

/** A session in chat mode carries none of the agent scaffolding. */
export const usesTools = (session) => session?.mode !== 'chat';

/**
 * What a harness-editing session needs to work like a careful maintainer rather
 * than guess. A fresh session has none of the context this codebase's usual
 * editor carries, which is why unguided edits come out misplaced and untested.
 */
const HARNESS_GUIDE = [
  "How this harness is built, and how to change it well:",
  "",
  "Layout:",
  "- server/index.js is the HTTP server and all /api routes.",
  "- server/public/index.html, app.js and styles.css are the one UI, used on both phone and desktop. app.js renders every screen; there is no framework and no build step.",
  "- src/core/ is the engine: agent.js (the turn loop and this system prompt), tools.js, providers/, apps.js, git.js, store.js, transcript.js, notify.js.",
  "- test/e2e/ holds a small set of real-server end-to-end workflows, run with: npm test",
  "",
  "Design system (match it exactly, or new UI looks bolted on):",
  "- Dark theme only. Never introduce light backgrounds. Use the existing CSS custom properties (--bg, --bg-2, --bg-3, --fg, --fg-dim, --fg-faint, --line, --accent), never hard-coded colors.",
  "- Reuse existing classes and patterns. A control in the composer copies the existing composer buttons (class attach-btn); a settings control copies the rows already in the settings sheet; a list row uses class item. Put a new control where similar controls already live, at the same size, not wedged in on its own.",
  "- Tap targets are at least 44px. Text stays readable at phone width; nothing may cause horizontal scroll.",
  "",
  "Working discipline:",
  "- For Harness experience or reliability reviews, read authenticated GET /api/diagnostics?action=all on the local Harness origin using the activity command authentication. This combines recent metadata from reachable hosts without replication. Use action=events&host=<host-id>&before=<ISO-time> to page older history; never read the protected data directory. Missing events or an unreachable host are missing evidence, not proof of user behavior.",
  "- Read the neighbouring code before adding to it; match its style, naming and structure.",
  "- Run npm test before you finish and report the result. Extend the relevant E2E workflow for behavior changes; do not add unit or source-inspection tests.",
  "- The running server holds the OLD code until it is restarted, so your file edits are NOT live until the harness restarts. After changing server or UI code, tell the user plainly that a restart is needed (there is a Restart control on the Harness app), and never claim a change works when you could not load it.",
  "- The harness data directory (secrets, tokens, the session store, other projects) is off-limits: reads and writes there are refused. Do not try to read secrets.",
].join('\n');

const PROJECT_TRACING = [
  'Tracing for future AI work — applies to every project:',
  '- When building or changing a program, include diagnostic tracing that lets a future coding assistant reconstruct how the user used it. These logs are for the assistant, not a debug interface the user has to read.',
  '- Trace meaningful user actions and navigation, the screen or state actually shown (including loading, empty, success and error states), and the requests or background jobs those actions triggered. Include timestamps, app version, correlation IDs, relevant host, durations, outcomes and failures. Connect browser actions to server work where applicable; server success alone does not prove the user saw success.',
  '- Use structured, searchable logs with bounded size and retention. Reuse existing logging where possible, keep it lightweight, and ensure logging failures never break the app. Keep logs out of Git. Do not record secrets, credentials, raw private content, keystrokes or screenshots by default; use redacted summaries and identifiers.',
  '- Document where traces live, how to read them within the project permissions, and how to reproduce a flow. When the user describes a problem or asks for a change, inspect the relevant recent traces before guessing. Distinguish recorded events from assumptions about what the user saw or felt; say when evidence is missing.',
  '- Verify tracing with a representative user flow, including an error path, so another assistant can follow action → visible result → underlying cause. Keep the normal interface simple; do not make the user collect or interpret routine debugging logs.',
].join('\n');

export function systemPromptFor(session, monitorsFile, activityCmd, tailnetHost = null, native = false) {
  if (!usesTools(session)) {
    return session.system?.trim() ? `${CHAT_SYSTEM}\n\n${session.system.trim()}` : CHAT_SYSTEM;
  }

  // The machine's own tailnet name is substituted here rather than written
  // into the source: it is this user's infrastructure, not part of the tool.
  const base = BASE_SYSTEM.replace(/TAILNET_HOST/g, tailnetHost ?? '<this machine>.ts.net');
  const parts = [base, ...(native ? ['Use your native tools, planning and clarification behavior. Native permission requests and AskUserQuestion are relayed through DO to the user; use them when needed.'] : []), PROJECT_TRACING, `\nProject directory: ${session.tabWorkspace?.cwd ?? session.tabWorkspace?.dir ?? session.projectDir}`,
    process.platform === 'win32' && !native ? 'Execution host: native Windows. Shell commands use cmd.exe; use Windows paths and commands, or invoke PowerShell explicitly. Do not assume WSL or Unix tools.' : `Execution host: ${process.platform}.`];
  if (session.tabWorkspace) parts.push('This tab has an isolated Git worktree. Work only in the project directory above, even if older messages name a different directory. Do not switch branches, push, or edit the shared checkout or other worktrees. Install dependencies locally when needed. Changes stay in this tab until the user presses Push in the frontend. That operation fetches remote changes, merges, runs integration checks, and publishes. Never push automatically after a turn. If integration reports a conflict, resolve it here in a subsequent turn. Changes are not live until integration succeeds.');
  if (session.appId && session.appId !== '__harness') parts.push(`When this app itself uses AI at runtime, record its dependency via PATCH /api/apps/${session.appId} with aiDependencies: [{host, alias, label, purpose}]. Discover exact host IDs and source aliases via /api/cluster/status and /api/cluster/sources catalog. Preserve existing dependencies when updating. Record only sources actually configured in the app, never the coding assistant merely building it. Do not put credentials in metadata. Implement runtime model selection by reading HARNESS_APP_AI (JSON array of purpose, provider, model, alias, host) provided at app launch. Support only provider adapters actually implemented; reject unsupported replacements with an actionable error. Document AI requirements and how to use personal credentials in README.md. Never claim metadata alone changes a hard-coded integration. Explain if registration is unavailable.`);
  if (monitorsFile) {
    // A monitor companion scopes its monitors to the session it watches, not
    // to itself, or its panels would show up in the wrong place.
    const scope = session.monitorFor ?? session.id;

    if (session.monitorFor) {
      // The companion's whole job is the panel, so it gets the full manual.
      parts.push(`\n${MONITOR_ROLE.replace('ACTIVITY_CMD', activityCmd ?? '(activity command unavailable)')}`);
      parts.push(`\n${MONITORING}\nMonitors file: ${monitorsFile}\nThe session these monitors belong to: ${scope}`);
    } else {
      // An ordinary session only needs to know the facility exists. Spelling
      // out every monitor kind here cost ~580 tokens on every turn of every
      // session, including ones that will never register a monitor.
      parts.push(`\nIf you start long-running work the user should watch, redirect its output to a log file and add an entry to the monitors file at ${monitorsFile} (a JSON array; use {"id","label","kind":"file","path","session":"${scope}"}). Read that file first for the full set of monitor kinds.`);
    }
  }
  if (session.editsHarness) {
    // This is a session of the built-in Harness app: it is meant to edit the
    // harness itself. Do not tell it the harness is read-only — it is not, for
    // this session.
    parts.push('\nYou ARE the harness. This session edits the harness\'s own source code (the project directory is the harness itself), which is exactly your job here — treat requests to change the harness as ordinary work, not something forbidden.');
    parts.push(HARNESS_GUIDE);
  } else {
    parts.push('\nYou run inside a harness. The harness\'s own files are read-only to you: you may look at them, but any attempt to write there is refused, and that is deliberate rather than a fault to work around.');
  }
  if (!native) parts.push('You can email the user with send_email when something needs them and they may not be watching — a long run finished, a decision is needed, or work failed in a way you cannot resolve. Do not email for routine progress.');
  if (session.confineToProjectDir) {
    parts.push(native ? 'This project folder is the default scope. If the user’s task needs additional folders or host actions, request the required native permission; do not claim the task is impossible merely because it needs broader scope.' : 'File tools are confined to this directory; paths outside it are refused.');
    parts.push('This session is its own project. Other work on this machine is not yours to read or reason about, even if you can see it — do not go looking through other directories for context, and do not assume another project\'s files are related to this one. If you need something from elsewhere, ask.');
    if (session.readableDirs?.length) {
      parts.push(`You may also READ from these folders, but not write to them:\n${
        session.readableDirs.map((d) => `- ${d}`).join('\n')}`);
    }
  }
  if (session.system?.trim()) {
    parts.push(`\nProject-specific instructions from the user:\n${session.system.trim()}`);
  }
  return parts.join('\n');
}

/**
 * Run one user turn to completion.
 *
 * @param onEvent  called with each event appended to the transcript (already saved)
 * @param onDelta  called with live streaming updates that are not persisted
 * @param save     persists the session; awaited after every appended event
 */
// Native agents own their stopping and clarification behavior. Never manufacture
// a final answer with a second, tool-free model call.
export async function runTurn(opts) {
  const result = await runTurnInner(opts);
  opts.onOutcome?.(result?.outcome || (opts.signal?.aborted ? 'cancelled' : 'responded'));
  return result;
}

async function runTurnInner({
  session, models, userText, attachments, onEvent, onDelta, save, signal, monitorsFile, activityCmd,
  tailnetHost = null, executionContext = '', machineHelp, localModel, requestInteraction, clientMessageId,
}) {
  const append = async (event) => {
    session.events.push(event);
    await save(session);
    onEvent?.(event);
    return event;
  };

  if (userText?.trim() || attachments?.length) {
    const event = userEvent(userText?.trim() ?? '', attachments ?? []);
    if (clientMessageId) event.clientMessageId = clientMessageId;
    await append(event);
  }

  for (;;) {
    if (signal?.aborted) {
      await append(noteEvent('stopped by user'));
      return;
    }

    const configured = models[session.model];
    if (configured) validateEffort(configured, session.effort);
    const spec = configured && { ...configured, ...(session.claudePermission ? {permissionMode:session.claudePermission} : {}), ...(session.effort ? { effort: session.effort, reasoningEffort: session.effort } : {}) };
    if (!spec) {
      await append(noteEvent(`model "${session.model}" is not in models.json`));
      return {outcome:'error'};
    }

    // Images are stored as files and only turned into base64 for the providers
    // that inline them — the CLI reads the file itself, which is far cheaper.
    let events = session.events;
    if (spec.provider !== 'claude-cli' && events.some((e) => e.attachments?.length)) {
      events = await Promise.all(events.map(async (e) => (
        e.attachments?.length
          ? {
            ...e,
            attachments: await Promise.all(e.attachments.map(async (a) => (
              a.role === 'document'
                ? { ...a, base64: await toBase64(a).catch(() => null) }
                : { ...a, dataUrl: await toDataUrl(a).catch(() => null) }
            ))),
          }
          : e
      )));
    }

    // Resume only an unchanged transcript on the same execution host/folder/model.
    // Editing history or changing providers deliberately starts a fresh native session.
    const fingerprint = entries => crypto.createHash('sha256').update(JSON.stringify(entries.filter(e => ['user','assistant','tool_result'].includes(e.type)).map(e => [e.id,e.text,e.toolCalls,e.output,e.attachments]))).digest('hex');
    const cwd = session.tabWorkspace?.cwd ?? session.tabWorkspace?.dir ?? session.projectDir;
    // Native identity is only reusable when execution semantics agree. Labels
    // and credentials are excluded; model definition and access policy are not.
    const context = crypto.createHash('sha256').update(JSON.stringify({
      model:spec.model, provider:spec.provider, bin:spec.bin, baseUrl:spec.baseUrl,
      system:session.system, executionContext, permission:spec.permissionMode || 'default',
      readableDirs:session.readableDirs || [], confined:session.confineToProjectDir,
      mode:session.mode, extraBody:spec.extraBody,
    })).digest('hex');
    const native = session.nativeClaude;
    const resume = spec.provider === 'claude-cli' && native?.host === session.ownerNode && native?.cwd === cwd && native.model === session.model && native.context === context
      && native.history === fingerprint(session.events.filter(e => ['user','assistant','tool_result'].includes(e.type)).slice(0, -1)) ? native.id : null;
    let nativeId;
    let reply;
    let streamed = 0;
    let stepSaves = Promise.resolve();
    const appendStep = async (st) => {
      streamed += 1;
      if (st.kind === 'tool_result') await append(toolResultEvent(st));
      else await append(assistantEvent({ ...st, model: spec.alias, provider: spec.provider }));
    };

    try {
      const provider = providerFor(spec);
      reply = await provider.complete({
        client: clientFor(spec),
        requestInteraction,
        nativeSession: resume,
        onNativeSession: id => { nativeId = id; },
        spec,
        events,
        system: systemPromptFor(session, monitorsFile, activityCmd, tailnetHost, spec.provider === 'claude-cli') + (executionContext ? `\n\n${executionContext}` : ''),
        onText: (text) => onDelta?.({ kind: 'text', text }),
        onThinking: (text) => onDelta?.({ kind: 'thinking', text }),
        onToolStart: (call) => onDelta?.({ kind: 'tool_start', call }),
        onToolEnd: (result) => onDelta?.({ kind: 'tool_end', result }),
        // Providers stream without awaiting saves. Preserve order and drain all
        // writes before reporting completion; surface a persistence failure.
        onStep: (st) => {
          stepSaves = stepSaves.then(() => appendStep(st));
          stepSaves.catch(() => {}); // awaited before the turn may finish
        },
        onRateLimit: (info) => onDelta?.({ kind: 'rate_limit', info }),
        useTools: usesTools(session),
        longContext: Boolean(session.allowLongContext),
        signal,
        cwd: session.tabWorkspace?.cwd ?? session.tabWorkspace?.dir ?? session.projectDir,
      });
    } catch (e) {
      await stepSaves;
      await append(noteEvent(`${spec.alias}: ${e?.message ?? String(e)}`));
      return {outcome:'error'};
    }

    await stepSaves;
    if (nativeId && !reply.error) {
      session.nativeClaude = {id:nativeId, cwd, host:session.ownerNode, model:session.model, context, history:fingerprint(session.events)};
      await save(session);
    }

    // Some backends are whole agents (the `claude` CLI) and have already run
    // their own tools. They hand back an ordered list of what happened; the
    // harness records it and the turn is over.
    if (streamed || reply.steps?.length) {
      // Anything not already persisted as it streamed gets written now.
      if (!streamed) for (const st of reply.steps) await appendStep(st);

      // Per-message usage from a streaming agent is fragmentary - a few tokens
      // per chunk, and an input count that excludes everything served from
      // cache. The backend's end-of-turn totals are the real figure, so they
      // are attached to the turn's last message rather than discarded.
      if (reply.usage?.input || reply.usage?.output) {
        for (let i = session.events.length - 1; i >= 0; i -= 1) {
          if (session.events[i].type === 'assistant') {
            session.events[i].usage = { ...reply.usage, total: true };
            break;
          }
        }
        await save(session);
      }

      if (reply.error) await append(noteEvent(`${spec.alias}: ${reply.error}`));
      return {outcome:reply.error ? 'error' : 'responded'};
    }

    const event = await append(assistantEvent(reply));

    if (!usesTools(session) && event.toolCalls.length) {
      for (const call of event.toolCalls) await append(toolResultEvent({callId:call.id, name:call.name, ok:false, output:'Tool execution denied: this session has tools disabled.'}));
      await append(noteEvent('The provider returned tool calls in no-tools mode. No tools were executed.'));
      return {outcome:'error'};
    }
    if (reply.error) {
      await append(noteEvent(`${spec.alias}: ${reply.error}`));
      return {outcome:'error'};
    }
    if (['length','max_tokens'].includes(reply.stopReason)) {
      await append(noteEvent('The provider reached its response token limit. This turn was cut short; the work may be unfinished.'));
      return {outcome:'error'};
    }
    if (!event.toolCalls.length) return; // the model is done talking

    for (const call of event.toolCalls) {
      if (signal?.aborted) {
        // Every tool call still needs a result or the transcript is invalid for
        // the next request, so record the cancellation as the result.
        await append(
          toolResultEvent({ callId: call.id, name: call.name, ok: false, output: 'stopped by user' }),
        );
        continue;
      }
      onDelta?.({ kind: 'tool_start', call });
      const result = await boundedTool(call, {
        projectDir: session.tabWorkspace?.cwd ?? session.tabWorkspace?.dir ?? session.projectDir,
        allowOutside: !session.confineToProjectDir,
        // The Harness app's sessions may edit the harness source (never its data).
        allowHarnessSource: Boolean(session.editsHarness),
        readableDirs: session.readableDirs ?? [],
        // So an email says which session sent it: several may be running
        // unattended, and "it finished" is useless without knowing which.
        sessionId: session.id,
        machineHelp, localModel,
      }, { signal, ms: spec.toolTimeoutMs ?? 120_000 });
      await append(
        toolResultEvent({ callId: call.id, name: call.name, ok: result.ok, output: result.output }),
      );
    }
  }


}
