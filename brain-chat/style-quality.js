import lexicalIllusions from './vendor/write-good/lexical-illusions.cjs';
// Advisory only: never delete or rewrite generated content, citations or code.
export function styleDiagnostics(text,locale,previous=[]){
 const prose=String(text).replace(/```[\s\S]*?(?:```|(?![\s\S]))|`[^`]*`/g,' ').replace(/^\s*>.*$/gm,' ');
 const flags=[];
 if(locale==='en-US'&&lexicalIllusions(prose).length)flags.push('repeated_word');
 const sentences=prose.trim().split(/(?<=[.!?])\s+/);
 if(sentences[0]?.length>=15&&previous.some(t=>t.status==='complete'&&String(t.assistant).trim().startsWith(sentences[0])))flags.push('repeated_opening');
 return flags;
}
