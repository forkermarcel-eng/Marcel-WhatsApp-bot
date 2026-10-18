// Records the real WebGL canvas via captureStream. Only the opt-in loopback fixture accepts the artifact.
export async function recordPremiumMotion(){
 if(location.hostname!=='127.0.0.1')throw Error('Local recording fixture required');
 MarcelBrainScenes.open('brain');window.scrollTo(0,0);document.querySelector('[data-activation=knowledge]').click();await new Promise(r=>setTimeout(r,800));
 const source=document.querySelector('#brainStage canvas'),stream=source.captureStream(24),mime=['video/webm;codecs=vp9','video/webm;codecs=vp8','video/webm'].find(t=>MediaRecorder.isTypeSupported(t));if(!mime)throw Error('WebM recording unavailable');
 const chunks=[],recorder=new MediaRecorder(stream,{mimeType:mime,videoBitsPerSecond:3500000}),samples=[];recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data);};const stopped=new Promise((resolve,reject)=>{recorder.onstop=resolve;recorder.onerror=reject;});
 const before=MarcelBrainVisual.getState();recorder.start(500);
 try{for(const mode of ['knowledge','analysis','creative','romance','planning']){document.querySelector('[data-activation='+mode+']').click();samples.push({mode,time:MarcelBrainVisual.getState().time,pulse:MarcelBrainVisual.samplePulse(12)});await new Promise(r=>setTimeout(r,3500));}}
 finally{recorder.stop();await stopped;stream.getTracks().forEach(t=>t.stop());}
 const blob=new Blob(chunks,{type:mime});if(blob.size<100000)throw Error('Recording unexpectedly small');const saved=await fetch('/__recording',{method:'POST',headers:{'Content-Type':'video/webm'},body:blob});if(!saved.ok)throw Error('Private local recording could not be saved');
 const url=URL.createObjectURL(blob),video=document.createElement('video');video.muted=true;video.src=url;await new Promise((resolve,reject)=>{video.onloadeddata=resolve;video.onerror=reject;});const info={bytes:blob.size,mime,width:video.videoWidth,height:video.videoHeight,animationSeconds:MarcelBrainVisual.getState().time-before.time,samples,actualCanvas:true};URL.revokeObjectURL(url);return info;
}
