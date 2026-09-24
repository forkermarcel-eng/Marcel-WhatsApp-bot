import { TinderMirrorError, createTinderConversationMirror } from "./conversation.js";

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
export function registerTinderMirrorRoutes({ app, pool, dashboardApiReady, dashboardApiAuthorized }) {
  const mirror = createTinderConversationMirror({ pool });
  const access = { dashboardApiReady, dashboardApiAuthorized };

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
      return res.status(200).json({ ok: true, conversations: await mirror.list() });
    } catch (error) {
      return errorResponse(res, error);
    }
  });

  app.get("/dashboard-api/tinder/conversations/:conversationId", async (req, res) => {
    if (!requireDashboardAccess(access, req, res)) return;
    try {
      return res.status(200).json({ ok: true, ...(await mirror.detail(req.params.conversationId)) });
    } catch (error) {
      return errorResponse(res, error);
    }
  });
}
