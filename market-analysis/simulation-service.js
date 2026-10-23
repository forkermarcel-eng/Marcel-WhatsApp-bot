import {createLocalScanner} from './scanner.js';
import {loadAnalysisRequest,createLocalAnalysisTask} from './analysis-service.js';
import {requireValue,utcMillis} from './instruments.js';

const operations=new Set(['time-machine','historical-setups','risk','sequence-risk']);
// Same fixed Python process, limits, cancellation and job isolation as Phase 4.
export function createLocalTimeMachine(options) {
  const scanner=createLocalScanner(options);
  return Object.freeze({async analyze(requests,runOptions) {
    requireValue(Array.isArray(requests) && requests.every(r=>operations.has(r.operation)),'Explicit Phase-5 operation required.');
    return scanner.analyze(requests,runOptions);
  }});
}
export function createSimulationTask(options) {
  requireValue(options.requests.every(r=>operations.has(r.operation)),'Invalid simulation operation.');
  return createLocalAnalysisTask({...options,sourceId:options.sourceId ?? 'analysis-local:phase5'});
}
export async function loadSimulationRequest(options) {
  const input=await loadAnalysisRequest(options);
  requireValue(utcMillis(options.to)<=utcMillis(options.trainingEnd) && utcMillis(options.trainingEnd)<=utcMillis(options.asOf),'Training cutoff invalid.');
  return {...input,operation:'time-machine',trainingEnd:options.trainingEnd,dataKnownAt:options.asOf,
    plan:options.plan,paths:options.paths ?? 10000,seed:options.seed ?? 19,horizonBars:options.horizonBars ?? 60,
    method:options.method ?? 'block-delta',contract:options.contract,costs:options.costs,quantity:options.quantity,
    accountCurrency:options.accountCurrency,conversion:options.conversion,allowSmallFixtureSample:options.allowSmallFixtureSample===true};
}
