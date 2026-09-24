/*
 * Local-only helpers for the Appium/UiAutomator2 control loop.  They never
 * persist or transmit a node tree, element id, coordinate, or screenshot.
 * The caller can reduce a fresh source snapshot to ordinary profile/message
 * product data before passing it to the mirror adapter.
 */

function decodeXml(value) {
  return String(value || "")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function attributesFromTag(tag) {
  const attributes = {};
  for (const match of tag.matchAll(/([\w:-]+)="([^"]*)"/g)) {
    attributes[match[1]] = decodeXml(match[2]);
  }
  return attributes;
}

export function parseBounds(value) {
  const match = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/.exec(String(value || ""));
  if (!match) return null;
  const [left, top, right, bottom] = match.slice(1).map(Number);
  if (!(right > left && bottom > top)) return null;
  return Object.freeze({ left, top, right, bottom, width: right - left, height: bottom - top });
}

/* UiAutomator2 can emit either <node> or class-named XML elements. */
export function parseUiAutomatorXml(xml) {
  const root = { attributes: {}, bounds: null, children: [], parent: null };
  const stack = [root];
  for (const match of String(xml || "").matchAll(/<\/?[\w.:-]+\b[^>]*>/g)) {
    const token = match[0];
    if (token.startsWith("</")) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const tagName = /^<([\w.:-]+)/.exec(token)?.[1] || "";
    if (tagName === "hierarchy") continue;
    const attributes = attributesFromTag(token);
    if (!attributes.class) attributes.class = tagName;
    const node = {
      attributes,
      bounds: parseBounds(attributes.bounds),
      children: [],
      parent: stack.at(-1)
    };
    stack.at(-1).children.push(node);
    if (!token.endsWith("/>")) stack.push(node);
  }
  return root;
}

export function flattenUiNodes(root) {
  const nodes = [];
  const visit = (node) => {
    for (const child of node.children || []) {
      nodes.push(child);
      visit(child);
    }
  };
  visit(root);
  return nodes;
}

export function screenBounds(root) {
  const all = flattenUiNodes(root).map((node) => node.bounds).filter(Boolean);
  if (!all.length) return null;
  return Object.freeze({
    left: Math.min(...all.map((bounds) => bounds.left)),
    top: Math.min(...all.map((bounds) => bounds.top)),
    right: Math.max(...all.map((bounds) => bounds.right)),
    bottom: Math.max(...all.map((bounds) => bounds.bottom)),
    width: Math.max(...all.map((bounds) => bounds.right)) - Math.min(...all.map((bounds) => bounds.left)),
    height: Math.max(...all.map((bounds) => bounds.bottom)) - Math.min(...all.map((bounds) => bounds.top))
  });
}

function hasText(node) {
  return Boolean(String(node?.attributes?.text || "").trim());
}

function isBubbleSized(bounds, screen) {
  if (!bounds || !screen) return false;
  return bounds.width < screen.width * 0.92
    && bounds.height < screen.height * 0.5
    && bounds.height >= 20;
}

function sameBounds(left, right) {
  return Boolean(left && right
    && left.left === right.left && left.top === right.top
    && left.right === right.right && left.bottom === right.bottom);
}

/*
 * Find the nearest compact ancestor for a visible text leaf.  The resulting
 * geometry is local-only.  It is deliberately a refusal when there is no
 * distinct message container; callers must not infer direction from text.
 */
export function nearestBubbleContainer(textNode, screen) {
  if (!textNode?.bounds || !screen || !hasText(textNode)) return null;
  let sameBoundsContainer = null;
  let current = textNode;
  while (current?.parent) {
    current = current.parent;
    if (!current.bounds) continue;
    if (sameBounds(current.bounds, textNode.bounds)) {
      const className = String(current.attributes?.class || "");
      if (!sameBoundsContainer && /(?:FrameLayout|LinearLayout|RelativeLayout)$/.test(className)
        && isBubbleSized(current.bounds, screen)) {
        sameBoundsContainer = current;
      }
      continue;
    }
    if (isBubbleSized(current.bounds, screen)) return current;
  }
  return sameBoundsContainer;
}

/*
 * Current ZTE Tinder evidence: outbound bubble containers terminate at the
 * usable right edge; inbound containers start on Tinder's left message lane.
 * Centered/system rows and ambiguous geometry produce null, never a guessed
 * direction.  Callers must already have excluded header, composer and system
 * rows before invoking this function.
 */
export function classifyBubbleDirection(bounds, screen) {
  if (!bounds || !screen || screen.width < 1) return null;
  const leftMargin = bounds.left - screen.left;
  const rightMargin = screen.right - bounds.right;
  const edgeTolerance = Math.max(16, Math.round(screen.width * 0.04));
  const leftLaneMinimum = Math.max(48, Math.round(screen.width * 0.1));

  if (leftMargin > edgeTolerance && rightMargin >= 0 && rightMargin <= edgeTolerance) {
    return "OUTBOUND";
  }
  if (leftMargin >= leftLaneMinimum && rightMargin >= leftLaneMinimum && leftMargin <= rightMargin) {
    return "INBOUND";
  }
  return null;
}

export function classifyMessageTextNode(textNode, screen) {
  const container = nearestBubbleContainer(textNode, screen);
  if (!container) return null;
  return classifyBubbleDirection(container.bounds, screen);
}

/* Safe, bounded debugging shape: never include text, content descriptions or IDs. */
export function summarizeTextGeometry(root) {
  const screen = screenBounds(root);
  return flattenUiNodes(root)
    .filter(hasText)
    .map((node) => {
      const container = nearestBubbleContainer(node, screen);
      return Object.freeze({
        text_bounds: node.bounds,
        container_bounds: container?.bounds || null,
        direction: container ? classifyBubbleDirection(container.bounds, screen) : null,
        class_name: String(node.attributes.class || "").split(".").at(-1) || "",
        has_resource_id: Boolean(node.attributes["resource-id"])
      });
    });
}
