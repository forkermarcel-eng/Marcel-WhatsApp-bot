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

/*
 * These are deliberately bounded product projections, rather than a raw UI
 * export. The old 32-value ceiling can truncate a regular long profile once
 * its section headings and interests are visible. The collections below are
 * still only ordinary visible profile data; they are not a schema or an
 * identity interpretation.
 */
const MAX_VISIBLE_PROFILE_VALUES = 64;
const MAX_STRUCTURED_PROFILE_PAIRS = 32;
const MAX_PROFILE_SECTIONS = 32;
const MAX_PROFILE_CHIPS = 64;

function profileBodyTextNodes(nodes, container) {
  return nodes
    .filter((node) => {
      const text = visibleText(node);
      if (!text || !node.bounds || !/TextView$/.test(className(node))) return false;
      if (!descendantOf(node, container) || !within(node.bounds, container.bounds)) return false;
      return !hasClickableAncestor(node);
    })
    .sort((left, right) => left.bounds.top - right.bounds.top || left.bounds.left - right.bounds.left);
}

function nearestClickableAncestor(node, container) {
  let current = node;
  while (current && current !== container) {
    if (isClickable(current)) return current;
    current = current.parent || null;
  }
  return null;
}

/*
 * A profile chip is identified only from its ordinary compact clickable
 * geometry, never from a translated label, a resource id, or a known
 * interest name. Wide profile actions are not tags/chips.
 */
function isProfileChipTarget(target, container) {
  if (!target?.bounds || !container?.bounds || !within(target.bounds, container.bounds)) return false;
  const bounds = target.bounds;
  return bounds.width >= 20
    && bounds.height >= 20
    && bounds.width <= Math.round(container.bounds.width * 0.72)
    && bounds.height <= Math.max(120, Math.round(container.bounds.height * 0.2));
}

/*
 * UiAutomator2 may expose a compact Tinder chip either as a TextView/Chip or
 * as the directly clickable generic View carrying its visible text.  Keep the
 * projection structural: a generic View is admitted only when it is a text
 * leaf, so a container whose child supplies the same text is never counted a
 * second time.
 */
function isChipTextNode(node) {
  if (!visibleText(node)) return false;
  const name = className(node);
  if (/(?:TextView|Chip|Button)$/.test(name)) return true;
  if (!/View$/.test(name)) return false;
  return !(node.children || []).some((child) => visibleText(child));
}

function chipTargetKey(target) {
  const bounds = target?.bounds;
  return bounds ? `${bounds.left},${bounds.top},${bounds.right},${bounds.bottom}` : null;
}

function compactSingleTextParent(node, container) {
  const parent = node?.parent;
  if (!parent || parent === container || !isProfileChipTarget(parent, container)) return false;
  return (parent.children || []).filter((child) => visibleText(child)).length === 1;
}

function profileChipTarget(node, container) {
  const clickableTarget = nearestClickableAncestor(node, container);
  if (isProfileChipTarget(clickableTarget, container)) {
    return { target: clickableTarget, needsDenseCollection: false, collectionTarget: null };
  }
  // Current Tinder can put several compact text chips inside one wide
  // clickable collection wrapper. The wrapper itself is not a chip-sized
  // target, but each ordinary compact text leaf is. Require the same dense
  // collection evidence as inert chips: a wide profile row with one text is
  // not an interest just because it happens to be clickable.
  if (clickableTarget && isProfileChipTarget(node, container)) {
    return { target: node, needsDenseCollection: true, collectionTarget: clickableTarget };
  }
  // Tinder can also render inert text chips in compact one-text wrappers.
  // Unlike interactive chips, those need a dense local collection (three or
  // more members) so a normal solitary profile field or label/value pair is
  // never promoted to an interest.
  if (!clickableTarget && isProfileChipTarget(node, container) && compactSingleTextParent(node, container)) {
    return { target: node, needsDenseCollection: true, collectionTarget: null };
  }
  return null;
}

/*
 * A directly clickable text surface can be a regular compact tag in current
 * Tinder layouts. Require it to be part of a three-member compact cluster,
 * so a lone or paired profile action is not projected as an interest. Text
 * children of a compact clickable wrapper remain valid on their own, as
 * before.
 */
function directChipPeerCount(target, targets) {
  if (!target?.bounds) return false;
  return targets.filter((candidate) => {
    if (candidate === target || !candidate?.bounds) return false;
    const leftCenter = (target.bounds.top + target.bounds.bottom) / 2;
    const rightCenter = (candidate.bounds.top + candidate.bounds.bottom) / 2;
    const sameRow = Math.abs(leftCenter - rightCenter) <= Math.max(32, target.bounds.height, candidate.bounds.height);
    const verticalGap = Math.max(candidate.bounds.top - target.bounds.bottom, target.bounds.top - candidate.bounds.bottom);
    // Wrapped chips form a compact cluster.  A distant lone action below the
    // collection must not borrow the preceding chip row as its peer.
    const adjacentRows = verticalGap >= -8 && verticalGap <= Math.max(
      48,
      Math.min(80, Math.round(Math.max(target.bounds.height, candidate.bounds.height) * 1.5))
    );
    return sameRow || adjacentRows;
  }).length;
}

function profileChipTextNodes(nodes, container) {
  const candidates = nodes
    .filter((node) => {
      if (!node.bounds || !isChipTextNode(node)) return false;
      return descendantOf(node, container) && within(node.bounds, container.bounds);
    })
    .map((node) => ({ node, ...profileChipTarget(node, container) }))
    .filter(({ target }) => Boolean(target));
  const targets = [...new Map(candidates
    .map(({ target }) => [chipTargetKey(target), target])
    .filter(([key]) => key)).values()];
  const collectionMemberCounts = new Map();
  for (const { node, collectionTarget } of candidates) {
    const key = chipTargetKey(collectionTarget);
    if (!key) continue;
    const members = collectionMemberCounts.get(key) || new Set();
    members.add(`${node.bounds.left},${node.bounds.top},${node.bounds.right},${node.bounds.bottom}:${visibleText(node)}`);
    collectionMemberCounts.set(key, members);
  }
  const seen = new Set();
  return candidates
    .filter(({ node, target, needsDenseCollection, collectionTarget }) => {
      const text = visibleText(node);
      // A directly clickable TextView or generic View is accepted only as a
      // member of a visible compact collection. A material Chip itself, or a
      // text child of a compact clickable wrapper, remains independently
      // valid because that wrapper is already the ordinary chip structure.
      const peerCount = directChipPeerCount(target, targets);
      const collectionCount = chipTargetKey(collectionTarget)
        ? collectionMemberCounts.get(chipTargetKey(collectionTarget))?.size || 0
        : 0;
      if (needsDenseCollection && collectionTarget && collectionCount < 3) return false;
      if (target === node && !/Chip$/.test(className(node))
        && !collectionTarget && peerCount < 2) return false;
      const key = `${target.bounds.left},${target.bounds.top},${target.bounds.right},${target.bounds.bottom}:${text}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map(({ node }) => node)
    .sort((left, right) => left.bounds.top - right.bounds.top || left.bounds.left - right.bounds.left);
}

/*
 * Tinder can initially collapse a dense visible interest collection behind a
 * regular in-profile "show all N" control. It is not a field, an identity
 * signal, or an external action. We accept it only when one numbered, wide
 * clickable row immediately follows a dense compact chip cluster in the
 * same verified profile scroll surface. The actual language is deliberately
 * not inspected, so this stays valid across Tinder localisations.
 */
function profileChipExpansionBounds(nodes, container, chipNodes) {
  if (!container?.bounds || chipNodes.length < 3) return null;
  const chipBottom = Math.max(...chipNodes.map((node) => node.bounds.bottom));
  const maximumGap = Math.max(96, Math.round(container.bounds.height * 0.18));
  const seen = new Map();
  for (const node of nodes) {
    const text = visibleText(node);
    if (!text || !/\p{N}/u.test(text) || !node.bounds) continue;
    if (!descendantOf(node, container) || !within(node.bounds, container.bounds)) continue;
    const target = nearestClickableAncestor(node, container);
    if (!target?.bounds || !isClickable(target) || !within(target.bounds, container.bounds)) continue;
    const wideRow = target.bounds.width >= Math.round(container.bounds.width * 0.72)
      && target.bounds.height >= 28
      && target.bounds.height <= Math.max(120, Math.round(container.bounds.height * 0.14));
    const followsCollection = target.bounds.top >= chipBottom - 12
      && target.bounds.top - chipBottom <= maximumGap;
    if (!wideRow || !followsCollection) continue;
    const key = chipTargetKey(target);
    if (key) seen.set(key, target);
  }
  const targets = [...seen.values()];
  return targets.length === 1 ? Object.freeze({ ...targets[0].bounds }) : null;
}

function profileProjectedTextNodes(bodyNodes, chipNodes) {
  return [...bodyNodes, ...chipNodes]
    .sort((left, right) => left.bounds.top - right.bounds.top || left.bounds.left - right.bounds.left);
}

function profileBodyTexts(bodyNodes) {
  const seen = new Set();
  return bodyNodes
    .map(visibleText)
    .filter((text) => {
      if (seen.has(text)) return false;
      seen.add(text);
      return true;
    });
}

/*
 * UiAutomator2 exposes Android's regular heading semantic on visible
 * TextViews. A structured field is accepted only when that visible heading
 * is immediately followed in the same verified profile surface by one
 * ordinary, non-heading TextView. This is display structure, not profile
 * identity, a capture, or a heuristic inferred from text content.
 */
function isVisibleProfileLabel(node) {
  return node?.attributes?.heading === "true"
    || node?.attributes?.["accessibility-heading"] === "true";
}

function profileTextNeighbors(left, right) {
  if (!left?.bounds || !right?.bounds || isVisibleProfileLabel(right)) return false;
  const verticalGap = right.bounds.top - left.bounds.bottom;
  const sameLine = Math.abs((left.bounds.top + left.bounds.bottom) - (right.bounds.top + right.bounds.bottom))
    <= Math.max(40, left.bounds.height + right.bounds.height);
  return sameLine || (verticalGap >= -8 && verticalGap <= Math.max(128, left.bounds.height * 3));
}

function profilePairGeometry(left, right) {
  if (!left?.bounds || !right?.bounds) return false;
  const verticalCentersClose = Math.abs(
    (left.bounds.top + left.bounds.bottom) / 2 - (right.bounds.top + right.bounds.bottom) / 2
  ) <= Math.max(40, left.bounds.height + right.bounds.height);
  const horizontalNeighbor = verticalCentersClose && right.bounds.left >= left.bounds.left - 8;
  const verticalNeighbor = right.bounds.top >= left.bounds.bottom - 8
    && right.bounds.top - left.bounds.bottom <= Math.max(128, left.bounds.height * 3);
  return horizontalNeighbor || verticalNeighbor;
}

function headerAgeNeighbor(nameNode, ageNode) {
  if (!nameNode?.bounds || !ageNode?.bounds) return false;
  const verticalCentersClose = Math.abs(
    (nameNode.bounds.top + nameNode.bounds.bottom) / 2 - (ageNode.bounds.top + ageNode.bounds.bottom) / 2
  ) <= Math.max(40, nameNode.bounds.height + ageNode.bounds.height);
  return verticalCentersClose && ageNode.bounds.left >= nameNode.bounds.left - 8;
}

function containerTextPairs(bodyNodes, profileContainer) {
  const pairs = [];
  const seenContainers = new Set();
  for (const node of bodyNodes) {
    let current = node.parent || null;
    while (current && current !== profileContainer) {
      if (!current.bounds) {
        current = current.parent || null;
        continue;
      }
      const containerKey = `${current.bounds.left},${current.bounds.top},${current.bounds.right},${current.bounds.bottom}`;
      if (seenContainers.has(containerKey)) {
        current = current.parent || null;
        continue;
      }
      seenContainers.add(containerKey);
      const contained = bodyNodes.filter((candidate) => descendantOf(candidate, current)
        && within(candidate.bounds, current.bounds));
      // A small two-text layout is a regular label/value container. The
      // complete ScrollView and media wrappers are excluded by cardinality and
      // compact height, so a profile body is never promoted as one field.
      if (contained.length === 2
        && current.bounds.height <= Math.max(240, Math.round(profileContainer.bounds.height * 0.3))) {
        const [left, right] = contained.slice().sort((first, second) => first.bounds.top - second.bounds.top
          || first.bounds.left - second.bounds.left);
        if (profilePairGeometry(left, right)) pairs.push({ labelNode: left, valueNode: right });
      }
      current = current.parent || null;
    }
  }
  return pairs;
}

function structuredProfilePairs(bodyNodes, profileContainer) {
  const pairs = [];
  const seen = new Set();
  const candidatePairs = [];
  const containerPairs = containerTextPairs(bodyNodes, profileContainer);
  const containerLabels = new Set(containerPairs.map(({ labelNode }) => labelNode));
  for (let index = 0; index + 1 < bodyNodes.length; index += 1) {
    const labelNode = bodyNodes[index];
    const valueNode = bodyNodes[index + 1];
    if (!isVisibleProfileLabel(labelNode) || !profileTextNeighbors(labelNode, valueNode)) continue;
    // A section heading can be immediately followed by the label of a
    // separately structured field.  That field's compact two-text container
    // is the more specific regular UI structure, so the section must not
    // consume its label as a value merely because both are vertically close.
    if (containerLabels.has(valueNode)) continue;
    candidatePairs.push({ labelNode, valueNode });
  }
  candidatePairs.push(...containerPairs);
  for (const { labelNode, valueNode } of candidatePairs) {
    if (pairs.length >= MAX_STRUCTURED_PROFILE_PAIRS) break;
    const label = visibleText(labelNode);
    const value = visibleText(valueNode);
    if (!label || !value) continue;
    const key = `${label}\u0000${value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pairs.push(Object.freeze({ label, value }));
  }
  return pairs;
}

function profileSectionContexts(bodyNodes) {
  const sections = [];
  const seen = new Set();
  for (const node of bodyNodes) {
    if (!isVisibleProfileLabel(node)) continue;
    const text = visibleText(node);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    sections.push(text);
    if (sections.length >= MAX_PROFILE_SECTIONS) break;
  }
  return sections;
}

function escapeRegularExpression(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function ageText(value) {
  const text = String(value || "").normalize("NFC").trim();
  return /^\d{1,3}$/.test(text) ? text : null;
}

/*
 * Tinder can expose the regular name/age header as one node or as two visual
 * neighbours on the media surface. We only project it when that surface
 * visibly confirms the direct-navigation name; a number elsewhere in the
 * profile is never treated as an age.
 */
function profileHeaderProjection(nodes, media, expectedDisplayName, screen) {
  if (!media?.bounds || !expectedDisplayName || !screen) return { name: null, age: null };
  const expected = expectedDisplayName.normalize("NFC").trim();
  const headerBandInset = Math.max(96, Math.round(media.bounds.height * 0.16));
  const headerBandTop = Math.max(screen.top, media.bounds.top - headerBandInset);
  const headerBandBottom = media.bounds.bottom + Math.max(96, Math.round(media.bounds.height * 0.16));
  /*
   * Tinder may render the visible name/age overlay as a sibling of the
   * profile ScrollView, inside a clickable media wrapper.  It is still the
   * same regular header surface, but intentionally excluded from ordinary
   * profile-body values.  Inspect only TextViews in the bounded media-header
   * band and require the direct chat-name continuity below; no arbitrary
   * number elsewhere in a profile can become an age.
   */
  const candidates = nodes.filter((node) => /TextView$/.test(className(node))
    && visibleText(node)
    && node.bounds
    && within(node.bounds, screen)
    && node.bounds.top <= headerBandBottom
    && node.bounds.bottom >= headerBandTop);
  const named = [];
  const nameWithTrailingSeparator = new RegExp(`^${escapeRegularExpression(expected)}\\s*[,\\u00b7]$`, "u");
  for (const node of candidates) {
    const text = visibleText(node);
    if (!text) continue;
    if (text === expected) named.push({ node, age: null });
    if (nameWithTrailingSeparator.test(text)) named.push({ node, age: null });
    const combined = new RegExp(`^${escapeRegularExpression(expected)}\\s*[,\\u00b7]\\s*(\\d{1,3})$`, "u").exec(text);
    if (combined) named.push({ node, age: combined[1] });
  }
  if (named.length !== 1) return { name: null, age: null };
  const header = named[0];
  if (header.age) return { name: expected, age: header.age };
  const nearbyAges = candidates
    .filter((node) => node !== header.node && headerAgeNeighbor(header.node, node))
    .map((node) => ageText(visibleText(node)))
    .filter(Boolean);
  const uniqueAges = [...new Set(nearbyAges)];
  return { name: expected, age: uniqueAges.length === 1 ? uniqueAges[0] : null };
}

function profileAttributes(bodyTexts, pairs, { header = {}, sections = [], chips = [] } = {}) {
  const attributes = {};
  for (const text of bodyTexts.slice(0, MAX_VISIBLE_PROFILE_VALUES)) {
    const key = `visible_profile_${String(Object.keys(attributes).length + 1).padStart(2, "0")}`;
    attributes[key] = text;
  }
  for (const [index, pair] of pairs.entries()) {
    const ordinal = String(index + 1).padStart(2, "0");
    attributes[`structured_profile_${ordinal}_label`] = pair.label;
    attributes[`structured_profile_${ordinal}_value`] = pair.value;
  }
  if (header.name) attributes.header_profile_name = header.name;
  if (header.age) attributes.header_profile_age = header.age;
  for (const [index, section] of sections.entries()) {
    attributes[`profile_section_${String(index + 1).padStart(2, "0")}`] = section;
  }
  for (const [index, chip] of chips.entries()) {
    attributes[`profile_chip_${String(index + 1).padStart(2, "0")}`] = chip;
  }
  return attributes;
}

function profileVisibleValues(profile) {
  const attributes = profile?.attributes || {};
  const ordered = Object.entries(attributes)
    .map(([key, value]) => ({ match: /^visible_profile_(\d{2})$/.exec(key), value }))
    .filter(({ match, value }) => match && typeof value === "string")
    .sort((left, right) => Number(left.match[1]) - Number(right.match[1]))
    .map(({ value }) => value);
  if (ordered.length) return ordered;
  return Object.entries(attributes)
    .filter(([key, value]) => !/^structured_profile_\d{2}_(?:label|value)$/.test(key) && typeof value === "string")
    .map(([, value]) => value);
}

function profileStructuredPairs(profile) {
  const attributes = profile?.attributes || {};
  const pairs = [];
  for (const [key, label] of Object.entries(attributes)) {
    const match = /^structured_profile_(\d{2})_label$/.exec(key);
    if (!match || typeof label !== "string") continue;
    const value = attributes[`structured_profile_${match[1]}_value`];
    if (typeof value !== "string") continue;
    pairs.push({ ordinal: Number(match[1]), label, value });
  }
  return pairs.sort((left, right) => left.ordinal - right.ordinal);
}

function orderedProfileValues(profile, expression) {
  const attributes = profile?.attributes || {};
  return Object.entries(attributes)
    .map(([key, value]) => ({ match: expression.exec(key), value }))
    .filter(({ match, value }) => match && typeof value === "string")
    .sort((left, right) => Number(left.match[1]) - Number(right.match[1]))
    .map(({ value }) => value);
}

function profileSectionValues(profile) {
  return orderedProfileValues(profile, /^profile_section_(\d{2})$/);
}

function profileChipValues(profile) {
  return orderedProfileValues(profile, /^profile_chip_(\d{2})$/);
}

function profileHeaderValues(profile) {
  const attributes = profile?.attributes || {};
  return {
    name: typeof attributes.header_profile_name === "string" ? attributes.header_profile_name : null,
    age: typeof attributes.header_profile_age === "string" ? attributes.header_profile_age : null
  };
}

function uniqueProfileValues(values, maximum, errorMessage) {
  const unique = [];
  for (const value of values) {
    if (!unique.includes(value)) unique.push(value);
  }
  if (unique.length > maximum) throw new Error(errorMessage);
  return unique;
}

function uniqueProfilePairs(pairs) {
  const unique = [];
  const seen = new Set();
  for (const pair of pairs) {
    const key = `${pair.label}\u0000${pair.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push({ label: pair.label, value: pair.value });
  }
  if (unique.length > MAX_STRUCTURED_PROFILE_PAIRS) {
    throw new Error("Visible Tinder structured profile exceeds the existing product field capacity");
  }
  return unique;
}

function mergedHeaderValue(current, observed, field) {
  if (current && observed && current !== observed) {
    throw new Error(`Tinder profile ${field} changed during its local read`);
  }
  return current || observed || null;
}

/*
 * Merge only ordinary visible profile values across directly continuous
 * profile scroll viewports. `visible_profile_*` remains the existing ordered
 * fallback; structured pairs, section context and compact chips are additive
 * display metadata and are rebuilt with stable local ordinals for the
 * combined visible surface.
 */
export function mergeProfileSnapshots(current, observed) {
  if (!current) return observed;
  if (!observed || observed.display_name !== current.display_name) {
    throw new Error("Tinder profile changed during its local read");
  }
  const visible = uniqueProfileValues(
    [...profileVisibleValues(current), ...profileVisibleValues(observed)],
    MAX_VISIBLE_PROFILE_VALUES,
    "Visible Tinder profile exceeds the existing product field capacity"
  );
  const pairs = uniqueProfilePairs([
    ...profileStructuredPairs(current),
    ...profileStructuredPairs(observed)
  ]);
  const currentHeader = profileHeaderValues(current);
  const observedHeader = profileHeaderValues(observed);
  const header = {
    name: mergedHeaderValue(currentHeader.name, observedHeader.name, "header name"),
    age: mergedHeaderValue(currentHeader.age, observedHeader.age, "header age")
  };
  const sections = uniqueProfileValues(
    [...profileSectionValues(current), ...profileSectionValues(observed)],
    MAX_PROFILE_SECTIONS,
    "Visible Tinder profile section context exceeds the existing product field capacity"
  );
  const chips = uniqueProfileValues(
    [...profileChipValues(current), ...profileChipValues(observed)],
    MAX_PROFILE_CHIPS,
    "Visible Tinder profile chips exceed the existing product field capacity"
  );
  return Object.freeze({
    display_name: current.display_name,
    attributes: Object.freeze(profileAttributes(visible, pairs, { header, sections, chips })),
    media_refs: Object.freeze([])
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
  const bodyNodes = profileBodyTextNodes(nodes, container);
  const chipNodes = profileChipTextNodes(nodes, container);
  const chipExpansionBounds = profileChipExpansionBounds(nodes, container, chipNodes);
  // Keep the existing Block-2 product-profile field convention exactly:
  // every regular visible value, including compact clickable chips, remains
  // available in visual order under its `visible_profile_*` fallback key.
  // Structured pairs and the generic header/section/chip projection are
  // additive and never replace that compatible fallback.
  const attributes = profileAttributes(
    profileBodyTexts(profileProjectedTextNodes(bodyNodes, chipNodes)),
    structuredProfilePairs(bodyNodes, container),
    {
      header: profileHeaderProjection(nodes, media, expected, screen),
      sections: profileSectionContexts(bodyNodes),
      chips: profileBodyTexts(chipNodes).slice(0, MAX_PROFILE_CHIPS)
    }
  );

  return Object.freeze({
    profile: Object.freeze({
      display_name: expected,
      attributes: Object.freeze(attributes),
      media_refs: Object.freeze([])
    }),
    scroll_bounds: Object.freeze({ ...container.bounds }),
    // Bounds are an ephemeral, freshly observed Appium action/crop surface.
    // They are never put into the profile projection, persistence payload, or
    // a durable media identifier; callers may use them only with the same
    // immediately obtained screen observation.
    media_bounds: media?.bounds ? Object.freeze({ ...media.bounds }) : null,
    // The optional in-profile expansion target is likewise an ephemeral
    // same-screen control. It is never included in a profile payload.
    chip_expansion_bounds: chipExpansionBounds
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

/*
 * Inventory callers never need a tap surface. A live-profile runner does,
 * but it may act only on one unambiguous currently-visible tile action. The
 * bounds remain local to the current XML projection and are deliberately not
 * part of the tile product data or its RAM continuity key.
 */
function matchTileActionTarget(node) {
  const targets = new Map();
  const visit = (current) => {
    if (isClickable(current) && current.bounds && within(current.bounds, node.bounds)) {
      const bounds = current.bounds;
      const key = `${bounds.left},${bounds.top},${bounds.right},${bounds.bottom}`;
      if (!targets.has(key)) targets.set(key, bounds);
    }
    for (const child of current.children || []) visit(child);
  };
  visit(node);
  return targets.size === 1 ? Object.freeze({ ...targets.values().next().value }) : null;
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
    // This is intentionally optional: read-only Match inventory ignores it,
    // while an action runner refuses a tile with more than one click surface.
    tap_bounds: matchTileActionTarget(node),
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
