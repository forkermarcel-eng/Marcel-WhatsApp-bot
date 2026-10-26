import {realpath,writeFile,mkdir,stat,readFile,mkdtemp} from 'node:fs/promises';import {resolve,sep,dirname,isAbsolute} from 'node:path';import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {createHash} from 'node:crypto';
const exec=promisify(execFile);
export const TOOL_SPECS=Object.freeze({
 'write-reviewed-artifact':{binary:null,os:['win32','linux','darwin'],effect:'write-approved-project-source',approval:'exact operation fingerprint including path and full content; never overwrite'},
 'node-check':{binary:process.execPath,os:['win32','linux','darwin'],effect:'read-project',approval:'explicit local invocation'},
 'git-status':{binary:'git',os:['win32','linux','darwin'],effect:'read-project',approval:'explicit local invocation'},
 'ffmpeg-version':{binary:'ffmpeg',os:['win32','linux','darwin'],effect:'read-runtime',approval:'explicit local invocation'},
 'ffmpeg-preview':{binary:'ffmpeg',os:['win32','linux','darwin'],effect:'write-isolated-artifact',approval:'exact operation fingerprint'},
 'ffmpeg-image-preview':{binary:'ffmpeg',os:['win32','linux','darwin'],effect:'write-isolated-artifact',approval:'exact operation fingerprint'},
 'adb-version':{binary:'adb',os:['win32','linux','darwin'],effect:'read-runtime',approval:'explicit local invocation'},
 'xcodebuild-version':{binary:'xcodebuild',os:['darwin'],effect:'read-runtime',approval:'macOS local invocation'},
 'gradle-version':{binary:'gradle',os:['win32','linux','darwin'],effect:'read-runtime',approval:'explicit local invocation'},
 'flutter-version':{binary:'flutter',os:['win32','linux','darwin'],effect:'may-start-sdk-or-update',approval:'prepared only'},
 'comfyui':{binary:null,os:['win32','linux','darwin'],effect:'local-image-workflow',approval:'prepared; licensed model weights and GPU/runtime review required'},
 'imagemagick':{binary:'magick',os:['win32','linux','darwin'],effect:'image-processing',approval:'prepared; reviewed binary and input/output scope required'},
 'gimp':{binary:null,os:['win32','linux','darwin'],effect:'image-editing',approval:'prepared; local app and automation permission required'},
 'blender':{binary:'blender',os:['win32','linux','darwin'],effect:'3d-animation-render',approval:'prepared; project/scripts and CPU/GPU budget review required'},
 'transcription':{binary:null,os:['win32','linux','darwin'],effect:'audio-transcription',approval:'prepared; engine/model weights/license not configured'},
 'ffmpeg-timeline':{binary:'ffmpeg',os:['win32','linux','darwin'],effect:'video-audio-subtitle-scene-export',approval:'prepared; complete build with required filters/codecs and a reviewed timeline required'},
 'browser-local-inspect':{binary:null,os:['win32','linux','darwin'],effect:'isolated-local-browser-render',approval:'exact operation fingerprint; reviewed browser binary and loopback project URL only'},
 'browser-mcp':{binary:null,os:['win32','linux','darwin'],effect:'browser-control',approval:'prepared; connect existing authorized MCP'},
 'desktop-adapter':{binary:null,os:['win32','linux','darwin'],effect:'desktop-control',approval:'prepared; reviewed native bridge required'}
});
export const operationFingerprint=(name,input)=>createHash('sha256').update(JSON.stringify([name,input])).digest('hex');
async function within(root,path){const base=await realpath(root),target=await realpath(resolve(base,path));if(target!==base&&!target.startsWith(base+sep))throw Error('Path leaves authorized workspace');return target;}
export async function runLocalTool({name,workspace,input={},approval,environment=process.env,signal}){
 if(environment.RAILWAY_ENVIRONMENT_ID||environment.VERCEL)throw Error('Local adapters cannot run in production hosting');
 const spec=TOOL_SPECS[name];if(!spec||!spec.os.includes(process.platform))throw Error('Tool or operating system unavailable');
 const cwd=await realpath(workspace);let args,stdin,binary=spec.binary;
 if(name.startsWith('ffmpeg-')&&environment.BRAIN_FFMPEG_PATH){
  const configured=await realpath(environment.BRAIN_FFMPEG_PATH);
  if(!/[\\/]ffmpeg(?:-win64)?(?:\.exe)?$/i.test(configured))throw Error('Configured binary must be a reviewed FFmpeg executable');
  binary=configured;
 }
 if(name==='adb-version'&&environment.BRAIN_ADB_PATH){const configured=await realpath(environment.BRAIN_ADB_PATH);if(!/[\\/]adb(?:\.exe)?$/i.test(configured))throw Error('Configured binary must be reviewed ADB');binary=configured;}
 if(name==='write-reviewed-artifact'){
  if(approval!==operationFingerprint(name,input))throw Error('Exact source artifact not approved');
  if(typeof input.path!=='string'||input.path.length>200||isAbsolute(input.path)||input.path.includes(':')||input.path.split(/[\\/]/).some(p=>!p||p==='..'||p==='.'||/^\.(?:git|env|codex|aws|ssh)/i.test(p))||typeof input.content!=='string'||Buffer.byteLength(input.content)>131072)throw Error('Bounded relative source path/content required');
  const target=resolve(cwd,input.path);let ancestor=dirname(target);for(;;){try{const actual=await realpath(ancestor);if(actual!==cwd&&!actual.startsWith(cwd+sep))throw Error('Artifact parent leaves authorized workspace');break;}catch(e){if(e.code!=='ENOENT')throw e;ancestor=dirname(ancestor);}}
  await mkdir(dirname(target),{recursive:true});await within(cwd,dirname(target));await writeFile(target,input.content,{flag:'wx',mode:0o600});return{tool:name,status:'executed',exitCode:0,path:input.path,contentHash:createHash('sha256').update(input.content).digest('hex'),automaticExecution:false};
 }else if(name==='browser-local-inspect'){

  if(approval!==operationFingerprint(name,input))throw Error('Exact local browser operation not approved');
  if(!environment.BRAIN_CHROME_PATH)throw Error('Reviewed local browser path is not configured');
  binary=await realpath(environment.BRAIN_CHROME_PATH);if(!/[\\/](?:chrome|msedge|chromium|google-chrome)(?:\.exe)?$/i.test(binary))throw Error('Reviewed Chrome/Chromium/Edge binary required');
  const url=new URL(input.url);if(!['http:','https:'].includes(url.protocol)||!['localhost','127.0.0.1','[::1]'].includes(url.hostname)||url.username||url.password)throw Error('Only explicitly approved local project URLs');
  const width=Number(input.width)||1280,height=Number(input.height)||800;if(!Number.isInteger(width)||!Number.isInteger(height)||width<320||width>2000||height<300||height>2000)throw Error('Bounded viewport required');
  const profile=await mkdtemp(resolve(cwd,'browser-review-'));args=['--headless','--disable-background-networking','--disable-extensions','--disable-sync','--no-first-run','--no-default-browser-check','--disable-background-mode','--user-data-dir='+profile,'--window-size='+width+','+height,'--dump-dom',url.href];
 }else if(name==='node-check')args=['--check',await within(cwd,input.path)];
 else if(name==='git-status')args=['status','--porcelain'];
 else if(name==='ffmpeg-version')args=['-version'];
 else if(name==='adb-version')args=['version'];
 else if(name==='xcodebuild-version')args=['-version'];
 else if(name==='gradle-version')args=['--version'];
 else if(name==='ffmpeg-preview'){
  if(approval!==operationFingerprint(name,input))throw Error('Exact local artifact operation not approved');
  // Fixed test-only generator; no arbitrary filters, input URLs, codecs or shell.
  const output=resolve(cwd,'capability-preview.mp4');try{await stat(output);throw Error('Output already exists');}catch(e){if(e.code!=='ENOENT')throw e;}
  args=['-hide_banner','-loglevel','error','-nostdin','-f','lavfi','-i','color=c=0x10243a:s=320x180:r=12','-t','1','-c:v','mpeg4','-n',output];
 }else if(name==='ffmpeg-image-preview'){
  if(approval!==operationFingerprint(name,input))throw Error('Exact local artifact operation not approved');
  const source=await within(cwd,input.path),image=await readFile(source);if(image.length>524288||image[0]!==255||image[1]!==216)throw Error('A bounded reviewed JPEG is required');
  const output=resolve(cwd,'capability-preview.webm');try{await stat(output);throw Error('Output already exists');}catch(e){if(e.code!=='ENOENT')throw e;}
  stdin=Buffer.concat(Array(12).fill(image));args=['-hide_banner','-loglevel','error','-nostdin','-f','image2pipe','-framerate','12','-c:v','mjpeg','-i','pipe:0','-t','1','-an','-vf','scale=320:-2','-c:v','libvpx-vp9','-threads','1','-n',output];
 }else throw Error('Adapter is prepared only; no executable connection approved');
 const options={cwd,timeout:name.startsWith('ffmpeg-')?30000:15000,maxBuffer:262144,windowsHide:true,shell:false,signal};
 const result=stdin?await new Promise((resolve,reject)=>{const child=execFile(binary,args,options,(e,stdout,stderr)=>e?reject(e):resolve({stdout,stderr}));child.stdin.on('error',()=>{});child.stdin.end(stdin);}):await exec(binary,args,options);return{tool:name,status:'executed',exitCode:0,stdout:result.stdout.slice(0,4000),stderr:result.stderr.slice(0,1000),scope:cwd,at:new Date().toISOString()};
}
export async function scaffoldProject({kind,workspace,name='CapabilitySample'}){
 if(process.env.RAILWAY_ENVIRONMENT_ID||process.env.VERCEL)throw Error('Local scaffolds only');if(!['android','apple','web','expo','flutter'].includes(kind)||!/^[A-Za-z][A-Za-z0-9]{2,40}$/.test(name))throw Error('Invalid scaffold');const root=await realpath(workspace),dir=resolve(root,name);await mkdir(dir);const files={
 android:{'MainActivity.kt':'package com.example.capability\nimport android.app.Activity\nimport android.os.Bundle\nimport android.widget.TextView\nclass MainActivity: Activity() { override fun onCreate(state: Bundle?) { super.onCreate(state); setContentView(TextView(this).apply { text = "Capability sample" }) } }\n','BUILD-PATH.md':'Prepared source only, not a tested Android build. Create/review the Gradle project, SDK/API target, manifest and signing separately. Build: reviewed gradlew assembleDebug; test on an authorized emulator. No SDK or wrapper installed.\n'},
 apple:{'CapabilityApp.swift':'import SwiftUI\n@main struct CapabilityApp: App { var body: some Scene { WindowGroup { Text("Capability sample").accessibilityLabel("Capability sample") } } }\n','BUILD-PATH.md':'Prepared SwiftUI source only. On macOS create/review Xcode project, bundle ID and signing; xcodebuild -list then select a simulator destination. Windows/Linux cannot validate this iOS build. XCTest/XCUITest/Instruments require the native runtime.\n'},
 expo:{'app/index.tsx':'import { Text, View } from "react-native";\nexport default function Screen(){ return <View><Text accessibilityRole="header">Capability sample</Text></View>; }\n','BUILD-PATH.md':'Prepared Expo Router screen only. Review/create the Expo TypeScript project and pinned dependencies before integrating. No npx, EAS or package install executed.\n'},
 flutter:{'main.dart':'import "package:flutter/material.dart";\nvoid main()=>runApp(const MaterialApp(home:Scaffold(body:Center(child:Text("Capability sample")))));\n','BUILD-PATH.md':'Prepared Flutter source only. A reviewed Flutter project/SDK/pubspec is required before flutter analyze/test/build. No SDK or package installation performed.\n'},
 web:{'index.html':'<!doctype html><html lang="de"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Atelier Meridian</title><link rel="stylesheet" href="style.css"><body><header>MERIDIAN / ATELIER</header><main><p>Unabhängiges Designstudio</p><h1>Räume für<br>klare Gedanken.</h1><div class="line"></div><p class="intro">Eine visuelle Studie über Rhythmus, Material und die Kraft freier Flächen.</p><button id="light" type="button">Licht wechseln</button><output id="mode" aria-live="polite">Abendlicht</output><aside>01 / STUDIE<br>FORM · LICHT · RAUM</aside></main><script src="app.js"></script></body></html>',
 'style.css':'*{box-sizing:border-box}body{margin:0;background:#18252a;color:#f5e5c8;font-family:Georgia,serif;min-height:100vh;transition:background .4s}header{font:12px system-ui;letter-spacing:.25em;padding:32px 6vw;border-bottom:1px solid #ffffff30}main{position:relative;padding:8vh 8vw;max-width:1300px}h1{font-size:clamp(3rem,8vw,7rem);font-weight:400;line-height:.97;margin:32px 0 50px}.line{height:2px;background:#c08b57;width:40%}.intro{max-width:480px;font-size:20px;line-height:1.7}button{background:#c08b57;color:#14232a;border:0;padding:16px 24px;font:600 14px system-ui;cursor:pointer}button:focus-visible{outline:3px solid white;outline-offset:4px}output{margin-left:16px;font:12px system-ui}aside{position:absolute;right:7%;top:20%;font:11px/2 system-ui;letter-spacing:.2em}body.day{background:#d8cbb8;color:#172c32}@media(max-width:650px){main{padding:6vh 7vw}aside{position:static;margin-top:40px}output{display:block;margin:16px 0}h1{font-size:16vw}}@media(prefers-reduced-motion:reduce){body{transition:none}}',
 'app.js':'document.querySelector("#light").onclick=()=>{const day=document.body.classList.toggle("day");document.querySelector("#mode").textContent=day?"Tageslicht":"Abendlicht";};\n'}
 }[kind];for(const[p,body]of Object.entries(files)){await mkdir(dirname(resolve(dir,p)),{recursive:true});await writeFile(resolve(dir,p),body,{flag:'wx'});}return{kind,directory:dir,files:Object.keys(files),status:kind==='web'?'renderable-local-artifact':'prepared-source-not-built',dependenciesInstalled:false};
}

export async function readLocalToolInput({workspace,path}){
 const file=await within(workspace,path),raw=await readFile(file);if(raw.byteLength>150000)throw Error('Tool input file too large');let value;try{value=JSON.parse(raw.toString('utf8'));}catch{throw Error('Valid reviewed tool-request JSON required');}return{path:value.path,content:value.content};
}
