export const INLINE_TASK_CHAR_LIMIT = 2200;
export const INLINE_PAYLOAD_CHAR_LIMIT = 3500;
export const COMPACT_RESULT_BODY_CHAR_LIMIT = 1800;

export function clipText(value, max, suffix = "…") {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  if (text.length <= max) return text;
  const head = Math.max(0, max - suffix.length);
  return `${text.slice(0, head).trimEnd()}${suffix}`;
}

export function clipList(items = [], { maxItems = 3, maxItemChars = 140 } = {}) {
  return items
    .map((item) => clipText(item, maxItemChars))
    .filter(Boolean)
    .slice(0, maxItems);
}

export function unique(items = []) {
  return [...new Set(items.filter(Boolean))];
}

export function extractArtifactRefs(values = []) {
  const refs = [];
  const filePattern = /(?:\.?[A-Za-z0-9_-]+[\\/])+[A-Za-z0-9_.-]+/g;
  const commitPattern = /\b[0-9a-f]{7,40}\b/g;
  for (const value of values) {
    const text = String(value ?? "");
    for (const match of text.matchAll(filePattern)) refs.push(match[0].replace(/\\/g, "/").replace(/[.,;:!?]+$/, ""));
    for (const match of text.matchAll(commitPattern)) refs.push(`commit ${match[0]}`);
  }
  return unique(refs);
}

export function ensureInlineTaskBody(body) {
  const text = String(body ?? "").trim();
  if (!text) throw new Error("Task instructions cannot be empty");
  if (text.length > INLINE_TASK_CHAR_LIMIT) {
    throw new Error(`Flocky inline tasks must stay compact (<= ${INLINE_TASK_CHAR_LIMIT} chars). Move long detail into repo artifacts such as files, docs, or commit history, then dispatch a shorter task that references them.`);
  }
  return text;
}

export function ensurePayloadWithinCompactLimit(payload, transport = "transport") {
  const text = String(payload ?? "");
  if (text.length > INLINE_PAYLOAD_CHAR_LIMIT) {
    throw new Error(`Flocky ${transport} payload exceeded the compact inline limit (${text.length} > ${INLINE_PAYLOAD_CHAR_LIMIT}). Shorten the inline message and move detail into repo artifacts such as files, docs, or commit history.`);
  }
  return text;
}
