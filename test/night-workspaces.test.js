import test from 'node:test';
import assert from 'node:assert/strict';
import {readWorldMarkets} from '../brain-world/markets.js';
import {normalizeWeather} from '../brain-world/service.js';
test('finance reuses stored candles with no provider or write operation',async()=>{
 const repository={series:async()=>[{contract:'TEST',source:'fixture',resolution:60,last:'2026-10-18T10:00:00Z'}],candles:async()=>[{time:'2026-10-17T10:00:00Z',close:100},{time:'2026-10-18T10:00:00Z',close:102}]};
 const result=await readWorldMarkets(null,{repository,now:Date.parse('2026-10-19T12:00:00Z')});assert.equal(result.live,false);assert.equal(result.items[0].change,2);assert.equal(result.items[0].stale,true);assert.equal(result.items[0].chart.length,2);
});
test('forecast days use place timezone, preserve missing rain, and mark partial periods',()=>{
 const timeseries=['2026-10-18T21:00:00Z','2026-10-18T22:00:00Z','2026-10-19T00:00:00Z'].map((time,i)=>({time,data:{instant:{details:{air_temperature:10+i,wind_speed:2,relative_humidity:60}}}}));
 const weather=normalizeWeather({properties:{meta:{updated_at:timeseries[0].time},timeseries}},48.14,11.58,Date.parse(timeseries[0].time));assert.equal(weather.hourly.length,3);assert.equal(weather.daily.length,2);assert.equal(weather.hourly[0].precipitation,null);assert.equal(weather.warningsAvailable,false);assert.equal(weather.daily[0].partial,true);
});
