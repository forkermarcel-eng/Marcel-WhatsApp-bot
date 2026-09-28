import {isDeepStrictEqual} from "node:util";
import {normalizeTinderProfile,TinderMirrorError} from "./conversation.js";

export const COMPLETE_MISS_THRESHOLD=3;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// This consumes ordinary inventory evidence, not a target Match ID. Incomplete
// observations never change absence state. The persisted finish time prevents
// replay and overlapping scans from counting as independent complete misses.
export function createMatchLifecycle({pool,now=()=>new Date()}) {
  return Object.freeze({async observe({deviceId,inventory}) {
    if(!uuid.test(deviceId||""))throw new TinderMirrorError("INVALID_MATCH_INVENTORY","Invalid device");
    if(inventory?.complete!==true||inventory?.status!=="COMPLETE")return {applied:0,seen:0,missed:0,deactivated:0,ambiguous:0,ignored:true};
    const start=Date.parse(inventory.started_at),end=Date.parse(inventory.finished_at);
    if(!Number.isFinite(start)||!Number.isFinite(end)||start>end||end>now().getTime()+5000
      ||!Array.isArray(inventory.tiles)||inventory.tiles.length>10000)
      throw new TinderMirrorError("INVALID_MATCH_INVENTORY","Invalid complete inventory");
    const tiles=inventory.tiles.map(normalizeTinderProfile);
    const client=await pool.connect();let committing=false,discard=false;
    try {
      await client.query("BEGIN");
      const device=await client.query("SELECT device_id FROM device_bridge_devices WHERE device_id=$1 FOR UPDATE",[deviceId]);
      if(!device.rows.length)throw new TinderMirrorError("TINDER_DEVICE_NOT_FOUND","Device not found",404);
      const rows=(await client.query("SELECT * FROM tinder_matches WHERE device_id=$1 FOR UPDATE",[deviceId])).rows;
      const result={applied:0,seen:0,missed:0,deactivated:0,ambiguous:0,ignored:false};
      for(const row of rows) {
        // The existing handoff owns a confirmed transition (including shared
        // context reuse); ordinary tile sightings must not reactivate it.
        if(row.conversation_id)continue;
        if(row.last_inventory_at&&start<=new Date(row.last_inventory_at).getTime())continue;
        const observed=tiles.filter(tile=>isDeepStrictEqual(tile,row.tile)).length;
        const peers=rows.filter(other=>isDeepStrictEqual(other.tile,row.tile)).length;
        // Equal visible tiles do not establish which historical owner survived.
        if(observed>0&&observed<peers){result.ambiguous++;continue;}
        const seen=observed>0;
        if(!seen&&new Date(row.created_at).getTime()>start)continue;
        if(!seen&&!row.is_active)continue;
        const misses=seen?0:Math.min(COMPLETE_MISS_THRESHOLD,row.consecutive_complete_misses+1);
        const active=seen||misses<COMPLETE_MISS_THRESHOLD;
        await client.query(`UPDATE tinder_matches SET last_seen_at=CASE WHEN $3 THEN $4 ELSE last_seen_at END,
          last_inventory_at=$4,consecutive_complete_misses=$5,is_active=$6
          WHERE match_id=$1 AND device_id=$2`,[row.match_id,deviceId,seen,new Date(end),misses,active]);
        result.applied++;if(seen)result.seen++;else result.missed++;
        if(row.is_active&&!active)result.deactivated++;
      }
      committing=true;await client.query("COMMIT");return result;
    }catch(error){
      if(committing){discard=true;throw Error("MATCH_LIFECYCLE_COMMIT_OUTCOME_UNKNOWN",{cause:error});}
      try{await client.query("ROLLBACK");}catch{discard=true;}throw error;
    }finally{client.release(discard);}
  }});
}
