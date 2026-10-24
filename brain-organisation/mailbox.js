import {ImapFlow} from 'imapflow';
import nodemailer from 'nodemailer';
import {simpleParser} from 'mailparser';
import {fail,short,hash} from './model.js';

const address=s=>typeof s==='string'&&/^[^\s@<>,;\r\n]+@[^\s@<>,;\r\n]+\.[^\s@<>,;\r\n]+$/.test(s);
export function createMailbox(environment=process.env,{imapFactory=options=>new ImapFlow(options),smtpFactory=options=>nodemailer.createTransport(options)}={}){
 const e=environment,host=s=>typeof s==='string'&&/^(?=.{1,253}$)[a-z0-9.-]+\.[a-z]{2,}$/i.test(s);
 const auth={user:e.ORGANISATION_MAIL_USERNAME,pass:e.ORGANISATION_MAIL_APP_PASSWORD};
 const configured=e.ORGANISATION_MAIL_APPROVED==='true'&&host(e.ORGANISATION_MAIL_IMAP_HOST)&&!!auth.user&&!!auth.pass;
 const sendEnabled=configured&&e.ORGANISATION_MAIL_SEND_APPROVED==='true'&&host(e.ORGANISATION_MAIL_SMTP_HOST)&&address(e.ORGANISATION_MAIL_FROM);
 const folders={inbox:'INBOX',sent:e.ORGANISATION_MAIL_SENT_FOLDER||'Sent'};
 const status={configured,sendEnabled,blocker:configured?null:'Mailkonto nicht verbunden. Freigegebener IMAP-Zugang und sichere Server-Konfiguration fehlen.'};
 let active=false;
 async function session(folder,fn){
  if(!configured)throw fail(status.blocker,503);
  if(!Object.hasOwn(folders,folder))throw fail('Unbekannter Mailordner.');
  if(active)throw fail('Eine Mailanfrage läuft bereits. Bitte kurz warten.',429);active=true;
  const client=imapFactory({host:e.ORGANISATION_MAIL_IMAP_HOST,port:993,secure:true,auth,logger:false,disableAutoIdle:true,connectionTimeout:12000,greetingTimeout:12000,socketTimeout:15000,tls:{rejectUnauthorized:true,minVersion:'TLSv1.2'}});
  client.on('error',()=>{});
  let lock;try{await client.connect();lock=await client.getMailboxLock(folders[folder],{readOnly:true});return await fn(client);}catch(err){if(err.status)throw err;throw fail('Mailkonto nicht erreichbar oder Anmeldung/Ordner abgelehnt. Server-Konfiguration prüfen.',502);}finally{lock?.release();client.close();active=false;}
 }
 return {status,
  async list(folder){return session(folder,async c=>{
   const total=c.mailbox.exists;if(!total)return [];
   const rows=await c.fetchAll(`${Math.max(1,total-49)}:${total}`,{envelope:true,flags:true});
   return rows.reverse().map(x=>({id:String(c.mailbox.uidValidity)+':'+x.uid,folder,title:x.envelope?.subject||'(Ohne Betreff)',from:(x.envelope?.from||[]).map(a=>a.address).join(', '),to:(x.envelope?.to||[]).map(a=>a.address).join(', '),date:x.envelope?.date?.toISOString()||null}));
  });},
  async read(folder,id){return session(folder,async c=>{
   if(typeof id!=='string'||!/^\d+:\d+$/.test(id))throw fail('Ungültige Nachrichten-ID.');
   const [validity,uid]=id.split(':');if(validity!==String(c.mailbox.uidValidity))throw fail('Mailordner wurde erneuert. Liste neu laden.',409);
   const info=await c.fetchOne(uid,{size:true},{uid:true});if(!info)throw fail('Nachricht nicht gefunden.',404);if(info.size>262144)throw fail('Diese Nachricht ist für die sichere Textansicht zu groß. Bitte im Mailclient öffnen.',413);
   const message=await c.fetchOne(uid,{source:{start:0,maxLength:262145}},{uid:true});if(!message?.source)throw fail('Nachricht nicht gefunden.',404);
   const mail=await simpleParser(message.source,{skipImageLinks:true,skipTextToHtml:true});
   return {title:String(mail.subject||'(Ohne Betreff)'),from:mail.from?.text||'',to:mail.to?.text||'',date:mail.date?.toISOString()||null,text:String(mail.text||'Keine Textversion vorhanden. Bitte im Mailclient öffnen.').slice(0,64000),attachmentCount:mail.attachments.length};
  });},
  async send(message){
   if(!sendEnabled)throw fail('E-Mail-Versand ist nicht verbunden oder nicht ausdrücklich freigegeben.',503);
   const to=String(message.to||'').split(/[,;]/).map(x=>x.trim());if(!to.length||to.length>10||to.some(x=>!address(x)))throw fail('Gültige Empfängeradressen angeben (maximal 10).');
   const transport=smtpFactory({host:e.ORGANISATION_MAIL_SMTP_HOST,port:465,secure:true,auth,tls:{rejectUnauthorized:true,minVersion:'TLSv1.2'},disableFileAccess:true,disableUrlAccess:true,logger:false,debug:false,connectionTimeout:12000,greetingTimeout:12000,socketTimeout:15000});
   try{const result=await transport.sendMail({from:e.ORGANISATION_MAIL_FROM,to,subject:short(message.title,300),text:short(message.text,64000),messageId:message.messageId});return {messageId:result.messageId,accepted:result.accepted.length,rejected:result.rejected.length};}catch{throw fail('SMTP-Ergebnis unklar. Nicht automatisch erneut senden; zuerst Gesendet im Mailkonto prüfen.',502);}finally{transport.close();}
  }
 };
}

export function createMailDesk(repository,mailbox){return {
 async sent(){return (await repository.list('settings')).filter(x=>x.id.startsWith('owner-mail-send-')).sort((a,b)=>b.date.localeCompare(a.date));},
 async send({id,version,approved}){
  if(approved!==true)throw fail('Versand dieser Nachricht ausdrücklich bestätigen.',403);
  if(!mailbox.status.sendEnabled)throw fail('E-Mail-Versand ist nicht freigegeben oder nicht konfiguriert.',503);
  if(typeof id!=='string'||!id.startsWith('owner-desk-draft-'))throw fail('Gespeicherter Entwurf erforderlich.');
  const key='owner-mail-send-'+hash(id+':'+version);
  const record=await repository.transaction(async tx=>{
   if(await tx.get('settings',key))throw fail('Dieser Entwurfsstand wurde bereits übergeben. Versandstatus prüfen; kein erneuter Versand.',409);
   const draft=await tx.get('settings',id);if(!draft||draft.version!==version)throw fail('Entwurf wurde geändert. Neu laden.',409);
   const recipients=String(draft.to||'').split(/[,;]/).map(x=>x.trim());if(recipients.length>10||recipients.some(x=>!address(x)))throw fail('Gültige Empfängeradressen angeben (maximal 10).');
   const row={id:key,title:draft.title,to:draft.to,text:draft.text,date:new Date().toISOString(),state:'pending',messageId:'<'+hash(key)+'@marcel-brain.local>'};
   await tx.put('settings',row);return row;
  });
  try{const receipt=await mailbox.send(record),item={...record,state:'accepted',receipt};await repository.put('settings',item);return item;}catch(err){await repository.put('settings',{...record,state:'uncertain'});throw fail(err.status===400?err.message:'Versandstatus unklar. Nicht erneut senden; zuerst im Mailkonto prüfen.',err.status===400?400:502);}
 }
};}
