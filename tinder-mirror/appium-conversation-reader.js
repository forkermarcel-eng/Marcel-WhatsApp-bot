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

/*
 * An Inbox row may expose a compact Tinder time label for its latest message.
 * Keep only an exact, unparsed label that is unambiguous in that one row;
 * relative/partial values must never be turned into an invented timestamp.
 */
function inboxTemporalLabel(texts) {
  const labels = texts.filter((value) => {
    const text = String(value || "").normalize("NFC").trim();
    const normalized = text.toLocaleLowerCase("de-DE");
    return /^\d{1,2}:\d{2}$/.test(text)
      || /^(?:heute|gestern|vorgestern)$/u.test(normalized)
      || /^(?:montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag|mo|di|mi|do|fr|sa|so)\.?$/u.test(normalized)
      || /^\d{1,2}\.\s*(?:jan(?:uar)?|feb(?:ruar)?|m(?:ä|ae)rz|apr(?:il)?|mai|jun(?:i)?|jul(?:i)?|aug(?:ust)?|sep(?:tember)?|okt(?:ober)?|nov(?:ember)?|dez(?:ember)?)\.?$/iu.test(text)
      || /^vor\s+\d+\s*(?:min(?:ute)?n?|std(?:unde)?n?|h|tag(?:en)?|woche(?:n)?|monat(?:en)?)$/iu.test(text);
  });
  const unique = [...new Set(labels)];
  return unique.length === 1 ? unique[0] : null;
}

function hasBottomComposer(nodes, screen) {
  return nodes.some((node) => /EditText$/.test(className(node))
    && node.bounds
    && node.bounds.top >= screen.bottom - Math.max(180, Math.round(screen.height * 0.16))
    && node.bounds.bottom <= screen.bottom - 40);
}

function isClickable(node) {
  return node?.attributes?.clickable === "true";
}

function hasClickableAncestor(node) {
  let current = node;
  while (current) {
    if (isClickable(current)) return true;
    current = current.parent || null;
  }
  return false;
}

/*
 * A text-bearing child of the Inbox RecyclerView can be a static section
 * label as well as a conversation row.  It is a permitted row target only
 * when UiAutomator2 exposes one unambiguous, row-sized clickable surface.
 * This is an actionability check, not a thread identifier or a legacy
 * wrapper/leaf-topology requirement.
 */
function inboxRowActionTarget(row) {
  if (!row?.bounds) return null;
  const candidates = [];
  const visit = (current) => {
    if (isClickable(current) && current.bounds && within(current.bounds, row.bounds)) {
      const horizontallyAligned = current.bounds.width >= Math.round(row.bounds.width * 0.9)
        && Math.abs(current.bounds.left - row.bounds.left) <= 8
        && Math.abs(current.bounds.right - row.bounds.right) <= 8;
      const verticallyAligned = current.bounds.height >= Math.round(row.bounds.height * 0.8)
        && Math.abs(current.bounds.top - row.bounds.top) <= 8
        && Math.abs(current.bounds.bottom - row.bounds.bottom) <= 8;
      if (horizontallyAligned && verticallyAligned) candidates.push(current);
    }
    for (const child of current.children || []) visit(child);
  };
  visit(row);

  // A parent and its clickable child can expose the exact same physical
  // surface.  Deduplicate that one surface, but refuse two genuinely
  // different actions within an otherwise text-bearing list item.
  const surfaces = new Map();
  for (const candidate of candidates) {
    const bounds = candidate.bounds;
    const key = `${bounds.left},${bounds.top},${bounds.right},${bounds.bottom}`;
    if (!surfaces.has(key)) surfaces.set(key, candidate);
  }
  return surfaces.size === 1 ? [...surfaces.values()][0] : null;
}

function inboxRowNodes(recycler, screen) {
  if (!recycler?.bounds || !screen) return [];
  const minimumWidth = Math.round(screen.width * 0.78);
  const maximumHeight = Math.min(240, Math.round(screen.height * 0.22));
  return (recycler.children || []).map((row) => {
    if (!row.bounds || !within(row.bounds, recycler.bounds)) return false;
    if (row.bounds.width < minimumWidth || row.bounds.height < 72 || row.bounds.height > maximumHeight) return false;
    if (subtreeTexts(row).length < 1) return false;
    const actionTarget = inboxRowActionTarget(row);
    return actionTarget ? { row, actionTarget } : false;
  }).filter(Boolean);
}

/*
 * The Inbox RecyclerView is selected from its visible, wide, text-bearing
 * rows rather than a resource ID or an old parent/leaf topology.  That keeps
 * the observation local and lets the caller use Appium's physical scroll on
 * the actual Inbox container only.
 */
function inboxRecycler(nodes, screen) {
  const candidates = nodes
    .filter((node) => /RecyclerView$/.test(className(node)) && node.bounds)
    .map((recycler) => {
      const rows = inboxRowNodes(recycler, screen);
      return {
        recycler,
        rows,
        score: rows.length * 1_000_000 + recycler.bounds.width * recycler.bounds.height
      };
    })
    .filter((candidate) => candidate.rows.length > 0)
    .sort((left, right) => right.score - left.score);
  if (!candidates.length) return null;

  // Two visually equivalent vertical targets would make a physical scroll
  // ambiguous. Refuse instead of choosing one by incidental XML order.
  if (candidates.length > 1 && candidates[0].score === candidates[1].score) return null;
  return candidates[0];
}

function inboxRowObservation({ row, actionTarget }) {
  const texts = subtreeTexts(row);
  return {
    // The row container is retained only in the RAM continuity key below.
    // Appium physical input targets the freshly observed action surface.
    bounds: Object.freeze({ ...actionTarget.bounds }),
    match_cta: isMatchCta(texts),
    last_message_visible_time: inboxTemporalLabel(texts),
    // This remains an opaque, process-local continuity key. It is never a
    // Tinder identity and never crosses the adapter/transport boundary.
    ram_key: JSON.stringify({
      top: row.bounds.top,
      bottom: row.bounds.bottom,
      texts
    })
  };
}

function profileScrollContainer(nodes, screen) {
  const candidates = nodes
    .filter((node) => {
      const bounds = node.bounds;
      if (!bounds || !within(bounds, screen)) return false;
      if (!/(?:ScrollView|RecyclerView)$/.test(className(node))) return false;
      if (bounds.width < Math.round(screen.width * 0.7) || bounds.height < Math.round(screen.height * 0.3)) return false;
      return bounds.top >= screen.top + 80 && bounds.bottom <= screen.bottom - 40;
    })
    .sort((left, right) => (right.bounds.width * right.bounds.height) - (left.bounds.width * left.bounds.height));
  if (!candidates.length) return null;
  if (candidates.length > 1
    && candidates[0].bounds.width * candidates[0].bounds.height === candidates[1].bounds.width * candidates[1].bounds.height) {
    return null;
  }
  return candidates[0];
}

function profileMediaMarker(nodes, screen) {
  const candidates = nodes.filter((node) => {
    const bounds = node.bounds;
    if (!bounds || !within(bounds, screen)) return false;
    if (!/ViewPager2?$/.test(className(node))) return false;
    return bounds.width >= Math.round(screen.width * 0.7)
      && bounds.height >= Math.round(screen.height * 0.15)
      && bounds.top >= screen.top + 40
      && bounds.bottom <= screen.bottom - 40;
  });
  return candidates.length === 1 ? candidates[0] : null;
}

function sameScrollSurface(left, right) {
  if (!left || !right) return false;
  const tolerance = 8;
  return Math.abs(left.left - right.left) <= tolerance
    && Math.abs(left.right - right.right) <= tolerance
    && Math.abs(left.top - right.top) <= tolerance
    && Math.abs(left.bottom - right.bottom) <= tolerance;
}

function profileBodyTexts(nodes, container) {
  const seen = new Set();
  return nodes
    .filter((node) => {
      const text = visibleText(node);
      if (!text || !node.bounds || !/TextView$/.test(className(node))) return false;
      if (!descendantOf(node, container) || !within(node.bounds, container.bounds)) return false;
      return !hasClickableAncestor(node);
    })
    .sort((left, right) => left.bounds.top - right.bounds.top || left.bounds.left - right.bounds.left)
    .map(visibleText)
    .filter((text) => {
      if (seen.has(text)) return false;
      seen.add(text);
      return true;
    });
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
 * A profile may only be opened from a freshly observed ordinary Tinder
 * conversation. The accepted target is the one compact, described,
 * clickable avatar in the header's profile band. Navigation controls and
 * the overflow menu deliberately fall outside that band.
 */
export function headerProfileTargetFromXml(xml) {
  const root = parseUiAutomatorXml(xml);
  const screen = screenBounds(root);
  const nodes = flattenUiNodes(root);
  const recycler = candidateRecycler(nodes);
  const conversation = observeConversationViewportFromXml(xml);
  if (!screen || !recycler?.bounds || !conversation) return null;

  const targets = nodes.filter((node) => {
    const bounds = node.bounds;
    if (!bounds || descendantOf(node, recycler)) return false;
    if (!/ImageView$/.test(className(node)) || !isClickable(node)) return false;
    if (!String(node.attributes?.["content-desc"] || "").trim()) return false;

    const headerBand = bounds.top >= screen.top + 40 && bounds.bottom <= screen.top + 180;
    const profileBand = bounds.left >= screen.left + Math.round(screen.width * 0.14)
      && bounds.right <= screen.left + Math.round(screen.width * 0.48);
    const compact = bounds.width >= 40 && bounds.width <= 100 && bounds.height >= 40 && bounds.height <= 100;
    return headerBand && profileBand && compact;
  });
  if (targets.length !== 1) return null;
  return Object.freeze({ ...targets[0].bounds });
}

/*
 * Reduces a verified Tinder profile screen to ordinary visible profile
 * product data. The caller supplies the chat-header value observed directly
 * before profile navigation as direct navigation continuity; Tinder's
 * profile surface need not expose that header value itself. A profile is
 * accepted only when it has no composer/conversation projection, one large
 * scroll surface, and one regular ViewPager media region. No content
 * description, node ID, image reference, or tree shape is returned.
 * Attribute keys intentionally describe only their visible order.
 */
export function observeProfileFromXml(xml, {
  expectedDisplayName = null,
  continuedProfileScroll = false,
  expectedScrollBounds = null
} = {}) {
  const root = parseUiAutomatorXml(xml);
  const screen = screenBounds(root);
  const nodes = flattenUiNodes(root);
  const expected = typeof expectedDisplayName === "string" ? expectedDisplayName.normalize("NFC").trim() : "";
  if (!screen || !expected || expected.length > 160 || hasBottomComposer(nodes, screen)
    || observeConversationViewportFromXml(xml)) return null;

  const container = profileScrollContainer(nodes, screen);
  const media = profileMediaMarker(nodes, screen);
  // The opening surface must show Tinder's regular profile media region. Once
  // that surface has been verified and its own ScrollView has been scrolled,
  // the pager can legitimately move off-screen; keep only the same physical
  // scroll surface and ordinary no-composer/no-chat checks for that direct
  // local continuation.
  if (!container?.bounds || (!media?.bounds && !continuedProfileScroll)) return null;
  if (continuedProfileScroll && expectedScrollBounds && !sameScrollSurface(container.bounds, expectedScrollBounds)) return null;
  const bodyTexts = profileBodyTexts(nodes, container);

  const attributes = {};
  for (const text of bodyTexts) {
    if (Object.values(attributes).includes(text)) continue;
    // Keep the existing Block-2 product-profile field convention so an
    // initial, safely compatible profile viewport can recognize a known
    // thread without an unnecessary full profile/history read.
    const key = `visible_profile_${String(Object.keys(attributes).length + 1).padStart(2, "0")}`;
    attributes[key] = text;
    if (Object.keys(attributes).length >= 32) break;
  }

  return Object.freeze({
    profile: Object.freeze({
      display_name: expected,
      attributes: Object.freeze(attributes),
      media_refs: Object.freeze([])
    }),
    scroll_bounds: Object.freeze({ ...container.bounds })
  });
}

/*
 * A semantic Inbox observation includes the one verified physical vertical
 * target needed by the normal initial mirror. It remains separate from the
 * legacy rows-only export below so current corrective callers keep their
 * exact API.
 */
export function observeInboxFromXml(xml) {
  const root = parseUiAutomatorXml(xml);
  const screen = screenBounds(root);
  const nodes = flattenUiNodes(root);
  if (!screen || hasBottomComposer(nodes, screen)) return null;

  const inbox = inboxRecycler(nodes, screen);
  if (!inbox?.recycler?.bounds) return null;
  const rows = inbox.rows
    .map(inboxRowObservation)
    .filter((row) => !row.match_cta);
  return Object.freeze({
    rows: Object.freeze(rows),
    scroll_bounds: Object.freeze({ ...inbox.recycler.bounds })
  });
}

function descendantCount(node, expression) {
  let count = 0;
  const visit = (current) => {
    if (expression.test(className(current))) count += 1;
    for (const child of current.children || []) visit(child);
  };
  visit(node);
  return count;
}

function hasClickableDescendant(node) {
  let found = false;
  const visit = (current) => {
    if (isClickable(current)) found = true;
    for (const child of current.children || []) visit(child);
  };
  visit(node);
  return found;
}

function visibleMatchTile(node, screen) {
  if (!node?.bounds || !screen || !within(node.bounds, screen)) return null;
  const texts = subtreeTexts(node);
  const normalized = texts.map((text) => text.normalize("NFC").trim()).filter(Boolean);
  const combined = normalized.join("\n").toLocaleLowerCase("de-DE");
  // The Likes aggregate is not an individual Match.  A real tile must expose
  // one visible text value and its own regular compact image/control shape.
  if (!normalized.length || /\b(?:likes|gefällt)\b/u.test(combined)) return null;
  if (descendantCount(node, /ImageView$/) < 1 || !hasClickableDescendant(node)) return null;
  if (node.bounds.width < Math.round(screen.width * 0.12)
    || node.bounds.width > Math.round(screen.width * 0.46)
    || node.bounds.height < 72
    || node.bounds.height > Math.round(screen.height * 0.35)) return null;

  const attributes = Object.fromEntries(normalized.slice(1, 33).map((value, index) => [
    `visible_tile_${String(index + 1).padStart(2, "0")}`,
    value
  ]));
  return Object.freeze({
    tile: Object.freeze({
      display_name: normalized[0],
      attributes: Object.freeze(attributes),
      media_refs: Object.freeze([])
    }),
    ram_key: JSON.stringify({
      left: node.bounds.left,
      top: node.bounds.top,
      right: node.bounds.right,
      bottom: node.bounds.bottom,
      texts: normalized
    })
  });
}

/*
 * The New-Matches carousel is a separate, compact horizontal RecyclerView
 * nested in the verified Inbox.  It is not a normal message row and exposes
 * no tap target from this observer.  The caller may use only its own fresh
 * scroll bounds for a read-only horizontal inventory.
 */
export function observeMatchCarouselFromXml(xml) {
  const root = parseUiAutomatorXml(xml);
  const screen = screenBounds(root);
  const nodes = flattenUiNodes(root);
  if (!screen || hasBottomComposer(nodes, screen)) return null;
  const inbox = inboxRecycler(nodes, screen);
  if (!inbox?.recycler?.bounds) return null;

  const candidates = nodes
    .filter((node) => /RecyclerView$/.test(className(node)) && node !== inbox.recycler && node.bounds)
    .map((carousel) => ({
      carousel,
      tiles: (carousel.children || []).map((child) => visibleMatchTile(child, screen)).filter(Boolean)
    }))
    .filter(({ carousel, tiles }) => within(carousel.bounds, inbox.recycler.bounds)
      && carousel.bounds.width >= Math.round(screen.width * 0.82)
      && carousel.bounds.height >= 96
      && carousel.bounds.height <= Math.round(screen.height * 0.36)
      && tiles.length > 0)
    .sort((left, right) => right.tiles.length - left.tiles.length
      || (right.carousel.bounds.width * right.carousel.bounds.height) - (left.carousel.bounds.width * left.carousel.bounds.height));
  if (!candidates.length) return null;
  if (candidates.length > 1 && candidates[0].tiles.length === candidates[1].tiles.length
    && candidates[0].carousel.bounds.width * candidates[0].carousel.bounds.height
      === candidates[1].carousel.bounds.width * candidates[1].carousel.bounds.height) return null;
  return Object.freeze({
    tiles: Object.freeze(candidates[0].tiles),
    scroll_bounds: Object.freeze({ ...candidates[0].carousel.bounds })
  });
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
