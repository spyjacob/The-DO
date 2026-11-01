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
    showInteraction({id:'question',kind:'permission',tool:'Fixture',input:{path:'example.txt'}},'fixture');
    pendingShots=[{name:'example.txt',path:'/fixture/example.txt',mime:'text/plain',bytes:5}];paintPending();
    document.getElementById('input').value='Draft stays available while the other panels are open.';
  });
  const boxes=await page.evaluate(()=>Object.fromEntries(['message-pending','provider-interaction','pending','composer','input'].map(id=>{const r=document.getElementById(id).getBoundingClientRect();return[id,{top:r.top,bottom:r.bottom,width:r.width,height:r.height}];})));
  assert.ok(boxes['message-pending'].bottom<=boxes.input.top+1,JSON.stringify(boxes));
  assert.ok(boxes['provider-interaction'].bottom<=boxes.input.top+1,JSON.stringify(boxes));
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  assert.match(await page.locator('#title-sub').innerText(), /gpt-6-astra.*max requested/);
  assert.ok(await page.locator('#title-sub').evaluate(el=>el.scrollHeight<=el.clientHeight && el.scrollWidth<=el.clientWidth));
  await page.evaluate(()=>sessionSourceSheet(state.session));
  await page.locator('#picker-source').waitFor();
  const sourceNames=await page.locator('#picker-source').innerText();
  assert.match(sourceNames,/Claude Code/); assert.match(sourceNames,/Codex/);
  await page.route('**/api/cluster/sources', async route => {
    const action=route.request().postDataJSON().action;
    const models=[{model:'sonnet',label:'Sonnet'},{model:'opus',label:'Opus'}];
    const body=action==='discover' ? {models} : action==='add' ? {aliases:['sonnet','opus']}
      : {models:Object.fromEntries(models.map(m=>[m.model,{...m,alias:m.model,provider:'claude-cli'}]))};
    await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
  });
  await page.selectOption('#picker-source','claude-cli');
  await page.locator('[data-picker-model="opus"]').waitFor();
  assert.equal(await page.locator('[data-picker-model]').count(),2);
  const menu = await page.locator('#sheet').boundingBox();
  assert.ok(menu.width <= (width >= 760 ? 720 : width));
  assert.ok(menu.x >= 0 && menu.x + menu.width <= width + 1);
  await page.screenshot({path:`.launcher/model-menu-${width}.png`});

  await page.unroute('**/api/cluster/sources');
  await page.route('**/api/cluster/sources',route=>route.fulfill({status:400,contentType:'application/json',body:JSON.stringify({error:'OAuth session expired'})}));
  await page.evaluate(()=>sessionSourceSheet(state.session,'claude-cli'));
  await page.locator('#picker-retry').waitFor();
  assert.match(await page.locator('#picker-recovery').innerText(),/claude auth login/);
  await page.unroute('**/api/cluster/sources');
  await page.evaluate(()=>closeSheet());
  await page.screenshot({path:`.launcher/hardening-panels-${width}.png`});
  assert.deepEqual(failures,[]);
  console.log(JSON.stringify({width,boxes}));await page.close();
 }
} finally {await browser?.close();server.kill('SIGTERM');await closed;await fs.rm(data,{recursive:true,force:true});}
