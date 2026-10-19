// Presentation only: consumes the existing MET Norway response without changing it.
import {solarLight} from './weather-solar.js';
import {weatherImages} from './weather-images.js';
export function weatherCondition(symbol){
 const code=String(symbol||'').replace(/_(day|night|polartwilight)$/,'');
 if(!code)return {kind:'unknown',label:'Wetterzustand nicht verfügbar',icon:'◌'};
 if(code.includes('thunder'))return {kind:'thunder',label:'Gewitter',icon:'ϟ'};
 if(/snow|sleet/.test(code))return {kind:'snow',label:code.includes('sleet')?'Schneeregen':code.includes('heavy')?'Starker Schneefall':code.includes('light')?'Leichter Schneefall':'Schnee',icon:'❄'};
 if(code.includes('rain'))return {kind:'rain',label:code.includes('heavy')?'Starker Regen':code.includes('light')?'Leichter Regen':code.includes('showers')?'Regenschauer':'Regen',icon:'☂'};
 if(code.includes('fog'))return {kind:'fog',label:'Nebel',icon:'≋'};
 if(code==='partlycloudy')return {kind:'cloud',label:'Teils bewölkt',icon:'⛅'};
 if(code==='cloudy')return {kind:'cloud',label:'Bewölkt',icon:'☁'};
 if(code==='fair')return {kind:'sun',label:String(symbol).endsWith('_night')?'Überwiegend klar':'Heiter',icon:String(symbol).endsWith('_night')?'☾':'☀'};
 if(code==='clearsky')return {kind:'sun',label:'Klar',icon:String(symbol).endsWith('_night')?'☾':'☀'};
 return {kind:'unknown',label:'Wetterzustand nicht verfügbar',icon:'◌'};
}
export function forecastDays(weather){
 return (weather.daily||[]).slice(0,5).map(day=>{
  const points=(weather.hourly||[]).filter(point=>new Intl.DateTimeFormat('en-CA',{timeZone:weather.timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(point.time))===day.date&&point.symbol);
  // Choose the sample nearest local noon; never copy today's condition to later days.
  points.sort((a,b)=>Math.abs(Number(new Intl.DateTimeFormat('en-GB',{timeZone:weather.timezone,hour:'numeric',hourCycle:'h23'}).format(new Date(a.time)))-12)-Math.abs(Number(new Intl.DateTimeFormat('en-GB',{timeZone:weather.timezone,hour:'numeric',hourCycle:'h23'}).format(new Date(b.time)))-12));
  return {...day,condition:weatherCondition(points[0]?.symbol)};
 });
}
export function renderWeatherView({weather:w,place,esc}){
 const condition=weatherCondition(w.symbol),number=value=>Number.isFinite(value)?new Intl.NumberFormat('de-DE',{maximumFractionDigits:0}).format(value):'—';
 const light=solarLight(place.lat,place.lon,w.validAt||w.updatedAt||Date.now()),phase=light?.phase||(String(w.symbol).endsWith('_night')?'night':'day');
 const night=phase!=='day',image=weatherImages[(condition.kind==='unknown'?'cloud':condition.kind)+(night?'Night':'')];
 const local=(value,options)=>value?new Intl.DateTimeFormat('de-DE',{timeZone:w.timezone,...options}).format(new Date(value)):'—';
 const days=forecastDays(w);
 const icon=c=>`<span class="weather-state-icon" role="img" aria-label="${esc(c.label)}">${c.icon}</span>`;
 return {kind:condition.kind,night,phase,html:`
  <div class="weather-landscape" aria-hidden="true"><picture><source media="(max-width: 600px)" srcset="/Brain/assets/weather/${image.mobile}"><img src="/Brain/assets/weather/${image.file}" alt="" decoding="async" fetchpriority="high"></picture><div class="weather-cloud-bank"></div><div class="weather-particles">${Array.from({length:24},(_,i)=>`<i style="--particle:${i}"></i>`).join('')}</div><div class="weather-lightning"></div></div>
  <section class="weather-current-glass" aria-label="Aktuelle Wettervorhersage">
   <div class="weather-current-heading"><div><span class="weather-eyebrow">DEIN WETTER · WELTWEIT</span><h2>${esc(place.name||place.displayName)}</h2><p>${esc([place.region,place.country].filter(Boolean).join(' · ')||place.displayName||'')}</p></div><span class="weather-local-time">${local(Date.now(),{hour:'2-digit',minute:'2-digit'})}<small>Ortszeit · ${local(Date.now(),{weekday:'short',day:'numeric',month:'long'})}</small></span></div>
   <div class="weather-current-temperature"><strong>${number(w.temperature)}<sup>°</sup></strong>${icon({...condition,icon:condition.kind==='sun'?(night?'☾':'☀'):condition.icon})}<div><h3>${esc(condition.label)}</h3><p>Höchstwert ${number(w.max)}° · Tiefstwert ${number(w.min)}°</p><p>${phase==='twilight'?'Dämmerung':night?'Nacht':'Tag'} · Vorhersage auf Basis der Wetterdaten</p></div></div>
   <div class="weather-metrics"><div><span>Luftfeuchtigkeit</span><b>${number(w.humidity)} %</b></div><div><span>Wind</span><b>${number(Number.isFinite(w.wind)?w.wind*3.6:null)} km/h</b></div><div><span>Niederschlag · nächste Stunde</span><b>${Number.isFinite(w.precipitation)?new Intl.NumberFormat('de-DE',{maximumFractionDigits:1}).format(w.precipitation)+' mm':'Nicht verfügbar'}</b></div><div><span>Vorhersage für</span><b>${local(w.validAt,{hour:'2-digit',minute:'2-digit'})}</b></div></div>
   <section class="weather-five-day" aria-label="5-Tage-Vorhersage"><h3>5-Tage-Vorhersage</h3><div class="weather-day-grid">${days.map(day=>`<article class="weather-day"><time datetime="${esc(day.date)}">${esc(new Date(day.date+'T12:00:00Z').toLocaleDateString('de-DE',{weekday:'long',timeZone:'UTC'}))}<small>${esc(new Date(day.date+'T12:00:00Z').toLocaleDateString('de-DE',{day:'numeric',month:'short',timeZone:'UTC'}))}</small></time>${icon(day.condition)}<p><b>${number(day.max)}°</b><span>${number(day.min)}°</span></p><small>${day.condition.kind==='unknown'?'Wetterdetails nicht verfügbar':esc(day.condition.label)}</small>${day.partial?'<small class="weather-partial">Teilzeitraum</small>':''}</article>`).join('')||'<p>Keine Tagesvorhersage verfügbar.</p>'}</div>${days.length<5?'<p class="weather-data-note">Die Datenquelle liefert derzeit weniger als fünf Tage.</p>':''}</section>
  </section>
  <details class="weather-hourly"><summary>Stundenverlauf ansehen</summary><div class="weather-hour-grid">${(w.hourly||[]).map(point=>`<article class="weather-day"><time>${local(point.time,{weekday:'short',hour:'2-digit',minute:'2-digit'})}</time>${icon(weatherCondition(point.symbol))}<b>${number(point.temperature)} °C</b><small>${Number.isFinite(point.precipitation)?new Intl.NumberFormat('de-DE',{maximumFractionDigits:1}).format(point.precipitation)+' mm':'Niederschlag nicht verfügbar'}</small></article>`).join('')}</div></details>
  <footer class="weather-data-note">Daten: ${esc(w.source||'MET Norway')} · ${esc(w.license||'CC BY 4.0')} · Aktualisiert: ${local(w.updatedAt,{day:'numeric',month:'numeric',year:'numeric',hour:'2-digit',minute:'2-digit'})}${w.stale?' · Veraltete Daten':''}<br>${light?`Sonnenaufgang ${local(light.sunrise,{hour:'2-digit',minute:'2-digit'})} · Sonnenuntergang ${local(light.sunset,{hour:'2-digit',minute:'2-digit'})} · astronomisch berechnet${light.polar?' · Polartag/Polarnacht':''}<br>`:''}Modellvorhersage · ${w.warningsAvailable?'Wetterwarnungen verfügbar.':'Diese Datenquelle liefert keine Wetterwarnungen.'}<br>Landschaft als Wetterillustration, keine Ortsaufnahme: <a href="${esc(image.source)}" target="_blank" rel="noopener">${esc(image.author)} · ${esc(image.license)}</a> · <a href="${esc(image.licenseUrl)}" target="_blank" rel="noopener">Lizenz</a> · zugeschnitten und als WebP optimiert.</footer>`};
}
