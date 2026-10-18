// Evaluate on a fresh about:blank page with the current Brain HTML and locally
// embedded script/style sources. All owner API calls are simulated in memory.
export async function runKnowledgeBrowserChecks(html) {
  const checks=[],writes=[];
  let pending=[{id:'fixture-personal',text:'Eine noch nicht freigegebene persönliche Testangabe.',domains:['PERSONAL_KNOWLEDGE'],project:'marcel',personal:true,reviewReason:'personal_or_sensitive',version:1}];
  window.fetch=async(input,options={})=>{
    const url=new URL(input,'http://brain-fixture.invalid');
    const reply=(status,body)=>Promise.resolve(new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}}));
    if(url.pathname!=='/api/dashboard/marcel-brain')throw Error('Unexpected network request');
    if(url.searchParams.get('resource')!=='knowledge')return reply(200,{ok:true,items:[],liveState:{}});
    const body=options.body?JSON.parse(options.body):{},op=body.op||url.searchParams.get('op');
    if(op==='overview')return reply(200,{ok:true,counts:{documents:2,entries:3,active:2,pending:pending.length},documents:[{id:'a'.repeat(64),title:'Lokaler Gold-Workflow.md',contentHash:'b'.repeat(64),status:'processed'},{id:'c'.repeat(64),title:'Fehlendes Briefing.docx',contentHash:'d'.repeat(64),status:'missing',reason:'Nicht lokal verfügbar.'}]});
    if(op==='pending')return reply(200,{ok:true,items:pending});
    if(op==='ask')return reply(200,{ok:true,answer:'Dokumentiert: Der Gold-Workflow nutzt eine manuelle Analyse und das Journal.',results:[{id:'r1',version:1,text:'Gold-Workflow',project:'trading',kind:'documented_statement',domains:['TRADING'],sources:[{title:'Lokaler Gold-Workflow.md',locator:'line:7',version:'b'.repeat(64)}]}],notice:'Nur freigegebene Quellen, keine externen KI-Aufrufe.',missingSources:['Fehlendes Briefing.docx']});
    if(op==='review'){writes.push(body);if(!body.allowPersonal)return reply(409,{ok:false,error:'Persönliche Angabe ausdrücklich freigeben.'});pending=[];return reply(200,{ok:true});}
    throw Error('Unexpected knowledge operation: '+op);
  };
  document.open();document.write(html);document.close();
  const q=s=>document.querySelector(s),wait=async fn=>{for(let i=0;i<200;i++){if(fn())return;await new Promise(r=>setTimeout(r,10));}throw Error('Brain UI timeout');};
  const check=(pass,label)=>{if(!pass)throw Error(label);checks.push(label);};
  q('[data-tab="projectKnowledge"]').click();await wait(()=>q('#knowledgeStatus').textContent.includes('2 Quellen'));
  check(q('#projectKnowledge').classList.contains('active'),'Knowledge tab loads alongside existing Brain');
  q('#knowledgeQuestion').value='Wie funktioniert der Gold-Workflow?';q('#knowledgeDomain').value='TRADING';q('#knowledgeAsk').click();await wait(()=>q('#knowledgeAnswer').textContent.includes('manuelle Analyse'));
  check(q('#knowledgeEvidence').textContent.includes('line:7'),'Answer contains source locator');
  check(q('#knowledgeNotice').textContent.includes('Fehlendes Briefing.docx'),'Missing sources stay visible');
  check(!q('#knowledgeAnswer').textContent.includes('persönliche Testangabe'),'Pending personal claim excluded from answer');
  q('#knowledgeEvidence [data-knowledge-review]').click();check(q('#knowledgeCorrection').value==='Gold-Workflow','Active document knowledge can be reviewed again');q('#knowledgeReviewClose').click();q('#knowledgePending').closest('details').open=true;q('#knowledgePending [data-knowledge-review]').click();check(q('#knowledgeReviewModal').classList.contains('open'),'Separate document review opens');
  q('[data-knowledge-action="confirm"]').click();await wait(()=>q('#knowledgeReviewStatus').textContent.includes('ausdrücklich'));
  check(pending.length===1,'Personal review requires explicit approval');
  q('#knowledgePersonalApproval').checked=true;q('[data-knowledge-action="confirm"]').click();await wait(()=>!q('#knowledgeReviewModal').classList.contains('open'));
  check(writes.at(-1).expectedVersion===1&&writes.at(-1).allowPersonal,'Review uses explicit version and consent');
  q('[data-tab="knowledge"]').click();check(q('#knowledge').classList.contains('active'),'Original personal Brain remains reachable');
  q('[data-tab="review"]').click();check(q('#review').classList.contains('active'),'Original personal review remains reachable');
  q('[data-tab="projectKnowledge"]').click();
  const rect=q('#knowledgeQuestion').getBoundingClientRect();check(rect.left>=0&&rect.right<=innerWidth+1,'Question control fits viewport');
  return {passed:checks.length,checks,viewport:innerWidth,allRequestsSimulated:true};
}
