import { isDeepStrictEqual } from "node:util";
import { normalizeTinderProfile, TinderMirrorError } from "./conversation.js";
import { tinderContactReference } from "./contact-binding.js";

export function createMatchProfileStore({pool,transferMedia=null}) {
  function target({deviceId,matchId}) {tinderContactReference({deviceId,matchId});}
  async function get({deviceId,matchId}) {
    target({deviceId,matchId});
    const result=await pool.query("SELECT match_id,device_id,conversation_id,tile,profile FROM tinder_matches WHERE match_id=$1 AND device_id=$2",[matchId,deviceId]);
    if(result.rows.length!==1)throw new TinderMirrorError("TINDER_MATCH_NOT_FOUND","Match not found",404);
    return result.rows[0];
  }
  async function transaction(run) {
    const client=await pool.connect();let committing=false,discard=false;
    try {await client.query("BEGIN");const result=await run(client);committing=true;await client.query("COMMIT");return result;}
    catch(error){if(committing){discard=true;throw new Error("MATCH_PROFILE_COMMIT_OUTCOME_UNKNOWN",{cause:error});}
      try{await client.query("ROLLBACK");}catch{discard=true;}throw error;}
    finally{client.release(discard);}
  }
  async function saveComplete({deviceId,matchId,expectedTile,profile}) {
    target({deviceId,matchId});
    const normalized=normalizeTinderProfile(profile);
    const tile=normalizeTinderProfile(expectedTile);
    return transaction(async client=>{
      const result=await client.query("SELECT tile,profile FROM tinder_matches WHERE match_id=$1 AND device_id=$2 FOR UPDATE",[matchId,deviceId]);
      const row=result.rows[0];
      if(!row||!isDeepStrictEqual(row.tile,tile))throw new TinderMirrorError("TINDER_MATCH_CHANGED","Match changed during profile read",409);
      const changed=!isDeepStrictEqual(row.profile,normalized);
      if(changed)await client.query("UPDATE tinder_matches SET profile=$3::jsonb,updated_at=NOW() WHERE match_id=$1 AND device_id=$2",[matchId,deviceId,JSON.stringify(normalized)]);
      return {matchId,profile:normalized,changed};
    });
  }
  // Only called after the existing controller established this exact relation.
  // Never creates a conversation, guesses identity, or overwrites a newer profile.
  async function handoffToConversation({deviceId,matchId,verifiedConversationId}) {
    target({deviceId,matchId});
    const matchRef=tinderContactReference({deviceId,matchId});
    const conversationRef=tinderContactReference({deviceId,conversationId:verifiedConversationId});
    return transaction(async client=>{
      for(const ref of [matchRef,conversationRef].sort())await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`tinder-contact:${ref}`]);
      const match=(await client.query("SELECT profile,conversation_id FROM tinder_matches WHERE match_id=$1 AND device_id=$2 FOR UPDATE",[matchId,deviceId])).rows[0];
      const conversation=(await client.query("SELECT profile FROM tinder_conversations WHERE conversation_id=$1 AND device_id=$2 FOR UPDATE",[verifiedConversationId,deviceId])).rows[0];
      if(!match||!conversation||(match.conversation_id&&match.conversation_id!==verifiedConversationId))
        throw new TinderMirrorError("TINDER_MATCH_LINK_CONFLICT","Existing verified objects required",409);
      const bindings=(await client.query("SELECT normalized_value,contact_id,human_verified FROM contact_identifiers WHERE identifier_type='tinder_profile' AND normalized_value=ANY($1::text[]) FOR UPDATE",[[matchRef,conversationRef]])).rows;
      if(bindings.some(b=>b.human_verified!==true)||new Set(bindings.map(b=>String(b.contact_id))).size>1)
        throw new TinderMirrorError("CONTACT_BINDING_CONFLICT","No contact merge performed",409);
      const contactId=bindings.length?Number(bindings[0].contact_id):null;
      if(contactId!==null)for(const ref of [matchRef,conversationRef]) {
        if(!bindings.some(b=>b.normalized_value===ref))await client.query(`INSERT INTO contact_identifiers
          (contact_id,identifier_type,identifier_value,normalized_value,source_platform,is_primary,human_verified,created_at,updated_at)
          VALUES ($1,'tinder_profile',$2,$2,'tinder',FALSE,TRUE,NOW(),NOW())`,[contactId,ref]);
      }
      let profileReused=false;
      if(match.profile && (!conversation.profile || Object.keys(conversation.profile).length===0)) {
        const profile=normalizeTinderProfile(match.profile);
        await client.query("UPDATE tinder_conversations SET profile=$2::jsonb,profile_synced_at=NOW() WHERE conversation_id=$1",[verifiedConversationId,JSON.stringify(profile)]);
        profileReused=true;
      }
      if(!match.conversation_id)await client.query("UPDATE tinder_matches SET conversation_id=$3,updated_at=NOW() WHERE match_id=$1 AND device_id=$2",[matchId,deviceId,verifiedConversationId]);
      if(transferMedia)await transferMedia(client,{matchId,conversationId:verifiedConversationId,contactId});
      return {matchId,conversationId:verifiedConversationId,contactId,profileReused};
    });
  }
  return Object.freeze({get,saveComplete,handoffToConversation});
}

// Reuses the existing full-profile runner supplied by the serialized Appium
// dispatcher. No job system, controller, models or persistent readiness flags.
export function createProcessMatch({store,revalidate,readFullProfile,ensureMediaContext}) {
  return Object.freeze({async run(target) {
    const stored=await store.get(target);
    const current=await revalidate(stored);
    if(!current?.verified) return {status:"MATCH_NOT_REVALIDATED"};
    if(stored.profile && current.unchanged===true) {
      const media=await ensureMediaContext({...target,profile:stored.profile,read:false});
      if(media?.ready||media?.reason!=="PROFILE_MEDIA_INCOMPLETE") {
        return {status:media?.ready?"PROFILE_CONTEXT_READY":"PROFILE_MEDIA_PENDING",profile:stored.profile,profileRead:false};
      }
      // A previous partial media attempt is not a completed cached profile.
      // Retry this selected match only; exact-byte ingress reuses earlier pages.
    }
    const result=await readFullProfile(stored);
    if(result?.status!=="PROFILE_READ"||result.returned_with_back!==true) return {status:result?.status||"PROFILE_READ_FAILED"};
    const saved=await store.saveComplete({...target,expectedTile:stored.tile,profile:result.profile});
    const media=await ensureMediaContext({...target,profile:saved.profile,read:true});
    return {status:media?.ready?"PROFILE_CONTEXT_READY":"PROFILE_MEDIA_PENDING",profile:saved.profile,profileRead:true};
  }});
}
