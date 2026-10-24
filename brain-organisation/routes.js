import {DateTime} from 'luxon';
import {createOrganisationDesk} from './desk.js';
import {createMailbox,createMailDesk} from './mailbox.js';
﻿import {createOrganisationRepository} from './repository.js';import {createOrganisationService} from './service.js';import {createCalDAV} from './caldav.js';import {createDHL} from './dhl.js';import {fail} from './model.js';import {randomUUID} from 'node:crypto';
export function registerOrganisationRoutes({app,pool,authorized,environment=process.env,repository=createOrganisationRepository(pool),calendar:calendarOverride,dhl:dhlOverride,mailbox:mailboxOverride}){
 let calendars=[];try{calendars=JSON.parse(environment.ORGANISATION_CALENDAR_URLS||'[]');if(!Array.isArray(calendars)||calendars.some(x=>typeof x!=='string'))throw Error();}catch{calendars=[];}
 let calendar;try{calendar=calendarOverride||createCalDAV({approved:environment.ORGANISATION_ICLOUD_APPROVED==='true',writeApproved:environment.ORGANISATION_CALENDAR_WRITE_APPROVED==='true',deleteApproved:environment.ORGANISATION_CALENDAR_DELETE_APPROVED==='true',username:environment.ORGANISATION_ICLOUD_USERNAME,password:environment.ORGANISATION_ICLOUD_APP_PASSWORD,allowedCalendars:calendars});}catch{calendar={configured:false,writeEnabled:false,deleteEnabled:false};}
 const dhl=dhlOverride||createDHL({approved:environment.ORGANISATION_DHL_APPROVED==='true',key:environment.ORGANISATION_DHL_API_KEY});
 const service=createOrganisationService({repository,calendar,dhl}),desk=createOrganisationDesk(repository),mailbox=mailboxOverride||createMailbox(environment),mailDesk=createMailDesk(repository,mailbox);let running=false;
 async function tick(){if(running)return;running=true;try{await service.cleanup();if(dhl.configured)await service.poll();}catch{console.error('Organisation: Hintergrundprüfung nicht verfügbar.');}finally{running=false;}}
 const timer=setInterval(tick,300000);timer.unref();
 app.all('/dashboard-api/marcel-brain/organisation',async(req,res)=>{res.setHeader('Cache-Control','no-store, private');if(!authorized(req))return res.status(401).json({ok:false,error:'Nicht autorisiert.'});try{
  if(req.method==='GET'){if(req.query.op==='export'){res.setHeader('Content-Disposition','attachment; filename="marcel-organisation-private.json"');return res.json(await service.export());}const overview=await service.overview();overview.providers.mail=mailbox.status;return res.json({ok:true,...overview});}
  if(req.method!=='POST')return res.status(405).json({ok:false,error:'Methode nicht erlaubt.'});const body=req.body||{};let result;
  if(body.op==='mailList'){
   if(body.folder==='sent'){result={local:await mailDesk.sent(),messages:[]};if(mailbox.status.configured)try{result.messages=await mailbox.list('sent');}catch(e){result.warning=e.status?e.message:'Gesendet-Ordner nicht erreichbar.';}}
   else result={local:[],messages:await mailbox.list(body.folder)};
  }
  else if(body.op==='mailRead')result=await mailbox.read(body.folder,body.id);
  else if(body.op==='mailSend')result=await mailDesk.send(body);
  else if(body.op==='deskList')result=await desk.list(body.type);
  else if(body.op==='deskSave')result=await desk.save(body);
  else if(body.op==='add')result=await service.add(body);
  else if(body.op==='poll')result=await service.poll(body.id||null);
  else if(body.op==='mailPreview')result=await service.previewMail(body.message);
  else if(body.op==='mailImport')result=await service.importMail(body);
  else if(body.op==='confirmDate')result=await service.confirmDate(body);
  else if(body.op==='automation')result=await service.configureAutomation(body);
  else if(['calendarList','calendarEvents','calendarCreate','calendarUpdate','calendarDelete'].includes(body.op)){
   if(!calendar.configured)throw fail('iCloud-Autorisierung und erlaubte Kalender fehlen.',503);
   if(body.op==='calendarList')result=await calendar.calendars();
   if(body.op==='calendarEvents')result=await calendar.events(body.calendar,{from:/^\d{4}-\d{2}-\d{2}$/.test(body.from||'')?DateTime.fromISO(body.from,{zone:'Europe/Berlin'}).toUTC().toISO():body.from,to:/^\d{4}-\d{2}-\d{2}$/.test(body.to||'')?DateTime.fromISO(body.to,{zone:'Europe/Berlin'}).toUTC().toISO():body.to,query:body.query||''});
   if(body.op==='calendarCreate')result=await calendar.create(body.calendar,body.event);
   if(body.op==='calendarUpdate')result=await calendar.update(body.calendar,body.event,body.etag);
   if(body.op==='calendarDelete')result=await calendar.remove(body.calendar,body.uid,body.etag,{approved:body.approved===true});
   if(['calendarCreate','calendarUpdate','calendarDelete'].includes(body.op))await repository.transaction(tx=>tx.put('audit',{id:randomUUID(),action:body.op,at:new Date().toISOString(),recordId:result?.uid||body.uid||body.event?.uid}));
  }else throw fail('Unbekannte Organisationsoperation.');return res.json({ok:true,result});
 }catch(e){return res.status(e.status||503).json({ok:false,error:e.status?e.message:'Organisationsspeicher nicht verfügbar. Einrichtung oder Migration prüfen.'});}});
 return{service,tick,stop:()=>clearInterval(timer)};
}
