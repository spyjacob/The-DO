import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import vm from 'node:vm';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { prepareTab } from '../../src/core/tab-workspaces.js';
import { once } from 'node:events';
import { listeningProcesses, runningInfo, stop as stopApp } from '../../src/core/apps.js';
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'execution-hosts-'));
const hosts = [];
const pause = () => new Promise(r => setTimeout(r, 150));
let release;
const modelRequests = [];
const mock = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const body = JSON.parse(Buffer.concat(chunks));
  modelRequests.push(body);
  if (body.messages.some(m=>m.content === 'unsupported-effort')) {
    res.writeHead(400, {'Content-Type':'application/json'});
    return res.end(JSON.stringify({error:{message:'reasoning_effort is unsupported'}}));
  }
  if (body.messages.some(m=>m.content === 'continue-past-forty') && body.messages.filter(m=>m.role === 'tool').length < 41) {
    const n = body.messages.filter(m=>m.role === 'tool').length;
    res.writeHead(200, {'Content-Type':'text/event-stream'});
    return res.end(`data: ${JSON.stringify({choices:[{index:0,delta:{tool_calls:[{index:0,id:'step-'+n,type:'function',function:{name:'list_dir',arguments:'{"path":"."}'}}]},finish_reason:'tool_calls'}]})}\n\ndata: [DONE]\n\n`);
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: body.model }, finish_reason: null }] })}\n\n`);
  if (body.messages.at(-1)?.content === 'wait') await new Promise(r => { release = r; });
  res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
});
await new Promise(r => mock.listen(0, '127.0.0.1', r));
async function start(name) {
  const probe = net.createServer(); await new Promise(r => probe.listen(0, '127.0.0.1', r));
  const port = probe.address().port; await new Promise(r => probe.close(r));
  const dir = path.join(root, name); await fs.mkdir(dir);
  await fs.writeFile(path.join(dir, 'models.json'), JSON.stringify({ default: name, models: { [name]: {
    provider: 'openai', model: name, label: name, baseUrl: `http://127.0.0.1:${mock.address().port}/v1`,
  } } }));
  const origin = `http://127.0.0.1:${port}`;
  const fixture = path.join(dir, 'jev-fetch.mjs');
  await fs.writeFile(fixture, `
    const original = globalThis.fetch;
    globalThis.fetch = (url, options) => {
      if (String(url) !== 'https://api.typesafe.ai/v1/systemone') return original(url, options);
      const body = JSON.parse(options.body);
      if (options.headers.Authorization !== 'Bearer synthetic-jev-key' || body.model !== 'jev-latest')
        return Promise.resolve(new Response('{}', {status: 401}));
      return Promise.resolve(Response.json({ model: 'jev-test', answers: { urgent: {type: 'noul', noul: 0.9} }, usage: {input_tokens: 10} }));
    };
  `);
  const launch = () => spawn(process.execPath, ['--import', fixture, 'server/index.js'], { env: { ...process.env,
    HARNESS_PORT: String(port), HARNESS_TOKEN: 'execution-test', HARNESS_DATA_DIR: dir,
    ORCHESTRATOR_PUBLIC_URL: origin, ORCHESTRATOR_NODE_NAME: name,
  }, stdio: 'ignore' });
  const child = launch();
  const closed = once(child, 'exit');
  const request = (route, method = 'GET', body) => fetch(origin + route, { method,
    headers: { 'Content-Type': 'application/json', 'x-harness-token': 'execution-test' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000) });
  const call = async (...args) => { const r = await request(...args); const v = await r.json(); assert.ok(r.ok, JSON.stringify(v)); return v; };
  const host = { child, closed, call, request, dir, restart: async () => {
    host.child = launch(); host.closed = once(host.child, 'exit');
    for (let i = 0; i < 60; i++) { try { await call('/api/cluster/status'); return; } catch { await pause(); } }
    throw Error('server did not restart');
  } }; hosts.push(host);
  for (let i = 0; i < 60; i++) { try { host.status = await call('/api/cluster/status'); return host; } catch { await pause(); } }
  throw Error('server did not start');
}
try {
  // A real listener on a reused port belongs to its directory, not the old app.
  const groceryDir = path.join(root, 'grocery');
  await fs.mkdir(groceryDir);
  const listener = spawn(process.execPath, ['-e', "require('http').createServer((q,r)=>r.end('grocery')).listen(0,'127.0.0.1',function(){console.log(this.address().port)})"], { cwd: groceryDir });
  const listenerExit = once(listener, 'exit');
  try {
    const [data] = await once(listener.stdout, 'data');
    const port = Number(String(data).trim());
    const processes = await listeningProcesses();
    const actual = processes.find(p => p.pid === listener.pid && p.port === port);
    assert.ok(actual, 'running listener discovered');
    assert.equal(runningInfo({ dir: path.join(root, 'parallel'), port }, processes).running, false);
    if (actual.cwd) assert.equal(runningInfo({ dir: groceryDir, port }, processes).running, true);
    const parent = { id: 'parent', dir: root, port };
    const grocery = { id: 'grocery', dir: groceryDir, port };
    assert.equal(runningInfo(parent, processes, [parent, grocery]).running, false);
    const registry = path.join(root, 'app-registry');
    await fs.mkdir(registry);
    await fs.writeFile(path.join(registry, 'apps.json'), JSON.stringify({ apps: [
      { id: 'parallel', name: 'Parallel', dir: path.join(root, 'parallel'), port },
    ] }));
    await stopApp(registry, 'parallel');
    assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(), 'grocery');
  } finally { listener.kill(); await listenerExit; }
  const a = await start('model-a'), b = await start('model-b');
  const sneaker = await b.call('/api/apps', 'POST', { name: 'Sneaker game', dir: path.join(root, 'sneaker-game') });
  await fs.writeFile(path.join(sneaker.dir, 'saved-game.txt'), 'unsaved-to-git game');
  const existingProject = await a.call('/api/apps', 'POST', { name: 'Existing project', dir: path.join(root, 'existing-project') });
  assert.equal((await a.request('/api/cluster/admit', 'POST', { member: b.status.hosts[0] })).status, 409,
    'an older joining host must update before its registry can be lost');
  const colliding = await b.call('/api/apps', 'POST', { name: 'Different project with same ID', dir: path.join(root, 'collision-project') });
  const registryPath = path.join(b.dir, 'apps.json');
  const registry = JSON.parse(await fs.readFile(registryPath, 'utf8'));
  registry.apps.find(p => p.id === colliding.id).id = existingProject.id;
  await fs.writeFile(registryPath, JSON.stringify(registry));
  const collisionSessionPath = path.join(b.dir, 'sessions', colliding.sessionId + '.json');
  const collisionSession = JSON.parse(await fs.readFile(collisionSessionPath, 'utf8'));
  collisionSession.appId = existingProject.id;
  await fs.writeFile(collisionSessionPath, JSON.stringify(collisionSession));
  await b.call('/api/cluster/join', 'POST', { url: a.status.hosts[0].url, ownUrl: b.status.hosts[0].url, token: 'execution-test' });
  // Host-local diagnostics: served browser actions correlate with real HTTP work.
  const historySource = await (await a.request('/diagnostics.js')).text();
  const listeners = {}, documentListeners = {};
  const browserWindow = { fetch: (route, opts = {}) => fetch(a.status.hosts[0].url + route, { ...opts,
      headers: { ...Object.fromEntries(new Headers(opts.headers)), 'x-harness-token':'execution-test' } }),
    addEventListener: (event, fn) => { listeners[event] = fn; } };
  const browserUi = vm.createContext({ window: browserWindow, crypto: {randomUUID: () => 'browser-e2e'},
    localStorage: { getItem() {}, setItem() {} }, navigator: {userAgent:'iPhone'}, Headers, Request, performance, Date,
    innerWidth:390, innerHeight:844, setInterval: fn => { listeners.flush = fn; },
    document: { addEventListener: (event, fn) => { documentListeners[event] = fn; }, visibilityState:'visible' } });
  vm.runInContext(historySource, browserUi);
  documentListeners.click({ target: { closest: () => ({id:'h-history'}) } });
  browserWindow.harnessTrace('visible', {screen:'history',outcome:'shown'});
  await browserWindow.fetch('/api/jev/evaluate', {method:'POST',body:'{}'});
  browserWindow.harnessTrace('visible', {screen:'banner',outcome:'error'});
  await listeners.flush();
  await a.call('/api/diagnostics', 'POST', {action:'append',events:[{event:'action',control:'send',
    correlationId:'redaction-e2e', text:'PRIVATE-CONTENT', token:'SECRET', url:'https://private.example'}]});
  let history = await a.call('/api/diagnostics?action=events');
  assert.equal(history.maxMB, 2048, 'new hosts default to a 2 GiB history budget');
  assert.ok(history.events.some(e => e.event === 'browser.action' && e.device === 'phone'));
  assert.ok(history.events.some(e => e.event === 'browser.visible' && e.outcome === 'error'));
  assert.ok(history.events.some(e => e.event === 'browser.request' && e.status === 400));
  assert.ok(history.events.some(e => e.event === 'request.finished' && e.status === 400 && e.correlationId === 'browser-e2e'));
  assert.equal((await fetch(a.status.hosts[0].url + '/api/diagnostics')).status,401);
  assert.doesNotMatch(JSON.stringify(history), /PRIVATE-CONTENT|SECRET|private.example/);
  assert.ok(history.freeBytes > 0);
  assert.equal((await a.request('/api/diagnostics', 'POST', {action:'settings',enabled:true,maxMB:99999,days:14})).status,400);
  await a.call('/api/diagnostics', 'POST', {action:'settings',enabled:true,maxMB:4,days:1});
  // Old/oversized segments rotate without touching another host's history.
  await fs.writeFile(path.join(a.dir,'diagnostics','000-old.jsonl'), 'x'.repeat(5 * 1048576));
  history = await a.call('/api/diagnostics');
  assert.ok(history.bytes <= 4 * 1048576);
  await b.call('/api/diagnostics', 'POST', {action:'append',events:[{event:'action',correlationId:'only-b'}]});
  const allHistory = await a.call('/api/diagnostics?action=all');
  assert.equal(allHistory.histories.length,2);
  assert.ok(allHistory.histories.find(h => h.host === b.status.self).events.some(e => e.correlationId === 'only-b'));
  assert.ok(!(await a.call('/api/diagnostics?action=events')).events.some(e => e.correlationId === 'only-b'));
  await a.call('/api/diagnostics', 'POST', {action:'settings',enabled:false,maxMB:4,days:1});
  await a.call('/api/diagnostics', 'POST', {action:'clear'});
  await a.call('/api/diagnostics', 'POST', {action:'append',events:[{event:'action',control:'send'}]});
  assert.equal((await a.call('/api/diagnostics?action=events')).events.length,0);
  assert.ok((await a.call('/api/diagnostics?host='+b.status.self+'&action=events')).events.length > 0);
  await a.call('/api/diagnostics', 'POST', {action:'settings',enabled:true,maxMB:128,days:14});
  // A failed trace write must not fail the project API.
  await fs.rename(path.join(a.dir,'diagnostics'),path.join(a.dir,'diagnostics-saved'));
  await fs.writeFile(path.join(a.dir,'diagnostics'),'unwritable directory fixture');
  await a.call('/api/diagnostics', 'POST', {action:'append',events:[{event:'action'}]});
  assert.ok((await a.call('/api/state')).apps.length);
  await fs.unlink(path.join(a.dir,'diagnostics'));
  await fs.rename(path.join(a.dir,'diagnostics-saved'),path.join(a.dir,'diagnostics'));
  assert.ok((await a.call('/api/diagnostics')).failed > 0);

  const emptyProject = await b.call('/api/apps', 'POST', {name:'Recently emptied',dir:path.join(root,'recently-emptied')});
  const beforeDelete = Date.now();
  await a.call(`/api/sessions/${emptyProject.sessionId}`, 'DELETE');
  const emptyRecord = (await a.call('/api/apps')).apps.find(p => p.id === emptyProject.id);
  assert.ok(emptyRecord.updatedAt >= beforeDelete, 'deletion preserves project recency across hosts');
  const joined = await a.call('/api/apps');
  assert.ok(joined.apps.some(p => p.id === existingProject.id));
  const importedId = `${existingProject.id}-${b.status.self}`;
  assert.equal(joined.apps.find(p => p.id === existingProject.id).dir, existingProject.dir);
  assert.equal(joined.apps.find(p => p.id === importedId).dir, colliding.dir);
  assert.equal((await a.call('/api/state')).sessions.find(s => s.id === colliding.sessionId).appId, importedId);
  assert.equal(joined.apps.find(p => p.id === sneaker.id).ownerNode, b.status.self);
  assert.deepEqual(joined.apps.find(p => p.id === sneaker.id).machines.filter(m => m.placed).map(m => m.id), [b.status.self]);
  assert.equal((await a.call('/api/state')).sessions.find(s => s.id === sneaker.sessionId).appId, sneaker.id);
  assert.equal(await fs.readFile(path.join(sneaker.dir, 'saved-game.txt'), 'utf8'), 'unsaved-to-git game');

  // Simulate the missing registry and tabs left by the old join/conflict path.
  // Original standalone sessions and the pre-join archive still exist on B.
  await a.call(`/api/apps/${sneaker.id}?sessions=1`, 'DELETE');
  const recover = body => a.call('/api/cluster/recovery', 'POST', { host: b.status.self, ...body });
  const candidates = await recover({ action: 'list' });
  assert.equal(candidates.projects.find(p => p.id === sneaker.id).tabs, 1);
  assert.equal(JSON.stringify(candidates).includes('execution-test'), false);
  await recover({ action: 'restore', appId: sneaker.id, correlationId: 'recovery-e2e' });
  assert.ok((await a.call('/api/apps')).apps.some(p => p.id === sneaker.id));
  assert.equal((await a.call('/api/state')).sessions.find(s => s.id === sneaker.sessionId).appId, sneaker.id);
  assert.equal(await fs.readFile(path.join(sneaker.dir, 'saved-game.txt'), 'utf8'), 'unsaved-to-git game');
  assert.equal((await a.request('/api/cluster/recovery', 'POST', { host: b.status.self, action: 'restore', appId: 'missing', correlationId: 'recovery-error-e2e' })).status, 400);
  const recoveryTraces = (await recover({ action: 'traces' })).events;
  assert.ok(recoveryTraces.some(e => e.event === 'recovery.restored' && e.correlationId === 'recovery-e2e'));
  assert.ok(recoveryTraces.some(e => e.event === 'recovery.error' && e.correlationId === 'recovery-error-e2e'));
  assert.deepEqual(await a.call('/api/jev'), { configured: false });
  assert.equal((await a.request('/api/jev/evaluate', 'POST', {})).status, 400);
  assert.equal((await b.request('/api/jev', 'PUT', {apiKey: ''})).status, 400);
  const savedJev = await b.call('/api/jev', 'PUT', { apiKey: 'synthetic-jev-key' });
  assert.deepEqual(savedJev, { configured: true });
  assert.deepEqual(await a.call('/api/jev'), { configured: true });
  assert.equal((await a.request('/api/jev/evaluate', 'POST', {})).status, 400);
  const evaluated = await b.call('/api/jev/evaluate', 'POST', {state: 'urgent', questions: {urgent: {type: 'noul', instructions: 'Urgent?'}}});
  assert.equal(evaluated.answers.urgent.noul, 0.9);
  assert.equal(JSON.stringify(evaluated).includes('synthetic-jev-key'), false);
  assert.deepEqual(await b.call('/api/jev', 'DELETE'), { configured: false });
  assert.deepEqual(await a.call('/api/jev'), { configured: false });
  // New-session inventories must follow the selected computer from either browser host.
  for (const browser of [a, b]) {
    for (const [owner, model] of [[a, 'model-a'], [b, 'model-b']]) {
      const choices = await browser.call(`/api/execution-models?app=__harness&host=${owner.status.self}`);
      assert.deepEqual(Object.keys(choices.models), [model]);
      assert.equal(choices.default, model);
    }
  }
  // Exercise the served frontend with reordered status replies and tab switches.
  const frontend = await (await a.request('/app.js')).text();
  // Render the served reply formatter, including a table arriving in chunks.
  const formattingUi = vm.createContext({ state: {session: {id:'formatting'}}, nodeApi: value => value });
  vm.runInContext(frontend.slice(frontend.indexOf('const esc ='), frontend.indexOf('/** Local date')), formattingUi);
  const tableReply = '**Replication**\n\n| Data | When it reconnects |\n|---|---|\n| Saved chats | Catch up through the log |\n| Files | Stay on their **owner** |\n\n- More work remains';
  assert.doesNotMatch(formattingUi.render('| Data | When it reconnects |\n|--'), /<table>/);
  const formatted = formattingUi.render(tableReply);
  assert.match(formatted, /<thead><tr><th scope="col"/);
  assert.match(formatted, /<td[^>]*>Stay on their <strong>owner<\/strong><\/td>/);
  assert.match(formatted, /<\/table><\/div><br><ul><li>More work remains/);
  assert.doesNotMatch(formatted, /\|---\|/);
  assert.match(formattingUi.render('A | B\n:--- | ---:\n`a\\|b` | <script>bad</script>'), /<code>a\|b<\/code>/);
  assert.doesNotMatch(formattingUi.render('A | B\n--- | ---\n<script>bad</script> | safe'), /<script>/);
  assert.doesNotMatch(formattingUi.render('```\nA | B\n--- | ---\n```'), /<table>/);
  assert.doesNotMatch(formattingUi.render('A | B\n---\nplain text'), /<table>/);
  // Stream into the saved progress slot, including collapsed progress and redraws.
  const streamTab = { session: { model: 'demo', events: [{ type: 'user', id: 'question' }] }, live: null };
  let progressChildren = [];
  const activity = {};
  const progress = { querySelector: () => activity, insertBefore(node, before) {
    assert.equal(before, activity);
    progressChildren = [node, activity];
  } };
  const streamUi = vm.createContext({ state: {tab:'chat',models:{}}, tabs: {chat:streamTab},
    window: {harnessTrace() {}}, esc: String,
    turnsFrom: events => events.map(user => ({user})), foldKey: turn => turn.user.id,
    document: { getElementById(id) { assert.equal(id, 'fold-question'); return progress; },
      createElement() { return { remove() { progressChildren = progressChildren.filter(n => n !== this); } }; } },
  });
  vm.runInContext(frontend.slice(frontend.indexOf('function mountLive('), frontend.indexOf('// ---------------------------------------------------------------- session')), streamUi);
  const streaming = streamUi.liveTurn();
  assert.equal(progressChildren[0], streaming, 'first delta starts inside progress, before tools');
  assert.equal(streamUi.liveTurn(), streaming, 'subsequent chunks retain the same node');
  progressChildren = []; // A transcript redraw creates a fresh progress body.
  streamUi.mountLive();
  assert.equal(progressChildren[0], streaming, 'redraw preserves the live reply');
  progress.hidden = true;
  streamUi.mountLive();
  assert.equal(progress.hidden, true, 'streaming respects manually collapsed progress');
  streamUi.clearLive();
  assert.equal(streamTab.live, null);
  assert.equal(progressChildren.includes(streaming), false);

  // Separate browser windows share localStorage but restore their own chat.
  const windowSessions = await Promise.all(['window one', 'window two'].map(name =>
    a.call('/api/sessions', 'POST', {appId:'__harness', name, mode:'chat', model:'model-a'})));
  const sharedStorage = new Map([['lastSession', 'obsolete-other-window']]);
  const storage = map => ({getItem:key=>map.get(key)||null, setItem:(key,value)=>map.set(key,value)});
  function selectionWindow(href, remembered = new Map()) {
    const location = new URL(href);
    const traces = [];
    const context = vm.createContext({location, URL, URLSearchParams,
      sessionStorageKey:'lastSession', sessionStorage:storage(remembered), localStorage:storage(sharedStorage),
      history:{state:null, replaceState:(_state,_title,url)=>{location.href=new URL(url,location).href;}},
      window:{harnessTrace:(event,details)=>traces.push({event,...details})},
      state:{sessions:windowSessions, models:{}, session:null}, tabs:{chat:{}},
      $:()=>({}), sessionOffline:()=>false, closeSheet(){}, clearLive(){}, showSession(){},
      listen(){}, paintHeader(){}, showBanner(){}, drawTranscript(){}, machinesSheet(){},
      refreshState:async()=>{}, api:route=>a.call(route),
    });
    vm.runInContext(frontend.slice(frontend.indexOf('let openingSession ='), frontend.indexOf('async function editTranscript(')), context);
    vm.runInContext(frontend.slice(frontend.indexOf('async function initializeApp()'), frontend.indexOf('let networkChecking =')), context);
    return {context, location, remembered, traces};
  }
  const firstWindow = selectionWindow('http://harness/?session=stale&node=test-node');
  const secondWindow = selectionWindow('http://harness/');
  await firstWindow.context.openSession(windowSessions[0].id);
  await secondWindow.context.openSession(windowSessions[1].id);
  assert.equal(firstWindow.location.searchParams.get('node'),'test-node');
  assert.equal(firstWindow.location.searchParams.get('session'),windowSessions[0].id,'selection replaces stale deep link');
  for (const [index, original] of [firstWindow, secondWindow].entries()) {
    const refreshed = selectionWindow(original.location.href, original.remembered);
    await refreshed.context.initializeApp();
    assert.equal(refreshed.context.state.session.id,windowSessions[index].id,'refresh restores this window');
  }
  const beforeFailure = firstWindow.location.href;
  firstWindow.context.api = async()=>{throw Error('Host unavailable');};
  await firstWindow.context.openSession('missing-session');
  assert.equal(firstWindow.location.href,beforeFailure,'failed navigation preserves last displayed chat');
  assert.ok(firstWindow.traces.some(event=>event.outcome==='open-failed'));
  assert.equal(sharedStorage.get('lastSession'),'obsolete-other-window','selection never writes shared browser storage');
  const restartNotice = {textContent:'', hidden:true};
  const noticeUi = vm.createContext({window:{}, $:()=>restartNotice});
  vm.runInContext(frontend.slice(frontend.indexOf('const pendingRestarts ='),frontend.indexOf('async function refreshState()')),noticeUi);
  const versions = await a.call('/api/harness/versions');
  const host = versions.hosts.find(h => h.id === a.status.self);
  noticeUi.paintRestartNotice({checkedAt:'1',hosts:[{...host,update:{restartRequired:true,head:'next-build'},state:'Restart needed'}]});
  assert.equal(restartNotice.hidden,false);
  noticeUi.paintRestartNotice({checkedAt:'2',hosts:[{id:host.id,state:'Unreachable'}]});
  assert.equal(restartNotice.hidden,false,'unreachable does not mean updated');
  noticeUi.paintRestartNotice({checkedAt:'3',hosts:[{...host,update:{}}]});
  assert.equal(restartNotice.hidden,false,'missing update flags cannot clear pending restart');
  noticeUi.paintRestartNotice({checkedAt:'4',hosts:[{...host,version:{revision:'next-build'},update:{}}]});
  assert.equal(restartNotice.hidden,true,'verified running target clears the notice');
  noticeUi.paintRestartNotice({checkedAt:'1',hosts:[{...host,update:{restartRequired:true,head:'next-build'}}]});
  assert.equal(restartNotice.hidden,true,'stale responses cannot restore an old notice');

  const historyElements = new Map();
  let historyHtml = '', historyError = '';
  const historyUi = vm.createContext({ window:{}, state:{machines:{hosts:[{id:a.status.self,name:'model-a'},{id:b.status.self,name:'model-b'}]}},
    sheetView:'', esc:String, encodeURIComponent, Number,
    nativeFetch: (route,opts={}) => a.request(route,opts.method || 'GET',opts.body ? JSON.parse(opts.body) : undefined),
    $: id => { if(!historyElements.has(id)) historyElements.set(id,{}); return historyElements.get(id); },
    openSheet(html,view) { historyUi.sheetView = view; historyHtml = html; },
    settingsSheet() {}, showBanner: text => {historyError = text;} });
  vm.runInContext(frontend.slice(frontend.indexOf('let historyRequest ='),frontend.indexOf('async function jevSheet()')),historyUi);
  await historyUi.historySheet();
  assert.match(historyHtml,/Free disk/);
  Object.assign(historyUi.$('history-enabled'),{value:'on'});
  historyUi.$('history-mb').value = '1';
  historyUi.$('history-days').value = '14';
  await historyElements.get('history-save').onclick();
  assert.match(historyError,/4–2048/);
  historyUi.$('history-mb').value = '128';
  await historyElements.get('history-save').onclick();
  assert.equal(historyElements.get('history-result').textContent,'History settings saved.');
  await historyElements.get('history-clear').onclick();
  assert.match(historyElements.get('history-result').textContent,/History cleared/);
  let deleteHtml = '';
  const deleteControls = new Map();
  const deleteUi = vm.createContext({
    state:{apps:[{id:emptyProject.id}],sessions:[]}, esc:String, shortDir:String,
    refreshState:async()=>{}, openSheet:html=>{deleteHtml=html;deleteControls.clear();},
    $:id=>{
      if (!deleteHtml.includes('id="'+id+'"')) return null;
      if (!deleteControls.has(id)) deleteControls.set(id,{dataset:{},checked:false});
      return deleteControls.get(id);
    },
    appsSheet(){}, appEditSheet(){}, showBanner:message=>assert.fail(message)
  });
  vm.runInContext(frontend.slice(frontend.indexOf('async function appDeleteSheet('),frontend.indexOf('async function usageSheet(')),deleteUi);
  await deleteUi.appDeleteSheet(emptyRecord);
  assert.doesNotMatch(deleteHtml,/id="del-sessions"/);
  vm.runInContext(frontend.slice(frontend.indexOf('async function deleteSessionSheet('),frontend.indexOf('function showSession()')),deleteUi);
  deleteUi.state.sessions = [{id:'last-tab',appId:emptyProject.id}];
  await deleteUi.deleteSessionSheet(deleteUi.state.sessions[0]);
  assert.match(deleteHtml,/id="session-delete-project"/);
  deleteUi.state.sessions.push({id:'other-tab',appId:emptyProject.id});
  await deleteUi.deleteSessionSheet(deleteUi.state.sessions[0]);
  assert.doesNotMatch(deleteHtml,/id="session-delete-project"/);

  // Drive the served recovery screen against the real API and a conflict archive.
  const archived = { id: 'archived-game', name: 'Archived game', dir: path.join(root, 'archived-game'), ownerNode: b.status.self };
  await fs.mkdir(archived.dir);
  await fs.writeFile(path.join(b.dir, 'cluster', 'conflict-e2e.json'), JSON.stringify({ base: 0, commit: 2, log: [
    { command: { type: 'value', id: 'settings:apps.json', value: JSON.stringify({ apps: [archived] }) } },
    { command: { type: 'session', id: 'archived-tab', value: { id: 'archived-tab', appId: archived.id, ownerNode: b.status.self,
      projectDir: archived.dir, name: 'Saved tab', events: [], updatedAt: 1 } } },
  ], secret: 'must-not-appear-in-recovery' }));
  const recoveryButtons = [];
  let recoveryHtml = '', recoveryBanner = '';
  const recoveryUi = vm.createContext({ crypto: { randomUUID: () => 'recovery-ui-e2e' },
    state: { machines: { hosts: [{ id: b.status.self, name: 'model-b', member: true }] } },
    sheetView: '', esc: String,
    api: (route, opts) => a.call(route, opts.method, JSON.parse(opts.body)),
    refreshState: () => a.call('/api/state'), appsSheet() {}, showBanner: text => { recoveryBanner = text; },
    $: id => id === 'sheet' ? { querySelectorAll: () => recoveryButtons } : {},
    openSheet(html, view) {
      recoveryUi.sheetView = view; recoveryHtml = html;
      recoveryButtons.splice(0, recoveryButtons.length, ...[...html.matchAll(/data-recover="(\d+)"/g)].map(m => ({ dataset: { recover: m[1] } })));
    },
  });
  vm.runInContext(frontend.slice(frontend.indexOf('async function recoverProjectsSheet('), frontend.indexOf('async function runApp(')), recoveryUi);
  await recoveryUi.recoverProjectsSheet();
  assert.match(recoveryHtml, /Archived game/);
  assert.doesNotMatch(recoveryHtml, /must-not-appear/);
  assert.equal(recoveryButtons.length, 1);
  const restoreButton = recoveryButtons[0];
  await restoreButton.onclick();
  assert.equal(restoreButton.textContent, 'restored');
  assert.ok((await a.call('/api/state')).sessions.some(s => s.id === 'archived-tab'));
  // A stale second click is rejected and visibly reported without replacing data.
  await restoreButton.onclick();
  assert.match(recoveryBanner, /No missing project/);
  await recoveryUi.recoverProjectsSheet();
  assert.match(recoveryHtml, /No missing projects found/);
  let visibleStates = [];
  for (let i = 0; i < 30; i++) {
    visibleStates = (await recover({ action: 'traces' })).events.filter(e => e.correlationId === 'recovery-ui-e2e' && e.event === 'recovery.visible').map(e => e.visible);
    if (['loading', 'results', 'success', 'error', 'empty'].every(s => visibleStates.includes(s))) break;
    await pause();
  }
  for (const expected of ['loading', 'results', 'success', 'error', 'empty']) assert.ok(visibleStates.includes(expected), expected);
  const classes = new Set(), pendingStatus = [];
  const pushButton = { classList: { toggle(name, on) { on ? classes.add(name) : classes.delete(name); } } };
  const ui = vm.createContext({ state: { session: { id: 'first' } },
    $: () => pushButton,
    api: route => new Promise((resolve, reject) => pendingStatus.push({ route, resolve, reject })),
  });
  vm.runInContext(frontend.slice(frontend.indexOf('const pushStates ='), frontend.indexOf('async function refreshState()')), ui);
  const oldStatus = ui.readPushStatus('first');
  const newStatus = ui.readPushStatus('first');
  pendingStatus[1].resolve({ pending: true, busy: false }); await newStatus;
  pendingStatus[0].resolve({ pending: false, busy: false }); await oldStatus;
  assert.ok(classes.has('push-pending'), 'older clean response cannot overwrite newer pending changes');
  const busyStatus = ui.readPushStatus('first');
  pendingStatus[2].resolve({ pending: false, busy: true }); await busyStatus;
  assert.ok(classes.has('push-pending'), 'temporary clean files during work do not flash the indicator');
  const failedStatus = ui.refreshPushStatus();
  pendingStatus[3].reject(new Error('offline')); await failedStatus;
  assert.ok(classes.has('push-pending'), 'network failure preserves last known pending state');
  assert.match(pushButton.title, /unavailable/);
  ui.state.session = { id: 'second' }; ui.paintPushStatus();
  assert.ok(!classes.has('push-pending'), 'different session never inherits pending state');
  ui.state.session = { id: 'first' }; ui.paintPushStatus();
  assert.ok(classes.has('push-pending'), 'returning to a session restores its known state immediately');
  const cleanStatus = ui.readPushStatus('first');
  pendingStatus[4].resolve({ pending: false, busy: false }); await cleanStatus;
  assert.ok(!classes.has('push-pending'), 'confirmed idle status clears pending changes');
  // A sheet opened during a turn must still accept a click after that turn.
  const gitNodes = new Map(['s-git', 'g-now', 'g-push-status'].map(id => [id, {
    innerHTML: '', textContent: '', classList: { toggle() {} }, insertAdjacentHTML() {},
  }]));
  let publishCalls = 0;
  const pushBanners = [];
  const panel = vm.createContext({
    closeSheet() {}, window: {},
    state: { session: { id: 'panel' } }, $: id => gitNodes.get(id),
    esc: String, clock: String, showBanner: text => pushBanners.push(text),
    api: async route => {
      if (route.startsWith('/api/git/push?')) {
        publishCalls++;
        throw new Error('Finish the current task before pushing');
      }
      return { repo: true, pending: true, busy: true, history: [] };
    },
  });
  vm.runInContext(frontend.slice(frontend.indexOf('const pushStates ='), frontend.indexOf('async function refreshState()')), panel);
  vm.runInContext(frontend.slice(frontend.indexOf('async function paintGit('), frontend.indexOf('/** Repoint a session')), panel);
  await panel.paintGit(panel.state.session);
  assert.equal(gitNodes.get('g-now').disabled, false, 'busy snapshot does not leave an inert button');
  await gitNodes.get('g-now').onclick();
  assert.equal(publishCalls, 1, 'click checks current server state');
  assert.match(gitNodes.get('g-push-status').textContent, /Not published: Finish the current task/);
  assert.equal(gitNodes.get('g-now').disabled, false, 'refused push can be retried without reopening');
  pushBanners.length = 0;
  panel.api = async route => route.startsWith('/api/git/push?')
    ? { ok: true, pushed: true, files: ['app.js'], sha: 'abc123' }
    : { repo: true, pending: false, busy: false, history: [] };
  await gitNodes.get('g-now').onclick();
  assert.deepEqual(pushBanners, [], 'successful push stays in chat without a banner');
  const state = await a.call('/api/state');
  assert.equal(state.apps.find(app => app.id === '__harness').executionHosts.length, 2);
  const s = await a.call('/api/sessions', 'POST', { appId: '__harness', name: 'remote', mode: 'chat', model: 'model-b', ownerNode: b.status.self });
  const inventory = await a.call(`/api/sessions/${s.id}/models`);
  assert.deepEqual(Object.keys(inventory.models), ['model-b'], 'models stay local to the owner');
  const events = await a.request(`/api/sessions/${s.id}/events`);
  const reader = events.body.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /hello/);
  await reader.cancel();
  await a.call(`/api/sessions/${s.id}/send`, 'POST', { text: 'wait' });
  for (let i = 0; i < 80 && !release; i++) await pause();
  assert.ok(release, 'a follower executed the model request');
  const queued = await a.call(`/api/sessions/${s.id}/queue`, 'POST', {text:'queued original'});
  assert.equal(queued.queued, true);
  const pending = (await a.call(`/api/sessions/${s.id}/pending`)).pending[0];
  assert.equal(pending.text,'queued original');
  assert.equal((await b.call(`/api/sessions/${s.id}/pending`)).pending[0].pendingId,pending.pendingId);
  await a.call(`/api/sessions/${s.id}/pending`, 'PATCH', {pendingId:pending.pendingId,text:'edited before sending'});
  assert.equal((await a.call(`/api/sessions/${s.id}/pending`)).pending[0].text,'edited before sending');
  assert.equal((await a.request(`/api/sessions/${s.id}/pending`,'DELETE',{pendingId:'stale'})).status,409);
  await a.call(`/api/sessions/${s.id}/pending`, 'DELETE', {pendingId:pending.pendingId});
  assert.equal((await a.call(`/api/sessions/${s.id}/pending`)).pending.length,0);
  // Drive the served pending panel, including editing and cancelling on the owner.
  const panelQueued = await a.call(`/api/sessions/${s.id}/queue`, 'POST', {text:'panel draft'});
  const pendingElements = new Map();
  const pendingUi = vm.createContext({ window:{}, cur:()=>({session:{id:s.id}}),
    $: id => { if (!pendingElements.has(id)) pendingElements.set(id,{querySelector:()=>({}),replaceChildren(){}}); return pendingElements.get(id); },
    api:(route,opts)=>a.call(route,opts.method,JSON.parse(opts.body)),
    showBanner: text => assert.fail(text) });
  vm.runInContext(frontend.slice(frontend.indexOf('const pendingMessages ='),frontend.indexOf('async function send(queue')),pendingUi);
  pendingUi.message = panelQueued.pending;
  pendingUi.sessionId = s.id;
  vm.runInContext('pendingMessages.set(sessionId,message); paintMessagePending();',pendingUi);
  assert.match(pendingElements.get('message-pending').innerHTML,/pending-stack/);
  const disclosure = pendingElements.get('pending-disclosure');
  assert.match(pendingElements.get('message-pending').innerHTML, /<details id="pending-disclosure">/);
  disclosure.open = true; disclosure.ontoggle();
  vm.runInContext('paintMessagePending();', pendingUi);
  assert.equal(pendingElements.get('pending-disclosure'), disclosure);
  pendingElements.get('pending-edit').onclick();
  pendingElements.get('pending-text-edit').value = 'panel edited';
  vm.runInContext('paintMessagePending();', pendingUi);
  assert.equal(pendingElements.get('pending-text-edit').value, 'panel edited', 'refresh preserves pending edits');
  await pendingElements.get('pending-save').onclick();
  assert.equal((await a.call(`/api/sessions/${s.id}/pending`)).pending[0].text,'panel edited');
  await pendingElements.get('pending-cancel').onclick();
  assert.equal(pendingElements.get('message-pending').hidden,true);

  assert.ok((await a.call('/api/state')).running.includes(s.id),'cancelling pending leaves current turn running');

  const activeState = await a.call('/api/state');
  const activeSession = activeState.sessions.find(row => row.id === s.id);
  assert.equal(activeSession.turnHost, b.status.self);
  assert.ok(activeSession.lastMessageAt > 0);
  const ordering = vm.createContext({ state: { busy: activeState.running } });
  vm.runInContext(frontend.slice(frontend.indexOf('function sessionActive('), frontend.indexOf('function paintSessionTabs(')), ordering);
  const rows = [
    { id: 'recent', lastMessageAt: activeSession.lastMessageAt + 100 },
    { id: 'renamed', lastMessageAt: 1, updatedAt: Date.now() + 10000 },
    activeSession,
  ].sort(ordering.sessionOrder);
  assert.equal(rows[0].id, s.id, 'remote active session sorts first');
  assert.equal(rows[1].id, 'recent', 'message time wins over incidental saves');

  ordering.state.sessions = [
    { id: 'do-tab', appId: '__harness', lastMessageAt: 1 },
    { id: 'grocery-old', appId: 'grocery', lastMessageAt: 2 },
    { id: 'grocery-new', appId: 'grocery', lastMessageAt: 30 },
    { id: 'other-tab', appId: 'other', lastMessageAt: 20, updatedAt: 100, turnHost: 'busy-host' },
  ];
  vm.runInContext(frontend.slice(frontend.indexOf('function orderProjects('), frontend.indexOf('let peerCatalog')), ordering);
  const projects = [
    { id: 'other', name: 'Other', running: true },
    { id: 'grocery', name: 'Grocery', running: false },
    { id: '__harness', name: 'DO', builtin: true },
  ];
  assert.deepEqual(Array.from(ordering.orderProjects(projects), p => p.id), ['__harness', 'grocery', 'other']);
  assert.deepEqual(Array.from(ordering.orderProjects([...projects, {id:'empty',updatedAt:Date.now()}]), p => p.id),
    ['__harness','empty','grocery','other']);
  let projectHtml;
  const elements = new Map();
  Object.assign(ordering, {
    sheetView: 'apps', esc: String, shortDir: String, clock: String,
    sessionStatus: () => '', showPeerSessions() {},
    $: id => {
      if (!elements.has(id)) elements.set(id, { scrollTop: 0, querySelectorAll: () => [] });
      return elements.get(id);
    },
    openSheet: html => { projectHtml = html; },
  });
  vm.runInContext(frontend.slice(frontend.indexOf('function renderAppsSheet('), frontend.indexOf('async function runApp(')), ordering);
  ordering.renderAppsSheet({ apps: projects });
  assert.ok(projectHtml.indexOf('data-app-toggle="__harness"') < projectHtml.indexOf('data-app-toggle="grocery"'));
  assert.ok(projectHtml.indexOf('data-app-toggle="grocery"') < projectHtml.indexOf('data-app-toggle="other"'));
  assert.doesNotMatch(projectHtml, /data-open=|Working now|Recently messaged/);

  assert.ok((await a.call('/api/state')).running.includes(s.id));
  assert.equal((await a.request(`/api/sessions/${s.id}/machine`, 'POST', { ownerNode: a.status.self })).status, 409);
  const parallel = await a.call('/api/sessions', 'POST', { appId: '__harness', name: 'parallel', mode: 'chat', model: 'model-a', ownerNode: a.status.self });
  await b.call(`/api/sessions/${parallel.id}/send`, 'POST', { text: 'hello' });
  let parallelResult;
  for (let i = 0; i < 80; i++) {
    parallelResult = await a.call(`/api/sessions/${parallel.id}`);
    if (!parallelResult.busy && !parallelResult.turnHost && parallelResult.events.some(e => e.type === 'assistant')) break;
    await pause();
  }
  assert.ok(parallelResult.events.some(e => e.type === 'assistant'));
  assert.ok((await a.call('/api/state')).running.includes(s.id), 'another tab completes while the first is busy');
  assert.equal((await a.call('/api/state')).projectQueues, undefined);
  for (const text of ['fifo-one','fifo-remove','fifo-three'])
    await a.call(`/api/sessions/${s.id}/queue`, 'POST', {text});
  const queuedMany = (await b.call(`/api/sessions/${s.id}/pending`)).pending;
  assert.deepEqual(queuedMany.map(m=>m.text), ['fifo-one','fifo-remove','fifo-three']);
  await a.call(`/api/sessions/${s.id}/pending`, 'DELETE', {pendingId:queuedMany[1].pendingId});
  await a.call(`/api/sessions/${s.id}/pending`, 'PATCH', {pendingId:queuedMany[2].pendingId,text:'fifo-edited'});
  assert.deepEqual((await a.call(`/api/sessions/${s.id}/pending`)).pending.map(m=>m.text),['fifo-one','fifo-edited']);
  release();
  let finished;
  for (let i = 0; i < 80; i++) {
    finished = await a.call(`/api/sessions/${s.id}`);
    if (!finished.busy && !finished.turnHost && finished.events.filter(e=>e.type === 'assistant').length >= 3) break;
    await pause();
  }
  assert.ok(!finished.turnHost);
  assert.deepEqual(finished.events.filter(e=>e.type === 'user').map(e=>e.text), ['wait','fifo-one','fifo-edited']);
  assert.equal((await a.call(`/api/sessions/${s.id}/pending`)).pending.length,0);
  assert.equal(finished.ownerNode, b.status.self);
  assert.ok(finished.events.some(e => e.type === 'assistant' && e.text === 'model-b'));
  assert.equal((await a.request(`/api/sessions/${s.id}/rewind`, 'POST', { eventId: finished.events[0].id, revertFiles: true })).status, 409, 'file rewind cannot bypass publication order');
  const stale = structuredClone(finished);
  const moved = await a.call(`/api/sessions/${s.id}/machine`, 'POST', { ownerNode: a.status.self });
  assert.equal(moved.ownerNode, a.status.self);
  assert.equal(moved.model, 'model-a');
  // Test only synthetic credentials in this test's temporary directory.
  const identity = JSON.parse(await fs.readFile(path.join(a.dir, 'cluster', 'replica.json'), 'utf8'));
  const late = await fetch(a.status.hosts[0].url + '/api/cluster/worker-save', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-cluster-key': identity.secret },
    body: JSON.stringify({ host: b.status.self, session: stale }) });
  assert.equal(late.status, 409, 'a delayed previous-owner write cannot undo assignment');
  assert.equal((await a.call(`/api/sessions/${s.id}`)).ownerNode, a.status.self);
  assert.equal((await a.request('/api/cluster/worker-save', 'POST', { host: a.status.self, session: moved })).status, 403);
  // A restarted worker may never have been offline long enough for the
  // coordinator's liveness timeout. Simulate its persisted abandoned turn.
  const abandoned = { ...stale, id: 'abandoned-worker-turn', turnHost: b.status.self,
    turnStartedAt: 123, executionEpoch: 0 };
  const seeded = await fetch(a.status.hosts[0].url + '/api/cluster/command', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-cluster-key': identity.secret },
    body: JSON.stringify({ type: 'session', id: abandoned.id, value: abandoned }),
  });
  assert.equal(seeded.status, 200);
  let recovered;
  for (let i = 0; i < 80; i++) {
    recovered = await a.call('/api/sessions/' + abandoned.id);
    if (!recovered.turnHost) break;
    await pause();
  }
  assert.ok(!recovered.turnHost, 'an online worker recovers its own abandoned turn');
  assert.equal(recovered.executionEpoch, 1);
  assert.equal(recovered.ownerNode, b.status.self);
  assert.ok(recovered.events.some(e => /nothing was automatically published or replayed/.test(e.text || '')));
  assert.equal((await a.call('/api/sessions/' + s.id)).ownerNode, a.status.self);
  const project = await a.call('/api/apps', 'POST', { name: 'local only', dir: path.join(root, 'local-project'), hosts: [a.status.self] });
  const disallowed = await b.request('/api/sessions', 'POST', { appId: project.id, model: 'model-b', ownerNode: b.status.self });
  assert.equal(disallowed.status, 400);
  const local = await b.call('/api/sessions', 'POST', { appId: project.id, mode: 'chat', model: 'model-a' });
  assert.equal(local.ownerNode, a.status.self, 'another computer can create a tab on the only enabled owner');
  const dependency = { host: a.status.self, alias: 'model-a', label: 'Analysis model', purpose: 'Product analysis' };
  await b.call('/api/apps/' + project.id, 'PATCH', { aiDependencies: [dependency] });
  await a.call('/api/apps/' + project.id, 'PATCH', { aiDependencies: [{ ...dependency, host: b.status.self }] });
  const wrongHostLaunch = await a.request('/api/apps/' + project.id + '/start', 'POST');
  assert.equal(wrongHostLaunch.status, 400);
  assert.match((await wrongHostLaunch.json()).error, /source computer/);
  await a.call('/api/apps/' + project.id, 'PATCH', { aiDependencies: [dependency] });
  const configured = await a.call('/api/apps');
  assert.deepEqual(configured.apps.find(app => app.id === project.id).aiDependencies, [dependency]);
  const blockedRemoval = await a.request('/api/cluster/sources', 'POST', { host: a.status.self, action: 'remove', alias: 'model-a' });
  assert.equal(blockedRemoval.status, 400);
  assert.match((await blockedRemoval.json()).error, /Used by local only/);
  const invalidDependency = await b.request('/api/apps/' + project.id, 'PATCH', { aiDependencies: [{ purpose: 'missing source' }] });
  assert.equal(invalidDependency.status, 400);

  const creation = await b.call(`/api/git?session=${local.id}&history=1`);
  assert.equal(creation.projectName, 'local only');
  assert.equal(creation.repositoryName, 'local-only');
  assert.equal(creation.createRepository, true);
  assert.ok(!creation.remote);
  const invalidVisibility = await b.request(`/api/git/push?session=${local.id}`, 'POST', { session: local.id, visibility: 'invalid' });
  assert.equal(invalidVisibility.status, 400);

  assert.equal((await b.call(`/api/sessions/${local.id}/models`)).default, 'model-a');
  await b.call(`/api/sessions/${local.id}/send`, 'POST', { text: 'hello' });
  for (let i = 0; i < 80; i++) {
    const value = await b.call(`/api/sessions/${local.id}`);
    if (!value.turnHost) { assert.ok(value.events.some(e => e.text === 'model-a')); break; }
    await pause();
  }
  assert.equal((await a.request(`/api/sessions/${local.id}/machine`, 'POST', { ownerNode: b.status.self })).status, 409);
  // Legacy durable queue values cannot block new turns or replay old requests.
  const legacy = await fetch(a.status.hosts[0].url + '/api/cluster/command', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-cluster-key': identity.secret },
    body: JSON.stringify({ type: 'value', id: 'turn-queue:__harness', value: { next: 2, entries: [
      { id: 'old', sessionId: s.id, owner: a.status.self, state: 'blocked', number: 1 },
    ] } }),
  });
  assert.equal(legacy.status, 200);
  await a.call(`/api/sessions/${s.id}/send`, 'POST', { text: 'continue without a queue' });
  for (let i = 0; i < 80; i++) {
    const value = await a.call(`/api/sessions/${s.id}`);
    if (!value.turnHost && value.events.some(e => e.text === 'continue without a queue')
      && !(await a.call('/api/state')).running.includes(s.id)) break;
    await pause();
  }
  // Pending summaries include committed, unstaged and untracked session work.
  const summaryDir = path.join(root, 'summary-project');
  await fs.mkdir(summaryDir);
  const git = (dir, ...args) => execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@localhost', ...args], { cwd: dir, stdio: 'pipe' });
  git(summaryDir, 'init', '-b', 'main');
  await fs.writeFile(path.join(summaryDir, 'README.md'), 'original');
  git(summaryDir, 'add', '.'); git(summaryDir, 'commit', '-m', 'initial');
  const summarySession = await a.call('/api/sessions', 'POST', { name: 'summary', projectDir: summaryDir, model: 'model-a' });
  await prepareTab(summarySession);
  const work = summarySession.tabWorkspace.dir;
  // Push prepares public AI requirements in the isolated worktree, even if
  // project validation subsequently blocks publication.
  summarySession.appId = project.id;

  await fs.writeFile(path.join(work, 'README.md'), 'saved documentation');
  git(work, 'commit', '-am', 'documentation');
  await fs.mkdir(path.join(work, 'server/public'), { recursive: true });
  await fs.writeFile(path.join(work, 'server/public/app.js'), 'new interface');
  const seededSummary = await fetch(a.status.hosts[0].url + '/api/cluster/command', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-cluster-key': identity.secret },
    body: JSON.stringify({ type: 'session', id: summarySession.id, value: summarySession }),
  });
  assert.equal(seededSummary.status, 200);
  const summary = await b.call(`/api/git?session=${summarySession.id}&history=1`);
  assert.equal(summary.pending, true);
  assert.match(summary.summary, /documentation/);
  assert.match(summary.summary, /interface/);
  assert.match(summary.summary, /2 files/);
  assert.equal(summary.machine, 'model-a', 'summary comes from the session owner');
  const attempted = await a.request('/api/git/push?session=' + summarySession.id, 'POST', { session: summarySession.id });
  assert.equal(attempted.status, 409, 'missing project checks still prevent publication');
  const pushChat = await a.call('/api/sessions/' + summarySession.id);
  assert.ok(pushChat.events.some(e => e.type === 'user' && e.operation === 'push'));
  assert.ok(pushChat.events.some(e => e.publication === 'pushing'));
  assert.ok(pushChat.events.some(e => e.type === 'assistant' && e.operation === 'push' && /Push did not complete/.test(e.text)));
  assert.ok(!pushChat.turnHost);
  const pushRemote = path.join(root, 'push-target.git');
  git(root, 'init', '--bare', pushRemote);
  git(summaryDir, 'remote', 'add', 'origin', pushRemote);
  await fs.writeFile(path.join(work, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }));
  const published = await a.call('/api/git/push?session=' + summarySession.id, 'POST', {session:summarySession.id});
  assert.equal(published.pushed,true);
  const publishedChat = await a.call('/api/sessions/' + summarySession.id);
  assert.ok(publishedChat.events.some(e => e.type === 'assistant' && e.operation === 'push' && e.outcome === 'success' && /Push done/.test(e.text)));
  assert.ok(publishedChat.events.some(e => e.publication === 'published' && e.commitUrl !== undefined || e.pushReceipt?.status === 'Published'));
  assert.ok(!publishedChat.turnHost);
  // Another tab can absorb published work without publishing its own changes.
  const publisher = path.join(root,'publisher');
  git(root,'clone',pushRemote,publisher);
  git(publisher,'checkout','main');
  await fs.writeFile(path.join(publisher,'peer.txt'),'from peer');
  git(publisher,'add','.'); git(publisher,'commit','-m','peer update'); git(publisher,'push','origin','main');
  const remoteBeforeMerge = git(publisher,'rev-parse','HEAD').toString().trim();
  const modelCount = modelRequests.length;
  const merged = await b.call('/api/git/merge?session='+summarySession.id,'POST',{session:summarySession.id});
  assert.equal(merged.merged,true);
  assert.equal(merged.pushed,false);
  assert.equal(await fs.readFile(path.join(work,'peer.txt'),'utf8'),'from peer');
  assert.equal(modelRequests.length,modelCount,'clean merge never calls AI');
  assert.equal(git(root,'--git-dir='+pushRemote,'rev-parse','main').toString().trim(),remoteBeforeMerge);
  // Divergent changes invoke repair, but a model that only talks cannot publish.
  await fs.writeFile(path.join(work,'peer.txt'),'local intent');
  git(work,'add','.'); git(work,'commit','-m','local intent');
  await fs.writeFile(path.join(publisher,'peer.txt'),'remote intent');
  git(publisher,'add','.'); git(publisher,'commit','-m','remote intent'); git(publisher,'push','origin','main');
  const remoteConflict = git(publisher,'rev-parse','HEAD').toString().trim();
  const conflict = await a.request('/api/git/merge?session='+summarySession.id,'POST',{session:summarySession.id});
  assert.equal(conflict.status,409);
  assert.ok(modelRequests.length > modelCount,'conflict invokes configured AI');
  assert.equal(git(root,'--git-dir='+pushRemote,'rev-parse','main').toString().trim(),remoteConflict,'unresolved repair cannot publish');
  git(work,'merge','--no-edit','-X','theirs','origin/main');
  await fs.writeFile(path.join(work,'package.json'), JSON.stringify({scripts:{test:'node -e "process.exit(1)"'}}));
  const beforeCheckRepair = modelRequests.length;
  const failedChecks = await a.request('/api/git/merge?session='+summarySession.id,'POST',{session:summarySession.id});
  assert.equal(failedChecks.status,409);
  assert.ok(modelRequests.length > beforeCheckRepair,'failed configured checks invoke repair');
  assert.equal(git(root,'--git-dir='+pushRemote,'rev-parse','main').toString().trim(),remoteConflict);




  const readme = await fs.readFile(path.join(work, 'README.md'), 'utf8');
  assert.match(readme, /AI requirements/);
  assert.match(readme, /Analysis model/);
  assert.match(readme, /HARNESS_APP_AI/);
  assert.ok(!readme.includes(dependency.host), 'private machine IDs are excluded from public requirements');

  // Check the instructions actually delivered to a model by a project turn.
  const traceDir = path.join(root, 'tracing-project');
  await fs.mkdir(traceDir);
  const traceSession = await a.call('/api/sessions', 'POST', { name: 'tracing', projectDir: traceDir, mode: 'agent', model: 'model-a' });
  await a.call(`/api/sessions/${traceSession.id}/send`, 'POST', { text: 'check project tracing' });
  let traceResult;
  for (let i = 0; i < 80; i++) {
    traceResult = await a.call(`/api/sessions/${traceSession.id}`);
    if (!traceResult.busy && !traceResult.turnHost && traceResult.events.some(e => e.type === 'assistant')) break;
    await pause();
  }
  assert.ok(traceResult.events.some(e => e.type === 'assistant'));
  const traceRequest = modelRequests.find(r => r.messages.at(-1)?.content === 'check project tracing');
  assert.ok(traceRequest, 'project request reached provider');
  const instructions = traceRequest.messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
  assert.match(instructions, /Jev \(TypeSafe\)/);
  assert.match(instructions, /api\/jev\/evaluate/);
  assert.match(instructions, /Tracing for future AI work/);
  assert.match(instructions, /screen or state actually shown/);
  assert.match(instructions, /inspect the relevant recent traces before guessing/);
  assert.match(instructions, /Do not record secrets/);
  const chatRequest = modelRequests.find(r => r.messages.at(-1)?.content === 'wait');
  assert.ok(chatRequest);
  assert.doesNotMatch(JSON.stringify(chatRequest.messages), /Tracing for future AI work/);

  // Session effort is passed through unchanged; message retries do not run twice.
  await a.call(`/api/sessions/${traceSession.id}`, 'PATCH', {effort:'max'});
  const message = {text:'effort-and-idempotency',clientMessageId:'stable-message-1'};
  await Promise.all([a.call(`/api/sessions/${traceSession.id}/send`, 'POST', message),
    b.call(`/api/sessions/${traceSession.id}/send`, 'POST', message)]);
  for (let i=0;i<100;i++) {
    const current = await a.call(`/api/sessions/${traceSession.id}`);
    if (!current.busy && !current.turnHost && current.events.some(e=>e.clientMessageId === message.clientMessageId)) break;
    await pause();
  }
  await a.call(`/api/sessions/${traceSession.id}/send`, 'POST', message);
  assert.equal(modelRequests.filter(r=>r.messages.at(-1)?.content === message.text).length,1);
  assert.equal(modelRequests.find(r=>r.messages.at(-1)?.content === message.text).reasoning_effort,'max');
  assert.equal((await a.request(`/api/sessions/${traceSession.id}`, 'PATCH', {effort:'invented'})).status,400);

  const longTurn = await a.call('/api/sessions','POST',{name:'long turn',projectDir:path.join(root,'long-project'),model:'model-a',mode:'agent'});
  await a.call(`/api/sessions/${longTurn.id}/send`,'POST',{text:'continue-past-forty'});
  let longResult;
  for(let i=0;i<200;i++) {
    longResult = await a.call(`/api/sessions/${longTurn.id}`);
    if(!longResult.busy && longResult.events.some(e=>e.type === 'assistant')) break;
    await pause();
  }
  assert.equal(longResult.events.filter(e=>e.type === 'tool_result').length,41,'no hidden 40-step cutoff');
  assert.ok(longResult.events.some(e=>e.type === 'assistant' && e.text === 'model-a'));
  const rejected = await a.call('/api/sessions','POST',{name:'unsupported effort',model:'model-a',mode:'chat',projectDir:path.join(root,'unsupported-project')});
  await a.call(`/api/sessions/${rejected.id}`,'PATCH',{effort:'max'});
  await a.call(`/api/sessions/${rejected.id}/send`,'POST',{text:'unsupported-effort'});
  for(let i=0;i<100 && (await a.call(`/api/sessions/${rejected.id}`)).busy;i++) await pause();
  const rejectedRequests = modelRequests.filter(r=>r.messages.some(m=>m.content === 'unsupported-effort'));
  assert.ok(rejectedRequests.length);
  assert.ok(rejectedRequests.every(r=>r.reasoning_effort === 'max'),'never silently retry with reasoning disabled');

  // Exercise the installed Agent SDK against a deterministic CLI protocol peer.
  const configFile = path.join(a.dir,'models.json');
  const config = JSON.parse(await fs.readFile(configFile,'utf8'));
  config.models['native-test'] = {provider:'claude-cli',model:'fixture',bin:path.resolve('test/fixtures/claude-control.mjs')};
  await fs.writeFile(configFile,JSON.stringify(config));
  const native = await a.call('/api/sessions','POST',{name:'native',model:'native-test',mode:'agent',projectDir:path.join(root,'native-project')});
  await a.call(`/api/sessions/${native.id}`, 'PATCH', {effort:'max'});
  const waitQuestion = async () => {
    for(let i=0;i<100;i++) {
      const result = await b.call(`/api/sessions/${native.id}/interaction`);
      if(result.request) return result.request;
      await pause();
    }
    throw Error('Native question never reached DO');
  };
  const waitNativeDone = async count => {
    for(let i=0;i<100;i++) {
      const result = await a.call(`/api/sessions/${native.id}`);
      if(!result.busy && !result.turnHost && result.events.filter(e=>e.type === 'assistant').length >= count) return result;
      await pause();
    }
    throw Error('Native turn did not finish');
  };
  for (let turn=0;turn<2;turn++) {
    await a.call(`/api/sessions/${native.id}/send`,'POST',{text:'ask me'});
    const question = await waitQuestion();
    assert.equal(question.kind,'question');
    assert.equal((await b.request(`/api/sessions/${native.id}/interaction`,'POST',{id:question.id,allow:true,answers:{}})).status,400);
    const answer = {id:question.id,allow:true,answers:{'Which behavior?':'Keep'}};
    await b.call(`/api/sessions/${native.id}/interaction`,'POST',answer);
    assert.equal((await a.request(`/api/sessions/${native.id}/interaction`,'POST',answer)).status,409);
    const saved = await waitNativeDone(turn+1);
    const reply = JSON.parse(saved.events.findLast(e=>e.type === 'assistant').text);
    assert.equal(reply.resumed,turn === 1,'native history resumes after the first turn');
    assert.equal(reply.effort,'max');
    assert.equal(reply.answer.updatedInput.answers['Which behavior?'],'Keep');
  }
  await a.call(`/api/sessions/${native.id}/send`,'POST',{text:'ask permission'});
  const permission = await waitQuestion();
  assert.equal(permission.kind,'permission');
  const stream = await b.request(`/api/sessions/${native.id}/events`);
  const interactionReader = stream.body.getReader();
  const hello = new TextDecoder().decode((await interactionReader.read()).value);
  assert.ok(hello.includes(permission.id),'reconnected viewer receives the pending request');
  await b.call(`/api/sessions/${native.id}/interaction`,'POST',{id:permission.id,allow:false});
  let streamText = hello;
  while (!streamText.includes('"kind":"done"')) {
    const chunk = await interactionReader.read();
    if (chunk.done) break;
    streamText += new TextDecoder().decode(chunk.value);
  }
  await interactionReader.cancel();
  const liveMessages = streamText.split('\n').filter(line=>line.startsWith('data: ')).map(line=>JSON.parse(line.slice(6)));
  assert.equal(liveMessages.filter(event=>event.kind === 'delta' && event.delta.kind === 'text').length,1,'partial text is not duplicated by the final native event');
  const declined = await waitNativeDone(3);
  assert.equal(JSON.parse(declined.events.findLast(e=>e.type === 'assistant').text).answer.behavior,'deny');
  await a.call(`/api/sessions/${native.id}/send`,'POST',{text:'ask again'});
  await waitQuestion();
  await b.call(`/api/sessions/${native.id}/stop`,'POST',{});
  for(let i=0;i<100 && (await a.call(`/api/sessions/${native.id}`)).turnHost;i++) await pause();
  assert.equal((await a.call(`/api/sessions/${native.id}/interaction`)).request,null,'stop clears pending approval');

  await a.call(`/api/sessions/${s.id}`, 'DELETE');
  b.child.kill('SIGTERM');
  await b.closed;
  const unavailable = await a.request(`/api/execution-models?app=__harness&host=${b.status.self}`);
  assert.ok(!unavailable.ok, 'an offline computer never falls back to the serving computer’s models');
  const offlineApps = await a.call('/api/apps');
  const remoteProject = offlineApps.apps.find(app=>app.id === sneaker.id);
  assert.ok(remoteProject,'remote project metadata survives an offline owner');
  assert.equal(remoteProject.ownerNode,b.status.self);
  assert.equal(remoteProject.runtimeKnown,false,'local listeners do not establish remote app status');

  assert.equal((await unavailable.json()).models, undefined);
  const versionStart = Date.now();
  const offlineVersions = await a.call('/api/harness/versions');
  assert.ok(Date.now() - versionStart < 2000, 'display metadata does not wait for an offline peer timeout');
  assert.ok(offlineVersions.hosts.find(h => h.id === a.status.self).version);
  assert.ok(offlineVersions.hosts.find(h => h.id === b.status.self));
  const offlineHistory = await a.call('/api/diagnostics?action=all');
  assert.equal(offlineHistory.histories.find(h => h.host === b.status.self).unavailable, true);
  assert.ok(offlineHistory.histories.find(h => h.host === a.status.self).events.length);
  await a.call('/api/diagnostics', 'POST', {action:'settings',enabled:true,maxMB:16,days:7});
  // A compacted replica with no tail still owns recoverable history.
  a.child.kill('SIGTERM'); await a.closed;
  const raftFile = path.join(a.dir, 'cluster', 'replica.json');
  const raftDisk = JSON.parse(await fs.readFile(raftFile, 'utf8'));
  const members = [a.status.hosts[0], b.status.hosts[0]];
  const archivedState = {sessions:{saved:{id:'saved',name:'Preserve me'}}, values:{}, viewers:{},
    history:Object.fromEntries(members.map(h => [h.id,h])), preferred:a.status.self};
  const boundary = 50000, oldTerm = raftDisk.term + 10;
  Object.assign(raftDisk, {base:boundary,baseTerm:oldTerm,baseId:'old-boundary',commit:boundary,log:[],term:oldTerm});
  await fs.writeFile(raftFile,JSON.stringify(raftDisk));
  await fs.writeFile(path.join(a.dir,'cluster','snapshot.json'),JSON.stringify({index:boundary,term:oldTerm,id:'old-boundary',configuration:{members},state:archivedState}));
  await a.restart();
  assert.equal((await a.call('/api/diagnostics')).maxMB,16,'history settings survive restart');
  const snapshotResponse = await fetch(a.status.hosts[0].url + '/api/cluster/rpc', {method:'POST',
    headers:{'Content-Type':'application/json','x-cluster-key':raftDisk.secret},
    body:JSON.stringify({kind:'snapshot',from:b.status.self,term:oldTerm+10,index:boundary+1,snapTerm:oldTerm+10,snapId:'replacement',
      configuration:{members},state:{...archivedState,sessions:{}}})});
  assert.equal(snapshotResponse.status,200);
  const archives = (await fs.readdir(path.join(a.dir,'cluster'))).filter(n => n.startsWith('conflict-') && n.endsWith('-snapshot.json'));
  let preserved = false;
  for(const name of archives) {
    const saved = JSON.parse(await fs.readFile(path.join(a.dir,'cluster',name),'utf8'));
    if(saved.state.sessions.saved?.name === 'Preserve me') preserved = true;
  }
  assert.ok(preserved,'snapshot-only history must be archived before replacement');

  console.log('PASS follower-owned turns, local model inventories, SSE proxy, busy assignment guard, single-host eligibility and commands from another computer');
} finally {
  release?.();
  for (const h of hosts) if (h.child.exitCode === null && h.child.signalCode === null) h.child.kill('SIGTERM');
  await Promise.all(hosts.map(h => h.closed));
  mock.closeAllConnections(); await new Promise(r => mock.close(r));
  await fs.rm(root, { recursive: true, force: true });
}
