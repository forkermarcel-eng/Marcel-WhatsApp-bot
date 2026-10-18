import {compactGerman,countries,fold} from './geography.js';
function eventRegion(value){const directions={N:'nördlich',NNE:'nordnordöstlich',NE:'nordöstlich',ENE:'ostnordöstlich',E:'östlich',ESE:'ostsüdöstlich',SE:'südöstlich',SSE:'südsüdöstlich',S:'südlich',SSW:'südsüdwestlich',SW:'südwestlich',WSW:'westsüdwestlich',W:'westlich',WNW:'westnordwestlich',NW:'nordwestlich',NNW:'nordnordwestlich'};
 const match=/^(\d+(?:\.\d+)?) km ([A-Z]{1,3}) of (.+)$/.exec(value);
 let location=match?match[3]:value;
 location=location.split(', ').map(name=>countries.find(c=>c.aliases.some(a=>fold(a)===fold(name)))?.name||name).join(', ');
 return match&&directions[match[2]]?`${match[1]} km ${directions[match[2]]} von ${location}`:location;
}
export const categories=['Alle','Politik','Wirtschaft','Finanzen','Technologie','Wissenschaft','Gesundheit','Sport','Unterhaltung','Kultur','Lifestyle','Mode','Reisen','Ernährung','Fitness','Naturereignisse'];
const rules=[['Finanzen',/\b(?:aktien|börse|boerse|dax|nasdaq|zins|goldpreis|rohstoff|devisen|trading)\b/i],['Technologie',/\b(?:künstliche intelligenz|ki|software|chip|computer|smartphone|technik)\b/i],['Gesundheit',/\b(?:medizin|gesundheit|krebs|ärzte|arzt|klinik|therapie|impfung)\b/i],['Wissenschaft',/\b(?:forschung|wissenschaft|weltraum|physik|astronomie)\b/i],['Fitness',/\b(?:fitness|training|muskeln|workout)\b/i],['Ernährung',/\b(?:rezept|kochen|küche|ernährung|lebensmittel)\b/i],['Mode',/\b(?:mode|fashion|kleidung|kollektion)\b/i],['Reisen',/\b(?:reisen|urlaub|tourismus|reisende|hotel)\b/i],['Unterhaltung',/\b(?:promi|stars?|sänger|schauspieler|hollywood|klatsch|film|musik)\b/i],['Sport',/\b(?:fußball|bundesliga|fc bayern|borussia dortmund|tennis|formel 1)\b/i],['Wirtschaft',/\b(?:wirtschaft|unternehmen|industrie|konjunktur|inflation)\b/i]];
export function presentItem(item){let out={...item};
 if(item.sourceId==='usgs'){
  const match=/\bM\s*([\d.]+)\s*-\s*(.*)/i.exec(item.title||'');
  if(match){out={...out,kind:'earthquake',eventPlace:match[2],magnitude:Number(match[1]),originalTitle:item.title,originalLanguage:item.language,language:'de',title:`Erdbeben der Magnitude ${match[1].replace('.',',')}`,description:`${item.location?`Epizentrum: ${Math.abs(item.location.lat).toFixed(2)}° ${item.location.lat<0?'S':'N'}, ${Math.abs(item.location.lon).toFixed(2)}° ${item.location.lon<0?'W':'O'}. `:''}Ortsangabe des USGS: ${match[2]}`,geoRole:'event',geoQuality:'Ereigniskoordinaten des USGS',category:'Naturereignisse'};}
 }
 if(out.kind==='earthquake'){const region=eventRegion(out.eventPlace);out.eventPlace=region;out.description=out.description.replace(/Ortsangabe des USGS: .*/,`Region: ${region}`);}
 out.kind||='news';out.editorialType=/\b(?:kommentar|meinung|kolumne)\b/i.test(out.title)?'Kommentar / Meinung':/\b(?:analyse|hintergrund)\b/i.test(out.title)?'Analyse / Hintergrund':'Meldung';
 if(['Welt','Politik'].includes(out.category))out.category=rules.find(([,re])=>re.test(out.title))?.[0]||out.category;
 out.description=compactGerman(out.description||'',220);return out;
}
