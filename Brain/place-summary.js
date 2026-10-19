// Present only fields already supplied by the existing place services.
export function placeSummary(place,info,esc){
 if(!place)return '<p>Wähle einen Ort auf der Weltkugel, um seine Informationen zu sehen.</p>';
 const types={city:'Stadt',town:'Stadt',village:'Dorf',municipality:'Gemeinde',county:'Landkreis / County',state:'Bundesland / Region',region:'Region',country:'Land',suburb:'Stadtteil',coordinate:'Geografischer Punkt'};
 const description=String(info?.fullDescription||info?.description||'').trim();
 // Preserve complete sentences within the compact summary where possible.
 const prefix=description.slice(0,650),end=prefix.lastIndexOf('. '),summary=description.length>650?(end>250?prefix.slice(0,end+1):prefix+' …'):description;
 const population=info?.population??place.population;
 const facts=[['Land',place.country],['Region',place.region],['Einordnung',types[place.level]],['Einwohner',Number.isFinite(population)&&population>0?new Intl.NumberFormat('de-DE').format(population):null],['Zeitzone',place.timezone]];
 return `<p class="place-summary-text">${esc(summary||'Für diesen Ort liegt noch keine deutsche Kurzbeschreibung vor.')}</p><dl class="place-summary-facts">${facts.filter(([,value])=>value).map(([label,value])=>`<div><dt>${label}</dt><dd>${esc(value)}</dd></div>`).join('')}</dl>`;
}
