// Browser-only regression harness. Start on a fresh about:blank document, then
// inject with the scoped browser-evaluate API. No application server is started.
// The current HTML is supplied by the caller; all fetches stay in RAM.
export async function installDashboardFixture(html, { getMode = "ok" } = {}) {
  const contact={id:101,displayName:"Testkontakt",city:"Teststadt",country:"Deutschland",language:"Deutsch",sourcePlatform:"whatsapp",jid:"fixture@example.invalid"};
  const detail={ok:true,contact,profile:{},messages:[{id:1,direction:"incoming",text:"Simulierte Chatnachricht",translationDe:"Simulierte Chatnachricht"}],totalMessages:1,activeItems:[],historicalItems:[],events:[],identities:[],media:[]};
  const state={items:[{id:11,category:"preferences",key:"favorite_food",value:{name:"Testgericht"},importance:2,humanVerified:false},{id:12,category:"communication",key:"contact_style",value:{description:"Testregel"},importance:3,humanVerified:true}],posts:[],getMode,postMode:"ok",countOverride:null,pendingGet:null,pendingPost:null,holdNext:false,unexpected:[],errors:[],detail,contact};
  window.__brainFixture=state;
  window.confirm=()=>state.acceptReject!==false;
  window.fetch=async(input,options={})=>{
    const url=new URL(String(input),"http://marcel-dashboard.test"),method=options.method||"GET";
    const response=(status,body)=>new Response(JSON.stringify(body),{status,headers:{"Content-Type":"application/json"}});
    if(url.pathname==="/api/dashboard/contacts")return response(200,url.searchParams.has("id")?detail:{ok:true,contacts:[contact]});
    if(url.pathname!=="/api/dashboard/marcel-brain"){state.unexpected.push(method+" "+url.pathname);throw Error("Unexpected mock request");}
    if(method==="POST"){
      const p=JSON.parse(options.body);state.posts.push(p);
      if(state.postMode==="hold")return new Promise(resolve=>{state.pendingPost=()=>resolve(response(200,{ok:true,message:"Simuliert gespeichert"}));});
      if(state.postMode==="fail")return response(503,{error:"Simulierter Speicherfehler"});
      const item=state.items.find(x=>x.id===p.memoryId);
      if(p.action==="reject")state.items=state.items.filter(x=>x!==item);
      else{item.humanVerified=true;if(p.action==="correct")item.value={description:p.correctionDe};}
      return response(200,{ok:true,message:"Simuliert gespeichert"});
    }
    const result=()=>response(200,{ok:true,reviewRequired:state.countOverride??state.items.filter(x=>!x.humanVerified).length,items:state.items,liveState:{}});
    if(state.holdNext){state.holdNext=false;return new Promise(resolve=>{state.pendingGet=(fail=false)=>resolve(fail?response(503,{error:"Veralteter Request"}):result());});}
    if(state.getMode==="network")throw TypeError("Simulierter Netzwerkausfall");
    if(state.getMode==="invalid")return new Response("kein JSON");
    if(state.getMode==="fail")return response(503,{error:"Simulierter Verbindungsfehler"});
    return result();
  };
  document.open();document.write(html);document.close();
  window.addEventListener("error",event=>state.errors.push(event.message));
  window.addEventListener("unhandledrejection",event=>state.errors.push(String(event.reason)));
  return {mocked:true};
}

export async function runDashboardBrainDOMChecks() {
  const s=window.__brainFixture,checks=[],q=selector=>document.querySelector(selector),click=selector=>q(selector).click();
  const wait=async predicate=>{for(let i=0;i<250;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,10));}throw Error("Fixture timeout");};
  const ready=()=>wait(()=>q("#marcelBrainBtn").getAttribute("aria-busy")==="false");
  const reviewClosed=()=>wait(()=>!q("#marcelReviewModal").classList.contains("open"));
  const check=(value,label)=>{if(!value)throw Error(label);checks.push(label);};
  await ready();await wait(()=>q("#messages").textContent.includes("Simulierte Chatnachricht"));
  check(q("#brainBadge").textContent==="1","Offener Review-Zähler aus API");
  check(q("#marcelBrainBtn").textContent.includes("\u{1f451}"),"Crown glyph preserved as Unicode");
  check(q("#marcelBrainBtn").tagName==="BUTTON","Krone ist nativer Tastatur-Button");
  const links=[...document.querySelectorAll(".platformNav a")].map(x=>x.getAttribute("href"));
  check(links.join("|")==="/Hub/|/Dashboard/|/Tinder/|/Instagram/|/X/|/Brain/|/Trading/|/Kontakte/|/Analyse/|/Einstellungen/","Alle Navigationsziele erhalten");
  s.holdNext=true;click("#marcelBrainBtn");await wait(()=>s.pendingGet);
  check(q("#marcelBrainModal").classList.contains("open")&&q("#marcelBrainContent").textContent.includes("wird geladen"),"Dialog sofort mit Ladeanzeige geöffnet");
  s.pendingGet();s.pendingGet=null;await ready();
  check(document.querySelectorAll("[data-marcel-memory-id]").length===2,"Offene und bestätigte Fakten prüfbar");
  click('[data-marcel-memory-id="11"]');click("#marcelConfirmBtn");await reviewClosed();
  check(s.posts.at(-1).action==="confirm"&&s.posts.at(-1).memoryId===11&&q("#brainBadge").textContent==="0","Bestätigen und Zähleraktualisierung");
  click('[data-marcel-memory-id="12"]');const beforeEmpty=s.posts.length;click("#marcelCorrectBtn");
  check(s.posts.length===beforeEmpty&&q("#marcelReviewResult").textContent.includes("richtige Information"),"Leere Korrektur verhindert Request");
  q("#marcelCorrection").value="Korrigierte Testregel";click("#marcelCorrectBtn");await reviewClosed();
  check(s.posts.at(-1).action==="correct"&&s.posts.at(-1).memoryId===12&&s.posts.at(-1).correctionDe==="Korrigierte Testregel"&&q("#marcelBrainContent").textContent.includes("Korrigierte Testregel"),"Bestätigten Fakt erneut korrigieren");
  click('[data-marcel-memory-id="12"]');s.acceptReject=false;const beforeReject=s.posts.length;click("#marcelRejectBtn");
  check(s.posts.length===beforeReject,"Abgebrochenes Ablehnen schreibt nichts");
  s.acceptReject=true;click("#marcelRejectBtn");await reviewClosed();
  check(s.posts.at(-1).action==="reject"&&!q('[data-marcel-memory-id="12"]'),"Ablehnen entfernt Fakt nach Reload");
  click('[data-marcel-memory-id="11"]');s.postMode="fail";click("#marcelConfirmBtn");await wait(()=>q("#marcelReviewResult").textContent.includes("Simulierter Speicherfehler"));
  check(q("#marcelReviewModal").classList.contains("open")&&!q("#marcelConfirmBtn").disabled,"Speicherfehler sichtbar und erneuter Versuch möglich");
  s.postMode="hold";const beforeDouble=s.posts.length;click("#marcelConfirmBtn");await wait(()=>s.pendingPost);click("#marcelConfirmBtn");click("#marcelConfirmBtn");
  check(s.posts.length===beforeDouble+1&&q("#marcelConfirmBtn").disabled,"Doppelklickschutz");
  s.pendingPost();s.pendingPost=null;s.postMode="ok";await reviewClosed();click('[data-close="marcelBrainModal"]');
  for(const mode of ["fail","network","invalid"]){s.getMode=mode;click("#marcelBrainBtn");await ready();check(q("#marcelBrainContent [role=alert]")&&q("#brainBadge").textContent==="!",mode+": Ladefehler statt falschem Null-Zähler");s.getMode="ok";click("#brainRetry");await ready();check(document.querySelectorAll("[data-marcel-memory-id]").length===1&&q("#brainLoadStatus").textContent==="",mode+": Wiederholen erfolgreich");click('[data-close="marcelBrainModal"]');}
  s.countOverride=123;click("#marcelBrainBtn");await ready();check(q("#brainBadge").textContent==="99+","Großer Zähler kompakt");click('[data-close="marcelBrainModal"]');s.countOverride=null;
  // Two overlapping opens must not let a stale response replace fresh data.
  s.holdNext=true;click("#marcelBrainBtn");await wait(()=>s.pendingGet);click("#marcelBrainBtn");await ready();s.pendingGet(true);s.pendingGet=null;await new Promise(resolve=>setTimeout(resolve,30));
  check(q("#brainBadge").textContent==="0"&&q("#brainLoadStatus").textContent==="","Veraltete Antwort überschreibt neuen Bestand nicht");click('[data-close="marcelBrainModal"]');
  check(q("#messages").textContent.includes("Simulierte Chatnachricht")&&q("#contacts").textContent.includes("Testkontakt"),"Chat und Kontaktliste erhalten");
  q("#search").value="Kein Treffer";q("#search").dispatchEvent(new Event("input"));check(!q("#contacts .contact"),"Kontaktsuche filtert");q("#search").value="";q("#search").dispatchEvent(new Event("input"));
  click("#add");check(q("#addModal").classList.contains("open"),"Kontakt hinzufügen öffnet");click('[data-close="addModal"]');
  click("#profilePhoto");check(q("#fullProfileModal").classList.contains("open"),"Kontaktprofil öffnet");click('[data-close="fullProfileModal"]');
  check(s.errors.length===0,"Keine JavaScript-Laufzeitfehler");check(s.unexpected.length===0,"Keine ungeplanten Netzwerkzugriffe");
  check(s.posts.every(p=>["confirm","correct","reject"].includes(p.action)&&[11,12].includes(p.memoryId)),"Nur simulierte Review-Schreibaktionen");
  s.domChecks=checks;return {passed:checks.length,checks,simulatedReviewRequests:s.posts.length};
}

export async function checkInitialBrainFailure() {
  const q = selector => document.querySelector(selector);
  for (let i=0;i<250&&q("#marcelBrainBtn").getAttribute("aria-busy")!=="false";i++) await new Promise(resolve=>setTimeout(resolve,10));
  if(q("#brainBadge").textContent!=="!"||!q("#brainLoadStatus").classList.contains("error"))throw Error("Background failure not visible");
  if(q("#marcelBrainModal").classList.contains("open"))throw Error("Background failure unexpectedly opened modal");
  if(!q("#messages").textContent.includes("Simulierte Chatnachricht"))throw Error("Brain failure blocked chat");
  if(window.__brainFixture.posts.length)throw Error("Background failure caused a write");
  return {backgroundFailureVisible:true,dialogClosed:true,chatWorking:true,noWrites:true};
}

export async function checkCentralContacts() {
  const q = selector => document.querySelector(selector);
  const wait=async predicate=>{for(let i=0;i<250;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,10));}throw Error("Contact fixture timeout");};
  await wait(()=>q('#list [data-id="101"]'));
  q('[data-filter="whatsapp"]').click();
  if(!q('#list [data-id="101"]'))throw Error("WhatsApp filter lost contact");
  q('[data-filter="tinder"]').click();
  if(q('#list [data-id="101"]'))throw Error("Tinder filter includes unrelated contact");
  q('[data-filter="all"]').click();q('#list [data-id="101"]').click();
  await wait(()=>q("#detail").classList.contains("open"));
  if(!q("#detail").textContent.includes("Testkontakt"))throw Error("Contact detail missing");
  const edit=q('#detail a[href="/Dashboard/?view=edit-contact&contact=101"]');
  if(!edit)throw Error("Existing edit navigation missing");
  q("#closeProfile").click();
  if(q("#detail").classList.contains("open"))throw Error("Contact profile did not close");
  if(window.__brainFixture.posts.length||window.__brainFixture.unexpected.length||window.__brainFixture.errors.length)throw Error("Unexpected contact side effect or error");
  return {list:true,channelFilters:true,detail:true,editNavigation:true,close:true,noWrites:true};
}

export async function checkDashboardBrainLayout() {
  const button=document.getElementById("marcelBrainBtn"),box=button.getBoundingClientRect(),width=innerWidth;
  const inside=rect=>rect.left>=0&&rect.right<=width+1;
  if(!inside(box)||box.height<36)throw Error("Crown outside viewport: "+width);
  button.click();for(let n=0;n<200&&button.getAttribute("aria-busy")!=="false";n++)await new Promise(resolve=>setTimeout(resolve,10));
  const modal=document.querySelector("#marcelBrainModal .modal").getBoundingClientRect();if(!inside(modal))throw Error("Dialog outside viewport: "+width);
  document.querySelector("[data-marcel-memory-id]").click();
  for(const id of ["marcelConfirmBtn","marcelCorrectBtn","marcelRejectBtn"]){const rect=document.getElementById(id).getBoundingClientRect();if(!inside(rect)||rect.height===0)throw Error("Review action inaccessible: "+id);}
  document.querySelector('[data-close="marcelReviewModal"]').click();document.querySelector('[data-close="marcelBrainModal"]').click();
  if(width<=820){document.getElementById("platformToggle").click();const nav=document.querySelector('.platformNav a[href="/Brain/"]');if(nav.getBoundingClientRect().height===0)throw Error("Mobile Brain navigation hidden");document.getElementById("platformToggle").click();}
  return {width,buttonInside:true,dialogInside:true,allReviewActionsVisible:true,navigation:true};
}
