import { TinderMirrorError, createTinderConversationMirror } from "./conversation.js";
import { createTinderMatchMirror } from "./matches.js";
import { createMatchLifecycle } from "./match-lifecycle.js";
import { createTinderContactBinding } from "./contact-binding.js";
import { tinderContactReference } from "./contact-binding.js";
import { createMatchProfileStore } from "./match-profile.js";
import { createTinderMediaService, registerTinderMediaRoutes } from "./media.js";

function errorResponse(res, error) {
  const status = error instanceof TinderMirrorError ? error.status : 500;
  if (!(error instanceof TinderMirrorError)) {
    console.error("Tinder mirror request failed.", error);
  }
  return res.status(status).json({
    ok: false,
    error: error instanceof TinderMirrorError ? error.code : "TINDER_MIRROR_INTERNAL_ERROR"
  });
}

function requireDashboardAccess({ dashboardApiReady, dashboardApiAuthorized }, req, res) {
  if (!dashboardApiReady(res)) return false;
  if (!dashboardApiAuthorized(req)) {
    res.status(401).json({ ok: false, error: "Nicht autorisiert." });
    return false;
  }
  return true;
}

/*
 * The adapter uses the existing dashboard bearer transport.  It does not read
 * bridge heartbeat state, issue commands, or create an authorization layer of
 * its own.  Device binding is enforced by the mirror table's ordinary FK.
 */
export function registerTinderMirrorRoutes({ app, pool, dashboardApiReady, dashboardApiAuthorized, sharedMedia = null, processMatchEnqueuer=null }) {
  const mirror = createTinderConversationMirror({ pool });
  const matches = createTinderMatchMirror({ pool });
  const matchLifecycle = createMatchLifecycle({pool});
  const matchProfiles = createMatchProfileStore({pool,transferMedia:sharedMedia?.repository.transferMatchMedia});
  const access = { dashboardApiReady, dashboardApiAuthorized };
  const media = sharedMedia ? createTinderMediaService({ pool,media: sharedMedia }) : null;
  if (media) registerTinderMediaRoutes({ app,service: media,authorized: dashboardApiAuthorized });

  app.get("/dashboard-api/tinder/matches/:matchId/profile",async(req,res)=>{
    if(!requireDashboardAccess(access,req,res))return;
    try {
      const match=await matchProfiles.get({deviceId:req.query?.device_id,matchId:req.params.matchId});
      const bound=await pool.query("SELECT contact_id FROM contact_identifiers WHERE identifier_type='tinder_profile' AND normalized_value=$1 AND human_verified=TRUE",
        [tinderContactReference({deviceId:match.device_id,matchId:match.match_id})]);
      match.contact_id=bound.rows.length===1?Number(bound.rows[0].contact_id):null;
      if(media)match.media=await media.present("match",match.match_id);
      return res.status(200).json({ok:true,match});
    }catch(error){return errorResponse(res,error);}
  });
  app.post("/dashboard-api/tinder/matches/:matchId/process",async(req,res)=>{
    if(!requireDashboardAccess(access,req,res))return;
    try {
      if(!media||!processMatchEnqueuer)throw new TinderMirrorError("PROCESS_MATCH_UNAVAILABLE","Product runtime not configured",503);
      const owner=await pool.query("SELECT device_id FROM tinder_matches WHERE match_id=$1",[req.params.matchId]);
      if(owner.rows.length!==1)throw new TinderMirrorError("TINDER_MATCH_NOT_FOUND","Match not found",404);
      const match=await matchProfiles.get({deviceId:owner.rows[0].device_id,matchId:req.params.matchId});
      const jobId=await processMatchEnqueuer.enqueueProcessMatch({operation:"PROCESS_MATCH",device_id:match.device_id,match_id:match.match_id});
      return res.status(202).json({ok:true,job_id:jobId});
    }catch(error){return errorResponse(res,error);}
  });
  app.post("/dashboard-api/tinder/matches/:matchId/profile",async(req,res)=>{
    if(!requireDashboardAccess(access,req,res))return;
    try {
      const result=await matchProfiles.saveComplete({deviceId:req.body?.device_id,matchId:req.params.matchId,
        expectedTile:req.body?.expected_tile,profile:req.body?.profile});
      return res.status(200).json({ok:true,...result});
    }catch(error){return errorResponse(res,error);}
  });
  app.post("/dashboard-api/tinder/matches/:matchId/contact",async(req,res)=>{
    if(!requireDashboardAccess(access,req,res))return;
    try {
      const owner=await pool.query("SELECT device_id FROM tinder_matches WHERE match_id=$1",[req.params.matchId]);
      if(owner.rows.length!==1)throw new TinderMirrorError("TINDER_MATCH_NOT_FOUND","Match not found",404);
      const result=await createTinderContactBinding({pool,attachMedia:sharedMedia?.repository.attachConversationContact})
        .bind({deviceId:owner.rows[0].device_id,matchId:req.params.matchId,contactId:req.body?.contact_id??null,confirmed:req.body?.confirmed===true});
      return res.status(200).json({ok:true,...result});
    }catch(error){return errorResponse(res,error);}
  });

  app.post("/dashboard-api/tinder/conversations/:conversationId/contact", async (req,res) => {
    if (!requireDashboardAccess(access,req,res)) return;
    try {
      const owner=await pool.query("SELECT device_id FROM tinder_conversations WHERE conversation_id=$1",[req.params.conversationId]);
      if(owner.rows.length!==1)throw new TinderMirrorError("TINDER_CONVERSATION_NOT_FOUND","Conversation not found",404);
      if(req.body?.device_id && req.body.device_id!==owner.rows[0].device_id)throw new TinderMirrorError("INVALID_CONTACT_BINDING","Device mismatch");
      const result = await createTinderContactBinding({ pool,
        attachMedia: sharedMedia?.repository.attachConversationContact }).bind({ deviceId: owner.rows[0].device_id,
        conversationId: req.params.conversationId, contactId: req.body?.contact_id ?? null,
        confirmed: req.body?.confirmed === true });
      return res.status(200).json({ ok: true, ...result });
    } catch (error) { return errorResponse(res,error); }
  });

  app.post("/dashboard-api/tinder/conversations/resolve", async (req, res) => {
    if (!requireDashboardAccess(access, req, res)) return;
    const deviceId = String(req.body?.device_id || "");
    try {
      return res.status(200).json({ ok: true, ...(await mirror.resolve({ deviceId, payload: req.body?.observation })) });
    } catch (error) {
      return errorResponse(res, error);
    }
  });

  app.post("/dashboard-api/tinder/conversations", async (req, res) => {
    if (!requireDashboardAccess(access, req, res)) return;
    const deviceId = String(req.body?.device_id || "");
    try {
      return res.status(201).json({ ok: true, ...(await mirror.sync({ deviceId, payload: req.body?.observation })) });
    } catch (error) {
      return errorResponse(res, error);
    }
  });

  // A selected known Conversation may accept only a normal chronological
  // message viewport that demonstrably continues its stored tail.  This is a
  // narrow authenticated product route: it cannot create a Conversation or
  // submit profile/full-history fields.
  app.post("/dashboard-api/tinder/conversations/:conversationId/delta", async (req, res) => {
    if (!requireDashboardAccess(access, req, res)) return;
    const deviceId = String(req.body?.device_id || "");
    try {
      return res.status(200).json({
        ok: true,
        ...(await mirror.appendDelta({
          deviceId,
          conversationId: req.params.conversationId,
          payload: req.body?.delta
        }))
      });
    } catch (error) {
      return errorResponse(res, error);
    }
  });

  // Existing completed threads may refresh their current official Inbox
  // ordering without resubmitting a profile or history snapshot.
  app.post("/dashboard-api/tinder/conversations/:conversationId/inbox-order", async (req, res) => {
    if (!requireDashboardAccess(access, req, res)) return;
    const deviceId = String(req.body?.device_id || "");
    try {
      return res.status(200).json({
        ok: true,
        ...(await mirror.updateInboxOrder({
          deviceId,
          conversationId: req.params.conversationId,
          inboxOrder: {
            ...(Object.hasOwn(req.body || {}, "last_message_visible_time")
              ? { last_message_visible_time: req.body.last_message_visible_time }
              : {}),
            ...(Object.hasOwn(req.body || {}, "inbox_position")
              ? { inbox_position: req.body.inbox_position }
              : {})
          }
        }))
      });
    } catch (error) {
      return errorResponse(res, error);
    }
  });

  app.get("/dashboard-api/tinder/conversations", async (req, res) => {
    if (!requireDashboardAccess(access, req, res)) return;
    try {
      const conversations = await mirror.list(req.query?.device_id ?? null);
      return res.status(200).json({ ok: true, conversations: media
        ? await Promise.all(conversations.map(async conversation => ({ ...conversation,...await media.present("conversation",conversation.id) }))) : conversations });
    } catch (error) {
      return errorResponse(res, error);
    }
  });

  app.get("/dashboard-api/tinder/conversations/:conversationId", async (req, res) => {
    if (!requireDashboardAccess(access, req, res)) return;
    try {
      const detail = await mirror.detail(req.params.conversationId);
      if (media) Object.assign(detail, { media: await media.present("conversation",req.params.conversationId) });
      const binding=await pool.query(`SELECT i.contact_id FROM tinder_conversations c JOIN contact_identifiers i
        ON i.normalized_value='mirror:' || c.device_id::text || ':' || c.conversation_id::text
        WHERE c.conversation_id=$1 AND i.identifier_type='tinder_profile' AND i.human_verified=TRUE`,[req.params.conversationId]);
      Object.assign(detail,{contact_id:binding.rows.length===1?Number(binding.rows[0].contact_id):null});
      return res.status(200).json({ ok: true, ...detail });
    } catch (error) {
      return errorResponse(res, error);
    }
  });

  // A Match is an ordinary, read-only Tinder product record.  It is not a
  // Conversation, command, enrollment flow, or bridge-readiness operation.
  app.post("/dashboard-api/tinder/matches", async (req, res) => {
    if (!requireDashboardAccess(access, req, res)) return;
    const deviceId = String(req.body?.device_id || "");
    try {
      return res.status(201).json({ ok: true, ...(await matches.sync({ deviceId, payload: req.body?.match })) });
    } catch (error) {
      return errorResponse(res, error);
    }
  });

  app.post("/dashboard-api/tinder/matches/inventory",async(req,res)=>{
    if(!requireDashboardAccess(access,req,res))return;
    try {
      const result=await matchLifecycle.observe({deviceId:req.body?.device_id,inventory:req.body?.inventory});
      const transitions=result.ignored?{transitions:0}:await matchProfiles.reconcileBoundConversations({deviceId:req.body.device_id});
      return res.status(200).json({ok:true,...result,...transitions});
    }catch(error){return errorResponse(res,error);}
  });

  app.get("/dashboard-api/tinder/matches", async (req, res) => {
    if (!requireDashboardAccess(access, req, res)) return;
    try {
      const listing = await matches.list({includeInactive:req.query?.include_inactive==="1"});
      return res.status(200).json({ ok: true, matches: media
        ? await Promise.all(listing.map(async match => ({ ...match,...await media.present("match",match.id) }))) : listing });
    } catch (error) {
      return errorResponse(res, error);
    }
  });
}
