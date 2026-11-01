#!/usr/bin/env node
// Deterministic Claude CLI control-protocol peer for real SDK/server workflows.
import readline from 'node:readline';
import fs from 'node:fs/promises';
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const session = 'be7bdebc-bf4e-4f4e-97cb-8cd836674c86';
let asked = false, promptLength, historyReadable, historyFile;
for await (const line of readline.createInterface({input:process.stdin})) {
  const message = JSON.parse(line);
  if (message.type === 'control_request') {
    send({type:'control_response',response:{subtype:'success',request_id:message.request_id,response:{commands:[],models:[],account:{},output_style:'default',available_output_styles:['default']}}});
  } else if (message.type === 'user' && !asked) {
    asked = true;
    const prompt = message.message.content;
    promptLength = typeof prompt === 'string' ? prompt.length : JSON.stringify(prompt).length;
    const file = JSON.stringify(prompt).match(/(\/[^"\\]*do-claude-history-[^"\\]*history.txt)/)?.[1];
    historyFile = file;
    historyReadable = file ? (await fs.readFile(file,'utf8')).includes('HISTORY-MARKER') : false;
    send({type:'system',subtype:'init',session_id:session,model:'fixture-claude',tools:['AskUserQuestion'],mcp_servers:[],permissionMode:'default',apiKeySource:'none',cwd:process.cwd()});
    const permission = JSON.stringify(message).includes('ask permission');
    send({type:'control_request',request_id:'permission-1',request:{subtype:'can_use_tool',tool_name:permission ? 'Bash' : 'AskUserQuestion',tool_use_id:'question-1',...(permission ? {permission_suggestions:[{type:'addRules',rules:[{toolName:'Bash',ruleContent:'echo fixture'}],behavior:'allow',destination:'localSettings'}]} : {}),input:permission ? {command:'echo fixture'} : {questions:[{question:'Which behavior?',header:'Behavior',options:[{label:'Keep',description:'Preserve it'},{label:'Change',description:'Update it'}],multiSelect:false}]}}});
  } else if (message.type === 'control_response' && message.response.request_id === 'permission-1') {
    const answer = message.response.response;
    const text = JSON.stringify({answer, promptLength, historyReadable, historyFile, resumed:process.argv.some(a=>a.startsWith('--resume=')), effort:process.argv.find(a=>a.startsWith('--effort='))?.slice(9) || (process.argv.includes('--effort') ? process.argv[process.argv.indexOf('--effort')+1] : null)});
    send({type:'stream_event',session_id:session,event:{type:'message_start'}});
    send({type:'stream_event',session_id:session,event:{type:'content_block_delta',delta:{type:'text_delta',text}}});
    send({type:'assistant',session_id:session,message:{model:'fixture-claude',content:[{type:'text',text}],usage:{input_tokens:2,output_tokens:2}}});
    send({type:'result',subtype:'success',is_error:false,session_id:session,result:text,num_turns:1,usage:{input_tokens:2,output_tokens:2},total_cost_usd:0});
    process.exit(0);
  }
}
