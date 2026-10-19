import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import * as policies from '../services/communication-policies.js';
const expected={
  "MARCEL_PERSONA_V1_7_2": "920d553f6a896c4a5946081712d246e1952fcaa04db8d5625d5ffdbb4110b1fc",
  "WOMAN_MEMORY_SEMANTIC_CORE": "1d40ca1719a49e6e159501a83fb8ed8411a473753c9e151e947e64caab5d2c1a",
  "WOMAN_MEMORY_LIVE_OUTPUT_RULES": "f8b718040d7b8d7911e97871f71abcfb0c965f727bf298e82962d0cdbda33492",
  "WOMAN_MEMORY_HISTORICAL_RULES": "f6d890d47e49b18ea1b7c6880c0fc6cdac3b9a8c2f256b77011f4bfc5f015608"
};
test('extracted policies retain the exact runtime values of production base 9721271',()=>{for(const [name,hash] of Object.entries(expected))assert.equal(createHash('sha256').update(policies[name]).digest('hex'),hash,name);});
