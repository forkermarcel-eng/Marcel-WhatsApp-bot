/* ==================================================
T7 POSTGRES AUTOMATION-CONTROL REPOSITORY ADAPTER

This is a read-only adapter for the existing T7 control-service repository
contract. It has no control writer, route, timer, worker registration,
Device-Bridge command, capture, draft, approval, delivery, or send method.
================================================== */

function positiveInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function singleRow(result) {
  return result?.rows?.[0] || null;
}

/**
 * Provides only getGlobalControl() and getContactControl(contactId), matching
 * createTinderAutomationControlService. A missing durable contact row is
 * deliberately represented as DISABLED, never as implicitly ENABLED.
 */
export function createPgTinderAutomationControlRepository(pool) {
  if (!pool || typeof pool.query !== "function") {
    throw new TypeError("pool.query must be a function");
  }

  return Object.freeze({
    async getGlobalControl() {
      return singleRow(await pool.query(`
        SELECT state, operation_state, explicit_approval, policy_revision
          FROM tinder_automation_global_control
         WHERE control_id = 1
      `));
    },

    async getContactControl(contactId) {
      const normalizedContactId = positiveInteger(contactId);
      if (normalizedContactId === null) throw new TypeError("contactId must be a positive integer");
      return singleRow(await pool.query(`
        SELECT
          contact.id AS contact_id,
          COALESCE(control.state, 'DISABLED') AS state,
          EXISTS (
            SELECT 1
              FROM contact_identifiers identifier
             WHERE identifier.contact_id = contact.id
               AND identifier.identifier_type = 'tinder_profile'
               AND identifier.human_verified = TRUE
          ) AS identity_confirmed,
          contact.auto_reply_enabled,
          latest_capture.human_takeover_active,
          latest_capture.handoff_active,
          contact.date_lock_enabled,
          contact.manual_review_required
        FROM contacts contact
        LEFT JOIN tinder_automation_contact_controls control
          ON control.contact_id = contact.id
        LEFT JOIN LATERAL (
          SELECT capture.human_takeover_active, capture.handoff_active
            FROM tinder_visible_chat_captures capture
           WHERE capture.resolved_contact_id = contact.id
           ORDER BY capture.received_at DESC, capture.capture_id DESC
           LIMIT 1
        ) latest_capture ON TRUE
       WHERE contact.id = $1
      `, [normalizedContactId]));
    }
  });
}
