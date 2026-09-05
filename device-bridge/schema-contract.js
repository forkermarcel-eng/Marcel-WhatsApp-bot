/* ==================================================
DEVICE BRIDGE — READ-ONLY SCHEMA CONTRACT NORMALIZATION
================================================== */

function skipWhitespace(source, cursor) {
  while (/\s/.test(source[cursor] || "")) cursor += 1;
  return cursor;
}

function readTypeIdentifier(source, cursor) {
  if (source[cursor] === '"') {
    const start = cursor;
    cursor += 1;
    while (cursor < source.length) {
      if (source[cursor] === '"') {
        cursor += source[cursor + 1] === '"' ? 2 : 1;
        if (source[cursor - 1] === '"') break;
      } else cursor += 1;
    }
    return { cursor, word: source.slice(start, cursor).toLowerCase() };
  }
  const match = source.slice(cursor).match(/^[A-Za-z_][A-Za-z0-9_$]*/);
  return match ? { cursor: cursor + match[0].length, word: match[0].toLowerCase() } : null;
}

function consumeWords(source, cursor, words) {
  const start = cursor;
  for (const word of words) {
    cursor = skipWhitespace(source, cursor);
    const identifier = readTypeIdentifier(source, cursor);
    if (!identifier || identifier.word !== word) return start;
    cursor = identifier.cursor;
  }
  return cursor;
}

function consumeBalancedTypeModifier(source, cursor) {
  if (source[cursor] !== "(") return cursor;
  let depth = 0;
  while (cursor < source.length) {
    const character = source[cursor];
    if (character === "(") depth += 1;
    if (character === ")") {
      depth -= 1;
      if (depth === 0) return cursor + 1;
    }
    cursor += 1;
  }
  return cursor;
}

function stripTypeCast(source, start) {
  let cursor = skipWhitespace(source, start + 2);
  const type = readTypeIdentifier(source, cursor);
  if (!type) return start + 2;
  cursor = type.cursor;

  // PostgreSQL permits schema-qualified type names. Only consume an
  // additional identifier after an explicit dot; do not consume a following
  // boolean operator such as `AND` as though it were part of the type.
  while (true) {
    const beforeDot = cursor;
    cursor = skipWhitespace(source, cursor);
    if (source[cursor] !== ".") {
      cursor = beforeDot;
      break;
    }
    cursor = skipWhitespace(source, cursor + 1);
    const qualified = readTypeIdentifier(source, cursor);
    if (!qualified) return beforeDot;
    cursor = qualified.cursor;
  }

  // These are PostgreSQL's relevant multi-word type names. They are consumed
  // explicitly so regular SQL words following a simple cast stay tokenized.
  if (type.word === "double") cursor = consumeWords(source, cursor, ["precision"]);
  if (type.word === "character" || type.word === "bit") cursor = consumeWords(source, cursor, ["varying"]);
  if (type.word === "timestamp" || type.word === "time") {
    const withTimeZone = consumeWords(source, cursor, ["with", "time", "zone"]);
    const withoutTimeZone = consumeWords(source, cursor, ["without", "time", "zone"]);
    cursor = withTimeZone !== cursor ? withTimeZone : withoutTimeZone !== cursor ? withoutTimeZone : cursor;
  }

  const beforeModifier = cursor;
  cursor = skipWhitespace(source, cursor);
  if (source[cursor] === "(") cursor = consumeBalancedTypeModifier(source, cursor);
  else cursor = beforeModifier;
  const beforeArray = cursor;
  cursor = skipWhitespace(source, cursor);
  if (source.slice(cursor, cursor + 2) === "[]") cursor += 2;
  else cursor = beforeArray;
  return cursor;
}

/**
 * Tokenizes PostgreSQL catalog output while preserving quoted values and all
 * meaningful operators. PostgreSQL-added type casts are deliberately removed:
 * they do not alter a CHECK's logical contract for these fixed columns.
 */
export function tokenizeSchemaSql(value) {
  const source = String(value || "");
  const tokens = [];
  for (let index = 0; index < source.length;) {
    const character = source[index];
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    if (source.slice(index, index + 2) === "::") {
      index = stripTypeCast(source, index);
      continue;
    }
    if (character === "'") {
      let token = character;
      index += 1;
      while (index < source.length) {
        token += source[index];
        if (source[index] === "'") {
          if (source[index + 1] === "'") {
            token += source[index + 1];
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        index += 1;
      }
      tokens.push(token);
      continue;
    }
    if (character === '"') {
      let token = character;
      index += 1;
      while (index < source.length) {
        token += source[index];
        if (source[index] === '"') {
          if (source[index + 1] === '"') {
            token += source[index + 1];
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        index += 1;
      }
      tokens.push(token.toLowerCase());
      continue;
    }
    const operator = source.slice(index, index + 2);
    if ([">=", "<=", "<>", "!="].includes(operator)) {
      tokens.push(operator);
      index += 2;
      continue;
    }
    if (/[A-Za-z_]/.test(character)) {
      let token = character;
      index += 1;
      while (/[A-Za-z0-9_$]/.test(source[index] || "")) {
        token += source[index];
        index += 1;
      }
      tokens.push(token.toLowerCase());
      continue;
    }
    if (/[0-9]/.test(character)) {
      let token = character;
      index += 1;
      while (/[0-9.]/.test(source[index] || "")) {
        token += source[index];
        index += 1;
      }
      tokens.push(token);
      continue;
    }
    tokens.push(character);
    index += 1;
  }
  return tokens;
}

function isBoundary(token) {
  return token === "and" || token === "or" || token === ")" || token === undefined;
}

function normalizeAtom(tokens) {
  const compact = tokens.join("");
  const anyArray = compact.match(/^([a-z_][a-z0-9_$]*)=any\(array\[(.*)\]\)$/);
  return anyArray ? `${anyArray[1]}in(${anyArray[2]})` : compact;
}

function parseBooleanTokens(tokens) {
  let position = 0;

  function parseExpression() {
    let left = parseAnd();
    const children = [left];
    while (tokens[position] === "or") {
      position += 1;
      children.push(parseAnd());
    }
    return children.length === 1 ? left : { type: "or", children };
  }

  function parseAnd() {
    let left = parsePrimary();
    const children = [left];
    while (tokens[position] === "and") {
      position += 1;
      children.push(parsePrimary());
    }
    return children.length === 1 ? left : { type: "and", children };
  }

  function parsePrimary() {
    if (tokens[position] === "(") {
      const start = position;
      position += 1;
      const nested = parseExpression();
      if (tokens[position] === ")") {
        position += 1;
        if (isBoundary(tokens[position])) return nested;
      }
      position = start;
    }
    return parseAtom();
  }

  function parseAtom() {
    const atom = [];
    let depth = 0;
    let betweenPending = false;
    while (position < tokens.length) {
      const token = tokens[position];
      if (token === "(") depth += 1;
      if (token === ")" && depth === 0) break;
      if (depth === 0 && (token === "and" || token === "or")) {
        if (token === "and" && betweenPending) betweenPending = false;
        else break;
      }
      atom.push(token);
      if (token === "(") {
        // already counted above
      } else if (token === ")") depth -= 1;
      if (token === "between") betweenPending = true;
      position += 1;
    }
    if (!atom.length) throw new Error("Invalid schema CHECK definition.");
    return { type: "atom", value: normalizeAtom(atom) };
  }

  const expression = parseExpression();
  if (position !== tokens.length) throw new Error("Invalid schema CHECK definition.");
  return expression;
}

function withoutCheckWrapper(tokens) {
  if (tokens[0] !== "check" || tokens[1] !== "(") return tokens;
  if (tokens.at(-1) !== ")") return tokens;
  return tokens.slice(2, -1);
}

function serializeBooleanTree(node) {
  if (node.type === "atom") return node.value;
  return `${node.type}(${node.children.map(serializeBooleanTree).join(",")})`;
}

/**
 * Canonicalizes a CHECK as a boolean expression tree. It accepts harmless
 * formatting/cast differences from pg_get_constraintdef, but preserves every
 * predicate and its AND/OR grouping so weakened checks cannot look canonical.
 */
export function canonicalCheckDefinition(value) {
  const tokens = withoutCheckWrapper(tokenizeSchemaSql(value));
  return serializeBooleanTree(parseBooleanTokens(tokens));
}

/** Canonicalizes non-CHECK catalog definitions without dropping operators. */
export function canonicalSchemaDefinition(value) {
  return tokenizeSchemaSql(value).join("");
}
