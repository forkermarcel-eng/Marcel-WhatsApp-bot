/* ==================================================
DEVICE BRIDGE — FIXED READ-ONLY DIAGNOSTIC TRANSACTION
================================================== */

export const READ_ONLY_GUARD_CODE = "READ_ONLY_QUERY_REJECTED";
const readOnlyTransactionClients = new WeakSet();
const DOLLAR_QUOTE_BOUNDARIES = new Set(["(", "[", "{", ",", "=", "<", ">", "+", "-", "*", "/", "%", "|", "&", "^", "~", "!", "?", ":"]);
const SQL_WHITESPACE = new Set([" ", "\t", "\r", "\n", "\f"]);

export function isDeviceBridgeReadOnlyTransactionClient(client) {
  return Boolean(client && readOnlyTransactionClients.has(client));
}

function queryText(statement) {
  if (typeof statement === "string") return statement;
  if (statement && typeof statement.text === "string") return statement.text;
  return "";
}

function hasSafeDollarQuoteBoundary(text, index) {
  const previous = text[index - 1];
  return !previous || SQL_WHITESPACE.has(previous) || DOLLAR_QUOTE_BOUNDARIES.has(previous);
}

function dollarQuoteDelimiter(text, index) {
  if (text[index] !== "$" || !hasSafeDollarQuoteBoundary(text, index)) return null;
  const closing = text.indexOf("$", index + 1);
  if (closing === -1) return null;
  const tag = text.slice(index + 1, closing);
  if (tag !== "" && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(tag)) return null;
  return text.slice(index, closing + 1);
}

function skipSingleQuotedString(text, index) {
  for (let cursor = index + 1; cursor < text.length; cursor += 1) {
    if (text[cursor] !== "'") continue;
    if (text[cursor + 1] === "'") {
      cursor += 1;
      continue;
    }
    return cursor + 1;
  }
  return null;
}

function skipDoubleQuotedIdentifier(text, index) {
  for (let cursor = index + 1; cursor < text.length; cursor += 1) {
    if (text[cursor] !== '"') continue;
    if (text[cursor + 1] === '"') {
      cursor += 1;
      continue;
    }
    return cursor + 1;
  }
  return null;
}

function skipBlockComment(text, index) {
  let depth = 1;
  for (let cursor = index + 2; cursor < text.length; cursor += 1) {
    const pair = text.slice(cursor, cursor + 2);
    if (pair === "/*") {
      depth += 1;
      cursor += 1;
      continue;
    }
    if (pair === "*/") {
      depth -= 1;
      cursor += 1;
      if (depth === 0) return cursor + 1;
    }
  }
  return null;
}

function hasNoExecutableSemicolon(text) {
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    const pair = text.slice(index, index + 2);

    if (pair === "--") {
      const newline = text.slice(index + 2).search(/[\r\n]/);
      if (newline === -1) return true;
      index += newline + 2;
      continue;
    }
    if (pair === "/*") {
      const next = skipBlockComment(text, index);
      if (next === null) return false;
      index = next - 1;
      continue;
    }
    if (character === "'") {
      const next = skipSingleQuotedString(text, index);
      if (next === null) return false;
      index = next - 1;
      continue;
    }
    if (character === '"') {
      const next = skipDoubleQuotedIdentifier(text, index);
      if (next === null) return false;
      index = next - 1;
      continue;
    }
    if (character === "$") {
      const delimiter = dollarQuoteDelimiter(text, index);
      if (delimiter) {
        const closing = text.indexOf(delimiter, index + delimiter.length);
        if (closing === -1) return false;
        index = closing + delimiter.length - 1;
        continue;
      }
    }
    if (character === ";") return false;
  }
  return true;
}

function isSelectOnly(statement) {
  const text = queryText(statement).trim();
  // The original fixed SQL is executed unchanged. This lexical inspection
  // keeps the existing SELECT-only/no-terminator policy while ignoring bounded
  // comments and literals; malformed lexical input fails closed.
  return /^SELECT\b/i.test(text) && hasNoExecutableSemicolon(text);
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
    readOnlyTransactionClients.add(client);

    return await work(client);
  } finally {
    if (client) readOnlyTransactionClients.delete(client);
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
