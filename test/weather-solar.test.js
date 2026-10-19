import test from 'node:test';import assert from 'node:assert/strict';
import {solarLight} from '../Brain/weather-solar.js';
test('solar phase follows location and forecast timestamp, including timezone differences',()=>{
 assert.equal(solarLight(52.52,13.4,'2026-10-19T18:00:00Z').phase,'night');
 assert.equal(solarLight(6.24,-75.58,'2026-10-19T18:00:00Z').phase,'day');
 assert.equal(solarLight(52.52,13.4,'2026-06-21T18:00:00Z').phase,'day');
 const berlin=solarLight(52.52,13.4,'2026-10-19T12:00:00Z');assert.ok(Date.parse(berlin.sunrise)<Date.parse(berlin.sunset));assert.ok(new Date(berlin.sunrise).getUTCHours()>=5&&new Date(berlin.sunrise).getUTCHours()<=6);
});
test('polar regions and the date line produce finite phases without invalid sunrise times',()=>{
 const summer=solarLight(89,0,'2026-06-21T00:00:00Z'),winter=solarLight(89,0,'2026-12-21T12:00:00Z');assert.equal(summer.phase,'day');assert.equal(winter.phase,'night');assert.equal(summer.sunrise,null);assert.equal(winter.sunset,null);
 assert.equal(solarLight(-17.7,178,'2026-10-19T00:00:00Z').phase,'day');assert.equal(solarLight(null,0,Date.now()),null);
});
