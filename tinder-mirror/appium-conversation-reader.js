import { messagesEqual } from "./conversation.js";
import {
  classifyMessageTextNode,
  flattenUiNodes,
  parseUiAutomatorXml,
  screenBounds
} from "./appium-ui-observer.js";

function className(node) {
  return String(node?.attributes?.class || "");
}

function visibleText(node) {
  const text = String(node?.attributes?.text || "").normalize("NFC").trim();
  return text || null;
}

function within(inner, outer) {
  return Boolean(inner && outer
    && inner.left >= outer.left && inner.top >= outer.top
    && inner.right <= outer.right && inner.bottom <= outer.bottom);
}

function descendantOf(node, ancestor) {
  let current = node?.parent || null;
  while (current) {
    if (current === ancestor) return true;
    current = current.parent;
  }
  return false;
}

function compactHeaderText(nodes, recycler) {
  const candidates = nodes.filter((node) => {
    const text = visibleText(node);
    if (!text || !node.bounds || !recycler?.bounds) return false;
    return node.bounds.bottom <= recycler.bounds.top
      && node.bounds.top >= 40
      && node.bounds.left >= 80
      && node.bounds.right <= recycler.bounds.right - 80
      && /TextView$/.test(className(node));
  });
  if (candidates.length !== 1) return null;
  return visibleText(candidates[0]);
}

function candidateRecycler(nodes) {
  const candidates = nodes.filter((node) => /RecyclerView$/.test(className(node)) && node.bounds);
  if (!candidates.length) return null;
  const sorted = candidates.slice().sort((left, right) => (right.bounds.width * right.bounds.height) - (left.bounds.width * left.bounds.height));
  return sorted[0];
}

function subtreeTexts(node) {
  const texts = [];
  const visit = (current) => {
    const text = visibleText(current);
    if (text) texts.push(text);
    for (const child of current.children || []) visit(child);
  };
  visit(node);
  return texts;
}

function isMatchCta(texts) {
  const combined = texts.join("\n").toLocaleLowerCase("de-DE");
  return /\bmag dich\b|\bjetzt matchen\b|\bmatchen\b/.test(combined);
}

function hasBottomComposer(nodes, screen) {
  return nodes.some((node) => /EditText$/.test(className(node))
    && node.bounds
    && node.bounds.top >= screen.bottom - Math.max(180, Math.round(screen.height * 0.16))
    && node.bounds.bottom <= screen.bottom - 40);
}

/*
 * Reduces one fresh Appium XML snapshot to ordinary product messages.  The
 * XML remains local: resource IDs, node IDs, content descriptions and the
 * raw hierarchy do not leave this function.
 */
export function observeConversationViewportFromXml(xml) {
  const root = parseUiAutomatorXml(xml);
  const screen = screenBounds(root);
  const nodes = flattenUiNodes(root);
  const recycler = candidateRecycler(nodes);
  if (!screen || !recycler?.bounds || !hasBottomComposer(nodes, screen)) return null;

  const dedupe = new Set();
  const messages = [];
  for (const node of nodes) {
    const text = visibleText(node);
    if (!text || !node.bounds || !/TextView$/.test(className(node))) continue;
    if (!descendantOf(node, recycler) || !within(node.bounds, recycler.bounds)) continue;
    const direction = classifyMessageTextNode(node, screen);
    if (!direction) continue;
    const key = `${node.bounds.left},${node.bounds.top},${node.bounds.right},${node.bounds.bottom}:${direction}:${text}`;
    if (dedupe.has(key)) continue;
    dedupe.add(key);
    messages.push({
      direction,
      text,
      visible_time: null,
      visible_status: null,
      bounds: node.bounds
    });
  }
  messages.sort((left, right) => left.bounds.top - right.bounds.top || left.bounds.left - right.bounds.left);
  return Object.freeze({
    profile_display_name: compactHeaderText(nodes, recycler),
    messages: Object.freeze(messages.map(({ bounds, ...message }) => Object.freeze(message))),
    scroll_bounds: Object.freeze({ ...recycler.bounds })
  });
}

/* Exact local comparison for physical no-progress confirmation; never persisted. */
export function sameObservedViewport(left, right) {
  return Boolean(left && right
    && left.messages.length === right.messages.length
    && left.messages.every((message, index) => messagesEqual(message, right.messages[index])));
}

/* A back target is accepted only from the fresh visible Tinder conversation header. */
export function headerBackTargetFromXml(xml) {
  const root = parseUiAutomatorXml(xml);
  const screen = screenBounds(root);
  const nodes = flattenUiNodes(root);
  if (!screen) return null;
  const targets = nodes.filter((node) => {
    const bounds = node.bounds;
    if (!bounds) return false;
    const topBand = bounds.top >= screen.top + 40 && bounds.bottom <= screen.top + 160;
    const leftBand = bounds.left >= screen.left && bounds.right <= screen.left + 100;
    const compact = bounds.width >= 20 && bounds.width <= 100 && bounds.height >= 20 && bounds.height <= 100;
    return topBand && leftBand && compact && node.attributes?.clickable === "true";
  });
  if (targets.length !== 1) return null;
  return Object.freeze({ ...targets[0].bounds });
}

/*
 * Each candidate is one fresh visible row from the main vertical Inbox list.
 * New-match tiles, section labels and Match-/Like-CTA rows are excluded.  The
 * opaque RAM key is only for avoiding a repeat tap in the same live run.
 */
export function observeInboxConversationRowsFromXml(xml) {
  const root = parseUiAutomatorXml(xml);
  const screen = screenBounds(root);
  const nodes = flattenUiNodes(root);
  if (!screen || hasBottomComposer(nodes, screen)) return [];
  const main = candidateRecycler(nodes);
  if (!main?.bounds) return [];
  return (main.children || [])
    .filter((row) => row.bounds
      && row.bounds.width >= screen.width * 0.9
      && row.bounds.height >= 80
      && row.bounds.height <= 180
      && within(row.bounds, main.bounds))
    .map((row) => {
      const texts = subtreeTexts(row);
      return {
        bounds: Object.freeze({ ...row.bounds }),
        match_cta: isMatchCta(texts),
        ram_key: JSON.stringify({
          top: row.bounds.top,
          bottom: row.bounds.bottom,
          texts
        })
      };
    })
    .filter((row) => !row.match_cta);
}
