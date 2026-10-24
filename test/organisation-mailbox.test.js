import test from 'node:test';
import assert from 'node:assert/strict';
import {createMailbox,createMailDesk} from '../brain-organisation/mailbox.js';
import {createOrganisationDesk} from '../brain-organisation/desk.js';
const environment={ORGANISATION_MAIL_APPROVED:'true',ORGANISATION_MAIL_SEND_APPROVED:'true',ORGANISATION_MAIL_IMAP_HOST:'imap.example.invalid',ORGANISATION_MAIL_SMTP_HOST:'smtp.example.invalid',ORGANISATION_MAIL_USERNAME:'local-fixture',ORGANISATION_MAIL_APP_PASSWORD:'synthetic-only',ORGANISATION_MAIL_FROM:'test@example.invalid'};
test('mail adapter is inert without approval, enforces TLS/read-only access, stable UIDs and safe SMTP content',async()=>{
 let connects=0,sends=0;
 const mailbox=createMailbox(environment,{
  imapFactory:options=>{assert.equal(options.secure,true);assert.equal(options.logger,false);assert.equal(options.tls.rejectUnauthorized,true);return {
   mailbox:{exists:500,uidValidity:42},on(){},async connect(){connects++;},close(){},
   async getMailboxLock(path,options){assert.equal(path,'INBOX');assert.equal(options.readOnly,true);return{release(){}};},
   async fetchAll(range){assert.equal(range,'451:500');return [{uid:9,envelope:{subject:'SYNTHETIC',from:[{address:'sender@example.invalid'}]}}];},
   async fetchOne(uid,query,options){assert.equal(uid,'9');assert.equal(options.uid,true);if(query.size)return{size:200};assert.equal(query.source.maxLength,262145);return{source:Buffer.from('From: sender@example.invalid\r\nSubject: SYNTHETIC\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nNur Testtext')};}
  };},
  smtpFactory:options=>{assert.equal(options.secure,true);assert.equal(options.disableFileAccess,true);assert.equal(options.disableUrlAccess,true);return{close(){},async sendMail(message){sends++;assert.equal(message.html,undefined);assert.equal(message.attachments,undefined);assert.equal(message.from,'test@example.invalid');return {messageId:'fixture',accepted:['to@example.invalid'],rejected:[]};}};}
 });
 assert.equal((await mailbox.list('inbox'))[0].id,'42:9');
 assert.equal((await mailbox.read('inbox','42:9')).text,'Nur Testtext');
 await assert.rejects(()=>mailbox.read('inbox','41:9'),{status:409});
 await assert.rejects(()=>mailbox.list('../../private'),{status:400});
 await mailbox.send({to:'to@example.invalid',title:'Test',text:'SYNTHETIC'});assert.equal(sends,1);
 const disabled=createMailbox({}, {imapFactory:()=>{throw Error('must not connect')}});
 await assert.rejects(()=>disabled.list('inbox'),{status:503});await assert.rejects(()=>disabled.send({}),{status:503});
 assert.equal(connects,3);
});
test('SMTP handoff requires explicit confirmation and never automatically repeats accepted or uncertain drafts',async()=>{
 const rows=new Map(),repo={async get(k,id){return rows.get(id)},async list(){return [...rows.values()]},async put(k,row){rows.set(row.id,row);return row},async transaction(fn){return fn(repo)}};
 const desk=createOrganisationDesk(repo);let sends=0;
 const mail=createMailDesk(repo,{status:{sendEnabled:true},send:async()=>{sends++;return{accepted:1,rejected:0}}});
 const draft=await desk.save({type:'draft',title:'Test',to:'to@example.invalid',text:'Synthetic'});
 await assert.rejects(()=>mail.send({...draft}),{status:403});assert.equal(sends,0);
 await mail.send({id:draft.id,version:draft.version,approved:true});assert.equal(sends,1);
 const unchanged=await desk.save({...draft,type:'draft'});assert.equal(unchanged.version,draft.version);
 await assert.rejects(()=>mail.send({...unchanged,approved:true}),{status:409});assert.equal(sends,1);
 const next=await desk.save({...draft,type:'draft',title:'Separater Test'});
 const uncertain=createMailDesk(repo,{status:{sendEnabled:true},send:async()=>{sends++;throw Error('provider secret must not escape')}});
 await assert.rejects(()=>uncertain.send({...next,approved:true}),e=>e.status===502&&!e.message.includes('secret'));
 await assert.rejects(()=>uncertain.send({...next,approved:true}),{status:409});assert.equal(sends,2);
 assert.equal((await mail.sent()).length,2);
});
