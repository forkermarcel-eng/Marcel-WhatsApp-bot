import path from 'node:path';
import {registerMarketAnalysisRoutes} from './routes.js';
import {interactiveFixture} from './offline-fixture.js';
import {createLocalScanner} from './scanner.js';
import {apiError} from './api-runtime.js';

// Explicitly approved offline examples only. Normal production configuration
// keeps its existing fixture prohibition; no NODE_ENV or provider flags change.
export async function registerDeployedMarketAnalysisRoutes({app,pool,authorized,env=process.env}={}) {
 if(!env.MARCEL_ANALYSIS_DATA_MODE)return registerMarketAnalysisRoutes({app,pool,authorized,env});
 let runtime;
 try {
  if(env.MARCEL_ANALYSIS_DATA_MODE!=='offline-fixture'||env.RAILWAY_PROJECT_ID!=='7afe0a4f-8302-4c1c-97d7-e4b0dbd62635'||env.RAILWAY_ENVIRONMENT_ID!=='3bedc83c-b9da-4943-8701-9e4f86ff3574')throw Error('Unapproved offline deployment target');
  const pythonPath=env.MARCEL_ANALYSIS_PYTHON_PATH;
  if(!pythonPath||!path.isAbsolute(pythonPath))throw Error('Explicit interpreter required');
  const probe=await createLocalScanner({pythonPath}).probe();
  const fixture=await interactiveFixture({pythonPath,database:pool});
  runtime={...fixture.runtime,
   runtimeStatus:async()=>({ready:true,interpreterReady:true,mode:'offline-fixture',runtime:probe,testInstrumentCount:fixture.instruments.length}),
   createJob:async(owner,input)=>{fixture.advance();return fixture.runtime.createJob(owner,input);}
  };
 }catch {
  // A missing schema/runtime must never prevent existing Brain routes starting.
  console.error('Marktanalyse: freigegebene Offline-Beispiele nicht verfuegbar.');
  runtime=Object.fromEntries(['catalog','series','fundamentals','alerts','job','createJob','run','cancel','runtimeStatus'].map(k=>[k,async()=>{throw apiError('OFFLINE_TESTDATA_UNAVAILABLE',503);} ]));
 }
 return registerMarketAnalysisRoutes({app,pool,authorized,runtime,env});
}
