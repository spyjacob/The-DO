import {chromium} from '../.launcher/browser-tools/node_modules/playwright/index.mjs';
import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import net from 'node:net';import {spawn} from 'node:child_process';import {once} from 'node:events';import assert from 'node:assert/strict';
const data=await fs.mkdtemp(path.join(os.tmpdir(),'do-browser-hardening-'));
const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
const origin=`http://127.0.0.1:${port}`;
const server=spawn(process.execPath,['server/index.js'],{env:{...process.env,HARNESS_PORT:String(port),HARNESS_DATA_DIR:data,HARNESS_TOKEN:'browser-fixture',ORCHESTRATOR_PUBLIC_URL:origin,ORCHESTRATOR_TAILSCALE_BIN:process.execPath,ORCHESTRATOR_TAILSCALE_SOCKET:'',NODE_OPTIONS:'--import='+path.resolve('test/fixtures/tailscale.mjs')},stdio:'ignore'});
const closed=once(server,'exit');let browser;
try {
 for(let i=0;i<100;i++){try {if((await fetch(origin+'/?t=browser-fixture')).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
 browser=await chromium.launch({executablePath:process.env.HARNESS_BROWSER_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
 for(const width of [390,1280]) {
  const page=await browser.newPage({viewport:{width,height:900}});
  const failures=[];page.on('pageerror',error=>failures.push(error.message));
  await page.goto(origin+'/?t=browser-fixture');await page.waitForTimeout(1500);
  await page.evaluate(()=>{
    state.session=tabs.chat.session={id:'fixture',model:'fixture',events:[],projectDir:'/fixture'};
    state.models={fixture:{alias:'fixture',label:'Fixture',model:'gpt-6-astra',effortCapability:{levels:['low','medium','high','xhigh','max'],source:'fixture'}}};
    state.session.effort='max';
    document.getElementById('title-sub').textContent=modelEffortLabel(state.session);
    pendingMessages.set('fixture',[{pendingId:'one',text:'A queued message with enough text to exercise the expanded preview and control layout.'}]);
    paintMessagePending();document.getElementById('pending-disclosure').open=true;
    showInteraction({id:'question',kind:'permission',tool:'Fixture',input:{path:'example.txt'},always:['Bash(npm test:*)']},'fixture');
    pendingShots=[{name:'example.txt',path:'/fixture/example.txt',mime:'text/plain',bytes:5}];paintPending();
    document.getElementById('input').value='Draft stays available while the other panels are open.';
  });
  const boxes=await page.evaluate(()=>Object.fromEntries(['message-pending','provider-interaction','pending','composer','input'].map(id=>{const r=document.getElementById(id).getBoundingClientRect();return[id,{top:r.top,bottom:r.bottom,width:r.width,height:r.height}];})));
  assert.ok(boxes['message-pending'].bottom<=boxes.input.top+1,JSON.stringify(boxes));
  assert.ok(boxes['provider-interaction'].bottom<=boxes.input.top+1,JSON.stringify(boxes));
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  // Permission prompt: allow once, always allow (naming Claude's rule), allow everything, decline.
  assert.deepEqual(await page.locator('#provider-interaction .interaction-actions button').allInnerTexts(),['allow once','always allow','allow everything','decline']);
  assert.match(await page.locator('#provider-interaction').innerText(),/Bash\(npm test:\*\)/);
  for (const b of await page.locator('#provider-interaction .interaction-actions button').all()) assert.ok((await b.boundingBox()).height>=44);
  assert.match(await page.locator('#title-sub').innerText(), /Fixture · max/);
  assert.ok(await page.locator('#title-sub').evaluate(el=>el.scrollHeight<=el.clientHeight && el.scrollWidth<=el.clientWidth));
  // Header gear: provider → model → effort; nothing is saved until the last step.
  await page.evaluate(()=>paintHeader());
  const gear=await page.locator('#model-gear').boundingBox();
  assert.ok(gear.width>=44 && gear.height>=44, JSON.stringify(gear));
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  const calls=[],patches=[],defaults=[];
  const models=[{model:'sonnet',label:'Sonnet'},{model:'opus',label:'Opus',effortCapability:{levels:['low','medium','high','max'],source:'fixture'}}];
  await page.route('**/api/cluster/sources', async route => {
    const request=route.request().postDataJSON(), action=request.action; calls.push(action);
    if (action==='default') defaults.push({alias:request.alias,effort:request.effort});
    const body=action==='discover' ? {models} : action==='add' ? {aliases:['sonnet','opus']} : action==='default' ? {default:request.alias}
      : {default:'sonnet',defaultEffort:null,machine:{id:'fixture-host',name:'Fixture Mac'},models:Object.fromEntries([...models.map(m=>[m.model,{...m,alias:m.model,provider:'claude-cli'}]),['qwen',{alias:'qwen',model:'qwen',provider:'openai',sourceKind:'ollama'}]])};
    await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
  });
  await page.route('**/api/sessions/fixture', async route => {
    if (route.request().method()!=='PATCH') return route.fallback();
    const patch=route.request().postDataJSON(); patches.push(patch);
    await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({...await page.evaluate(()=>state.session),...patch})});
  });
  await page.click('#model-gear');
  await page.locator('.wizard-steps li.on',{hasText:'Provider'}).waitFor();
  assert.deepEqual(await page.locator('#wizard-choices [data-choice] span:first-child').allInnerTexts(),['Claude','OpenAI','Local']);
  await page.click('#wizard-close');
  assert.ok(await page.locator('#sheet-back').isHidden());
  await page.click('#model-gear');
  await page.locator('[data-choice]',{hasText:'Claude'}).click();
  await page.locator('[data-choice]',{hasText:'Opus'}).waitFor();
  assert.equal(await page.locator('#wizard-choices [data-choice]').count(),2, 'local models stay out of the Claude step');
  const menu = await page.locator('#sheet').boundingBox();
  assert.ok(menu.width <= (width >= 760 ? 720 : width));
  assert.ok(menu.x >= 0 && menu.x + menu.width <= width + 1);
  await page.screenshot({path:`.launcher/model-menu-${width}.png`});
  await page.locator('[data-choice]',{hasText:'Opus'}).click();
  await page.locator('.wizard-steps li.on',{hasText:'Effort'}).waitFor();
  assert.deepEqual(await page.locator('#wizard-choices [data-choice] span:first-child').allInnerTexts(),['Default','low','medium','high','max']);
  await page.screenshot({path:`.launcher/model-effort-${width}.png`});
  const loads=calls.length;
  await page.click('#wizard-back');
  await page.locator('[data-choice]',{hasText:'Opus'}).click();
  assert.equal(calls.length,loads,'back reuses the loaded models');
  await page.click('#wizard-close');
  assert.deepEqual(patches,[],'closing mid-flow changes nothing');
  await page.click('#model-gear');
  await page.locator('[data-choice]',{hasText:'Claude'}).click();
  await page.locator('[data-choice]',{hasText:'Opus'}).click();
  await page.locator('[data-choice]',{hasText:'high'}).click();
  // Claude Code models add an Access step (permission mode).
  await page.locator('.wizard-steps li.on',{hasText:'Access'}).waitFor();
  assert.deepEqual(await page.locator('#wizard-choices [data-choice] span:first-child').allInnerTexts(),['Ask each time','Accept edits','Auto','Allow everything','Plan only']);
  await page.screenshot({path:`.launcher/model-access-${width}.png`});
  await page.locator('[data-choice]',{hasText:'Allow everything'}).click();
  await page.locator('#sheet-back').waitFor({state:'hidden'});
  assert.deepEqual(patches,[{model:'opus',effort:'high',claudePermission:'bypassPermissions'}]);
  assert.match(await page.locator('#banner').innerText(),/Now using Opus · high effort · Allow everything/);
  await page.click('#model-gear');
  await page.locator('[data-choice]',{hasText:'Local'}).click();
  await page.locator('[data-choice]',{hasText:'qwen'}).click();
  await page.locator('#sheet-back').waitFor({state:'hidden'});
  assert.deepEqual(patches.at(-1),{model:'qwen',effort:''},'no effort or access step when the model offers neither');

  // Settings → Default model runs the same flow and saves to that computer's sources.
  await page.evaluate(()=>settingsSheet());
  await page.locator('#h-default-label',{hasText:'Sonnet'}).waitFor();
  await page.click('#h-default-model');
  await page.locator('#sheet p.dim',{hasText:'Default for new sessions on Fixture Mac'}).waitFor();
  await page.locator('[data-choice]',{hasText:'Claude'}).click();
  await page.locator('[data-choice]',{hasText:'Opus'}).click();
  await page.locator('[data-choice]',{hasText:'max'}).click();
  await page.locator('#h-default-model').waitFor();
  assert.deepEqual(defaults,[{alias:'opus',effort:'max'}]);
  assert.match(await page.locator('#banner').innerText(),/New sessions on Fixture Mac start with Opus · max effort/);

  // Session sheet: name, computer, model row that opens the same flow, mode beside it.
  await page.evaluate(()=>sessionSettingsSheet());
  await page.locator('#s-choose-model').waitFor();
  assert.ok(await page.locator('[data-mode="chat"]').isVisible());
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.screenshot({path:`.launcher/session-sheet-${width}.png`});
  await page.click('#s-choose-model');
  await page.locator('.wizard-steps li.on',{hasText:'Provider'}).waitFor();
  await page.click('#wizard-close');
  await page.locator('#s-choose-model').waitFor();
  await page.evaluate(()=>closeSheet());

  // New session: the model row starts on the computer's default and its effort, and the wizard changes it.
  await page.route('**/api/execution-models*', route => route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({default:'sonnet',defaultEffort:null,
    models:{sonnet:{alias:'sonnet',label:'Sonnet',model:'sonnet',provider:'claude-cli',available:true},opus:{alias:'opus',label:'Opus',model:'opus',provider:'claude-cli',available:true,effortCapability:{levels:['low','medium','high','max']}}}})}));
  await page.evaluate(()=>{ state.machines={...state.machines,leader:state.machines?.leader}; draft={}; return newSheet(); });
  await page.locator('#n-model-label',{hasText:'Sonnet'}).waitFor();
  await page.click('#n-model');
  await page.locator('[data-choice]',{hasText:'Claude'}).click();
  await page.locator('[data-choice]',{hasText:'Opus'}).click();
  await page.locator('[data-choice]',{hasText:'medium'}).click();
  await page.locator('[data-choice]',{hasText:'Auto'}).click();
  await page.locator('#n-model-label',{hasText:'Opus · medium effort'}).waitFor();
  assert.match(await page.locator('#n-model-source').innerText(),/Auto/);
  await page.screenshot({path:`.launcher/new-session-${width}.png`});
  await page.unroute('**/api/execution-models*');
  await page.evaluate(()=>{ draft={}; closeSheet(); });

  await page.unroute('**/api/sessions/fixture');
  await page.route('**/api/sessions/fixture', route => route.request().method()==='PATCH'
    ? route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:'Wait for the current turn and integration to finish before editing this session.'})}) : route.fallback());
  await page.click('#model-gear');
  await page.locator('[data-choice]',{hasText:'Local'}).click();
  await page.locator('[data-choice]',{hasText:'qwen'}).click();
  await page.locator('#wizard-status',{hasText:'Wait for the current turn'}).waitFor();
  assert.ok(await page.locator('#sheet-back').isVisible(),'a refused switch keeps the picker open');
  await page.unroute('**/api/sessions/fixture');

  await page.unroute('**/api/cluster/sources');
  await page.route('**/api/cluster/sources',route=>route.fulfill({status:400,contentType:'application/json',body:JSON.stringify({error:'OAuth session expired'})}));
  await page.evaluate(()=>modelWizard(sessionModelTarget(state.session),{group:'claude'}));
  await page.locator('#wizard-retry').waitFor();
  assert.match(await page.locator('#wizard-recovery').innerText(),/claude auth login/);
  await page.unroute('**/api/cluster/sources');
  await page.evaluate(()=>closeSheet());

  // Pause: shown while a turn runs; the Paused bar offers Resume.
  const pauseCalls=[];
  await page.route('**/api/sessions/fixture/pause',route=>{pauseCalls.push('pause');return route.fulfill({status:200,contentType:'application/json',body:'{"ok":true,"paused":true}'});});
  await page.route('**/api/sessions/fixture/resume',route=>{pauseCalls.push('resume');return route.fulfill({status:200,contentType:'application/json',body:'{"ok":true}'});});
  await page.evaluate(()=>{ document.getElementById('input').value=''; pendingShots=[]; paintPending(); setRunning(true, Date.now()); });
  assert.ok(await page.locator('#pause').isVisible());
  assert.ok((await page.locator('#pause').boundingBox()).height>=44);
  await page.click('#pause');
  await page.locator('#paused').waitFor();
  assert.ok(await page.locator('#pause').isHidden(),'no second pause while paused');
  await page.evaluate(()=>setRunning(false));
  assert.match(await page.locator('#input').getAttribute('placeholder'),/Paused/);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.screenshot({path:`.launcher/paused-${width}.png`});
  await page.click('#resume');
  await page.locator('#paused').waitFor({state:'hidden'});
  assert.deepEqual(pauseCalls,['pause','resume']);
  await page.unroute('**/api/sessions/fixture/pause'); await page.unroute('**/api/sessions/fixture/resume');
  await page.screenshot({path:`.launcher/hardening-panels-${width}.png`});
  assert.deepEqual(failures,[]);
  console.log(JSON.stringify({width,boxes}));await page.close();
 }
} finally {await browser?.close();server.kill('SIGTERM');await closed;await fs.rm(data,{recursive:true,force:true});}
