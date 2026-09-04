/* ==================================================
DEVICE BRIDGE — FIXED READ-ONLY DIAGNOSTIC TRANSACTION
================================================== */

export const READ_ONLY_GUARD_CODE = "READ_ONLY_QUERY_REJECTED";

function queryText(statement) {
  if (typeof statement === "string") return statement;
  if (statement && typeof statement.text === "string") return statement.text;
  return "";
}

function isSelectOnly(statement) {
  const text = queryText(statement).trim();
  // Fixed diagnostic queries never require a statement terminator. Rejecting
  // one closes the multi-statement escape hatch before PostgreSQL sees it.
  return /^SELECT\b/i.test(text) && !text.includes(";");
}

/**
 * Runs one fixed diagnostic transaction. The callback receives a client whose
 * normal query method accepts catalog/data SELECTs only; transaction control
 * remains private to this helper and is always rolled back.
 */
export async function withDeviceBridgeReadOnlyTransaction(pool, work) {
  let client;
  let rawQuery;
  let originalQuery;
  let transactionStarted = false;
  let rollbackError;

  try {
    client = await pool.connect();
    rawQuery = client.query.bind(client);

    await rawQuery("BEGIN");
    transactionStarted = true;
    await rawQuery("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");

    originalQuery = client.query;
    client.query = (...args) => {
      if (!isSelectOnly(args[0])) {
        const error = new Error("Read-only diagnostic rejected a non-SELECT query.");
        error.code = READ_ONLY_GUARD_CODE;
        throw error;
      }
      return rawQuery(...args);
    };

    return await work(client);
  } finally {
    if (client && originalQuery) client.query = originalQuery;
    if (transactionStarted) {
      try {
        await rawQuery("ROLLBACK");
      } catch (error) {
        rollbackError = error;
      }
    }
    client?.release();
    if (rollbackError) throw rollbackError;
  }
}
