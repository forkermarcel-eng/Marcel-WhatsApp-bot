import test from 'node:test';
import assert from 'node:assert/strict';
import {weatherCondition,forecastDays,renderWeatherView} from '../Brain/weather-view.js';

test('MET conditions are readable in German with intensity and night preserved',()=>{
 assert.equal(weatherCondition('lightrain_day').label,'Leichter Regen');
 assert.equal(weatherCondition('heavyrain').label,'Starker Regen');
 assert.equal(weatherCondition('rainshowersandthunder_day').kind,'thunder');
 assert.equal(weatherCondition('lightsleet').label,'Schneeregen');
 assert.equal(weatherCondition('clearsky_night').icon,'☾');
 assert.equal(weatherCondition('fog').kind,'fog');
 assert.equal(weatherCondition(null).kind,'unknown');
});

test('five day icons use actual local-day samples without inventing later conditions',()=>{
 const weather={timezone:'Europe/Berlin',daily:Array.from({length:6},(_,i)=>({date:`2026-10-${20+i}`,min:2,max:8})),hourly:[{time:'2026-10-19T23:00:00Z',symbol:'fog'},{time:'2026-10-20T10:00:00Z',symbol:'rain'}]};
 const days=forecastDays(weather);assert.equal(days.length,5);assert.equal(days[0].condition.label,'Regen');assert.equal(days[1].condition.kind,'unknown');
 assert.equal(weather.daily.length,6);assert.equal(weather.hourly.length,2);
});

test('missing values stay unavailable and a shorter forecast stays honest',()=>{
 const result=renderWeatherView({weather:{timezone:'Europe/Berlin',symbol:'fog',daily:[],hourly:[],precipitation:null,temperature:null},place:{name:'<Ort>'},esc:x=>String(x).replaceAll('<','&lt;').replaceAll('>','&gt;')});
 assert.equal(result.kind,'fog');assert.match(result.html,/&lt;Ort&gt;/);assert.match(result.html,/Nicht verfügbar/);assert.match(result.html,/weniger als fünf Tage/);assert.doesNotMatch(result.html,/>0 mm</);
});
