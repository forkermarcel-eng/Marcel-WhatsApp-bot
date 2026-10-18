/* Brain-only decorative portal. No news, geocoder, camera or selection state is shared. */
import * as THREE from './vendor/three.module.min.js';
const root=document.getElementById('brainChat'),panel=root.querySelector('.globe-panel');
const reduced=matchMedia('(prefers-reduced-motion:reduce)'),small=matchMedia('(max-width:720px)'),motion=document.getElementById('sceneMotion');
const economy=small.matches||navigator.connection?.saveData===true||(navigator.hardwareConcurrency||8)<=4;
const wrapper=document.createElement('section');wrapper.className='brain-hologram';
wrapper.innerHTML='<div class="holo-heading"><span>VERNETZTE PERSPEKTIVEN</span><h3>Dein Zugang zur Welt</h3></div><button class="holo-open" aria-label="Holografische Weltkugel – Welt und Nachrichten öffnen"><span class="holo-fallback" aria-hidden="true"></span><span class="holo-orbit" aria-hidden="true"></span></button><div class="holo-caption" aria-hidden="true"><span>Welt &amp; News entdecken</span><span>↗</span></div><span class="holo-status" role="status"></span>';
panel.append(wrapper);const button=wrapper.querySelector('button'),status=wrapper.querySelector('.holo-status');
const svgNS='http://www.w3.org/2000/svg',energy=document.createElementNS(svgNS,'svg');energy.classList.add('brain-energy');energy.setAttribute('aria-hidden','true');root.prepend(energy);
const paths=[],sparks=[],particles=[];let seed=814;const random=()=>{seed=(seed*1664525+1013904223)>>>0;return seed/4294967296;};
for(let i=0;i<3;i++){const path=document.createElementNS(svgNS,'path');path.setAttribute('fill','none');path.setAttribute('stroke',['#27bfff','#936aff','#e8b777'][i]);path.setAttribute('stroke-width',i===0?'1.15':'.7');path.setAttribute('opacity',i===0?'.35':'.24');energy.append(path);paths.push(path);
 for(let j=0;j<2;j++){const dot=document.createElementNS(svgNS,'circle');dot.setAttribute('r',j?'1.8':'2.7');dot.setAttribute('fill',['#7fe9ff','#b299ff','#ffca84'][i]);dot.classList.add('energy-spark');energy.append(dot);sparks.push({dot,lane:i,phase:j*.5+i*.19});}}
for(let i=0;i<34;i++){const dot=document.createElementNS(svgNS,'circle');dot.setAttribute('r',String(i%9===0?1.4:.65));dot.setAttribute('fill',i%11===0?'#eeb36a':i%3===0?'#8d78e5':'#3b9bca');dot.setAttribute('opacity',String(.18+random()*.36));energy.prepend(dot);particles.push({dot,x:random(),y:random(),phase:random()*6.3});}
let renderer,scene,camera,globe,dust,pulseGeometry,pulsePositions,pulsePaths=[],fallback,coasts=[],frame=0,last=0,time=0,frames=0,active=false,intersecting=true,onScreen=true,paused=false,hover=false,opening=0,disposed=false,links=[];
const vector=(lat,lon,r=1)=>new THREE.Vector3(Math.cos(lat*Math.PI/180)*Math.sin(lon*Math.PI/180)*r,Math.sin(lat*Math.PI/180)*r,Math.cos(lat*Math.PI/180)*Math.cos(lon*Math.PI/180)*r);
const moving=()=>!reduced.matches&&motion.getAttribute('aria-pressed')!=='true';
function connections(){const area=root.getBoundingClientRect(),brain=document.getElementById('brainStage').getBoundingClientRect(),earth=button.getBoundingClientRect();if(!area.width||!earth.width)return;
 energy.setAttribute('viewBox',`0 0 ${area.width} ${area.height}`);links=[];
 for(let i=0;i<3;i++){const a={x:brain.left-area.left+brain.width*.72,y:brain.top-area.top+brain.height*(.38+i*.11)},b={x:earth.left-area.left+earth.width*.28,y:earth.top-area.top+earth.height*(.42+i*.08)};
 const c={x:a.x+(b.x-a.x)*.4,y:a.y-55-i*12},d={x:a.x+(b.x-a.x)*.72,y:b.y+65-i*20};links.push([a,c,d,b]);paths[i].setAttribute('d',`M${a.x},${a.y} C${c.x},${c.y} ${d.x},${d.y} ${b.x},${b.y}`);}
 for(const p of particles){p.dot.setAttribute('cx',String(p.x*area.width));p.dot.setAttribute('cy',String(45+p.y*Math.max(100,area.height-280)));}
}
function renderEnergy(){for(const s of sparks){const [a,b,c,d]=links[s.lane]||[];if(!a)continue;const t=(time*.045+s.phase)%1,q=1-t;s.dot.setAttribute('cx',String(q*q*q*a.x+3*q*q*t*b.x+3*q*t*t*c.x+t*t*t*d.x));s.dot.setAttribute('cy',String(q*q*q*a.y+3*q*q*t*b.y+3*q*t*t*c.y+t*t*t*d.y));}
 for(const p of particles)p.dot.style.transform=`translate(${Math.sin(time*.08+p.phase)*5}px,${Math.cos(time*.06+p.phase)*6}px)`;
}
function visible(){return !disposed&&onScreen&&root.dataset.scene==='brain'&&root.classList.contains('active')&&!document.hidden;}
function schedule(){cancelAnimationFrame(frame);frame=0;active=visible();paused=!moving();root.classList.toggle('holo-still',paused||!active);if(!active)return;last=performance.now();frame=requestAnimationFrame(render);}
function render(now){frame=0;if(!visible())return;const dt=Math.min((now-last)/1000,.1);if(now-last<1000/(fallback?12:small.matches||economy?20:24)){frame=requestAnimationFrame(render);return;}last=now;if(!paused)time+=dt;renderEnergy();
 if(renderer&&intersecting){globe.rotation.set(.12,time*.055-.38,-.08);globe.scale.lerp(new THREE.Vector3().setScalar(hover?1.025:1),.08);dust.rotation.y=time*.012;
  for(let i=0;i<pulsePaths.length;i++){const {a,b,phase}=pulsePaths[i],t=(time*.055+phase)%1;const p=a.clone().lerp(b,t).normalize().multiplyScalar(1.012+Math.sin(t*Math.PI)*.16);pulsePositions.set(p.toArray(),i*3);}pulseGeometry.attributes.position.needsUpdate=true;renderer.render(scene,camera);frames++;
 }else if(fallback&&intersecting)drawFallback();
 if(!paused&&(!small.matches||intersecting))frame=requestAnimationFrame(render);
}
function resize(){if(!visible())return;const {width,height}=button.getBoundingClientRect();if(!width||!height)return;connections();if(renderer){renderer.setSize(width,height,false);camera.aspect=width/height;camera.updateProjectionMatrix();camera.position.z=3.15*Math.max(1,.95/camera.aspect);}if(fallback){fallback.width=Math.round(width);fallback.height=Math.round(height);}schedule();}
function drawFallback(){const ctx=fallback.getContext('2d'),w=fallback.width,h=fallback.height,r=Math.min(w,h)*.38;ctx.clearRect(0,0,w,h);ctx.save();ctx.translate(w/2,h/2);ctx.strokeStyle='#2588b9';ctx.lineWidth=.7;ctx.beginPath();ctx.arc(0,0,r,0,Math.PI*2);ctx.stroke();const angle=time*.055-.38;
 const project=(lat,lon)=>{const a=lat*Math.PI/180,b=lon*Math.PI/180+angle;return[Math.cos(a)*Math.sin(b)*r,-Math.sin(a)*r,Math.cos(a)*Math.cos(b)];};
 for(const ring of coasts){ctx.beginPath();let pen=false;for(const [lon,lat]of ring){const [x,y,z]=project(lat,lon);if(z<0){pen=false;continue;}if(pen)ctx.lineTo(x,y);else ctx.moveTo(x,y);pen=true;}ctx.stroke();}
 for(let i=-2;i<=2;i++){ctx.beginPath();ctx.ellipse(0,0,r*(.1+Math.abs(i)*.36),r,0,0,Math.PI*2);ctx.stroke();}ctx.restore();frames++;
}
function useFallback(){cancelAnimationFrame(frame);renderer?.domElement.remove();renderer?.dispose();renderer=null;fallback=document.createElement('canvas');fallback.setAttribute('aria-hidden','true');button.prepend(fallback);wrapper.dataset.renderer='fallback';status.textContent='Vereinfachte Lichtansicht';resize();}
button.addEventListener('mouseenter',()=>{hover=true;if(paused)schedule();});button.addEventListener('mouseleave',()=>{hover=false;if(paused)schedule();});button.addEventListener('focus',()=>{hover=true;if(paused)schedule();});button.addEventListener('blur',()=>{hover=false;if(paused)schedule();});
button.onclick=()=>{if(opening||!visible())return;wrapper.classList.add('holo-opening');opening=setTimeout(()=>{opening=0;wrapper.classList.remove('holo-opening');if(root.dataset.scene==='brain')window.MarcelBrainScenes.open('world');},reduced.matches?0:240);};
new ResizeObserver(resize).observe(button);new ResizeObserver(connections).observe(root);new IntersectionObserver(entries=>{intersecting=entries[0].isIntersecting;schedule();}).observe(button);
new IntersectionObserver(entries=>{onScreen=entries[0].isIntersecting;schedule();}).observe(root);
new MutationObserver(schedule).observe(motion,{attributes:true,attributeFilter:['aria-pressed']});new MutationObserver(()=>{resize();schedule();}).observe(root,{attributes:true,attributeFilter:['data-scene','class']});
document.addEventListener('brain-world-view',()=>{resize();schedule();});document.addEventListener('brain-scene-visible',schedule);document.addEventListener('visibilitychange',schedule);reduced.addEventListener('change',schedule);small.addEventListener('change',resize);window.addEventListener('pageshow',schedule);
window.addEventListener('pagehide',event=>{cancelAnimationFrame(frame);clearTimeout(opening);if(event.persisted)return;disposed=true;scene?.traverse(o=>{o.geometry?.dispose();o.material?.dispose();});renderer?.dispose();});
window.MarcelBrainHologram=Object.freeze({getState:()=>({renderer:wrapper.dataset.renderer||'loading',time,frames,running:!!frame&&visible()&&!paused,paused,visible:visible(),rotation:globe?.rotation.y??time*.055-.38,newsMarkers:0,connections:links.length})});
try{const data=await(await fetch(new URL('./assets/earth-land.geojson',import.meta.url))).json();for(const feature of data.features){const polygons=feature.geometry.type==='MultiPolygon'?feature.geometry.coordinates:[feature.geometry.coordinates];for(const polygon of polygons)coasts.push(...polygon);}}catch{status.textContent='Kontinentkonturen derzeit nicht verfügbar';}
try{
 renderer=new THREE.WebGLRenderer({alpha:true,antialias:true,powerPreference:'low-power'});renderer.setPixelRatio(Math.min(devicePixelRatio||1,economy?1:1.25));renderer.setClearColor(0,0);renderer.domElement.setAttribute('aria-hidden','true');button.prepend(renderer.domElement);
 scene=new THREE.Scene();camera=new THREE.PerspectiveCamera(42,1,.1,20);globe=new THREE.Group();scene.add(globe);camera.position.z=3.15;
 const surface=new THREE.Mesh(new THREE.SphereGeometry(.995,48,32),new THREE.MeshBasicMaterial({color:'#035b97',transparent:true,opacity:.075,depthWrite:false}));globe.add(surface);
 const material=new THREE.LineBasicMaterial({color:'#3fd8ff',transparent:true,opacity:.65,blending:THREE.AdditiveBlending,depthWrite:false});const points=[];
 for(const ring of coasts)for(let i=1;i<ring.length;i++){points.push(...vector(ring[i-1][1],ring[i-1][0],1.002).toArray(),...vector(ring[i][1],ring[i][0],1.002).toArray());}
 globe.add(new THREE.LineSegments(new THREE.BufferGeometry().setAttribute('position',new THREE.Float32BufferAttribute(points,3)),material));
 const grid=[];for(let lat=-60;lat<=60;lat+=30)for(let lon=-180;lon<180;lon+=4)grid.push(...vector(lat,lon).toArray(),...vector(lat,lon+4).toArray());for(let lon=-180;lon<180;lon+=30)for(let lat=-90;lat<90;lat+=4)grid.push(...vector(lat,lon).toArray(),...vector(lat+4,lon).toArray());
 globe.add(new THREE.LineSegments(new THREE.BufferGeometry().setAttribute('position',new THREE.Float32BufferAttribute(grid,3)),new THREE.LineBasicMaterial({color:'#547ce2',transparent:true,opacity:.12,depthWrite:false,blending:THREE.AdditiveBlending})));
 globe.add(new THREE.Mesh(new THREE.SphereGeometry(1.008,48,32),new THREE.ShaderMaterial({transparent:true,depthWrite:false,blending:THREE.AdditiveBlending,vertexShader:'varying vec3 n;varying vec3 v;void main(){vec4 p=modelViewMatrix*vec4(position,1.);n=normalize(normalMatrix*normal);v=normalize(-p.xyz);gl_Position=projectionMatrix*p;}',fragmentShader:'varying vec3 n;varying vec3 v;void main(){float rim=pow(1.-abs(dot(normalize(n),normalize(v))),3.);gl_FragColor=vec4(.07,.45,1.,rim*.24);}'})));
 const pulseColors=[],anchors=[];for(let i=0;i<12;i++){const ring=coasts[Math.floor(random()*coasts.length)],other=coasts[Math.floor(random()*coasts.length)];const first=ring?.[Math.floor(random()*ring.length)]||[i*30,20],second=other?.[Math.floor(random()*other.length)]||[i*30+45,-15];const a=vector(first[1],first[0]),b=vector(second[1],second[0]);if(a.dot(b)<-.65){i--;continue;}const color=new THREE.Color(i%6===0?'#ffc784':i%3===0?'#a67aff':'#27baff'),arc=[];
  for(let j=0;j<=48;j++){const t=j/48;arc.push(a.clone().lerp(b,t).normalize().multiplyScalar(1.012+Math.sin(t*Math.PI)*.16));}globe.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(arc),new THREE.LineBasicMaterial({color,transparent:true,opacity:i%6===0?.3:.22,depthWrite:false,blending:THREE.AdditiveBlending})));pulsePaths.push({a,b,phase:random()});pulseColors.push(...color.toArray());anchors.push(...a.clone().multiplyScalar(1.012).toArray());
 }
 pulsePositions=new Float32Array(pulsePaths.length*3);pulseGeometry=new THREE.BufferGeometry().setAttribute('position',new THREE.BufferAttribute(pulsePositions,3)).setAttribute('color',new THREE.Float32BufferAttribute(pulseColors,3));
 const dots=new THREE.ShaderMaterial({transparent:true,depthWrite:false,blending:THREE.AdditiveBlending,vertexShader:'attribute vec3 color;varying vec3 c;void main(){c=color;vec4 p=modelViewMatrix*vec4(position,1.);gl_Position=projectionMatrix*p;gl_PointSize=22./-p.z;}',fragmentShader:'varying vec3 c;void main(){float d=length(gl_PointCoord-.5)*2.;gl_FragColor=vec4(c,pow(max(0.,1.-d),2.));}'});
 globe.add(new THREE.Points(pulseGeometry,dots));globe.add(new THREE.Points(new THREE.BufferGeometry().setAttribute('position',new THREE.Float32BufferAttribute(anchors,3)),new THREE.PointsMaterial({color:'#6edcff',size:.018,transparent:true,opacity:.7,depthWrite:false,blending:THREE.AdditiveBlending})));
 const stars=[];for(let i=0;i<(small.matches?45:90);i++)stars.push((random()-.5)*3.5,(random()-.5)*3,(random()-.5)*2);dust=new THREE.Points(new THREE.BufferGeometry().setAttribute('position',new THREE.Float32BufferAttribute(stars,3)),new THREE.PointsMaterial({color:'#677cda',size:.009,transparent:true,opacity:.5,depthWrite:false}));scene.add(dust);
 renderer.domElement.addEventListener('webglcontextlost',event=>{event.preventDefault();useFallback();});wrapper.dataset.renderer='webgl';resize();schedule();
}catch{useFallback();}
