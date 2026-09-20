import { createHmac, timingSafeEqual } from "node:crypto";

const ENVELOPE = /^\{\{flocky:v(?<version>\d+)\s+(?<fields>[^}]*)\}\}(?:\r?\n)?(?<body>[\s\S]*)$/;
const REQUIRED = {
  task: ["task_id", "from", "reply_to", "answer_back", "sig"],
  result: ["task_id", "from", "status", "sig"],
  compact: ["from", "sig"],
};

export function parseEnvelope(text) {
  if (typeof text !== "string") return null;
  const match = text.match(ENVELOPE);
  if (!match?.groups) return null;
  const fields = { v: match.groups.version };
  for (const token of match.groups.fields.trim().split(/\s+/)) {
    const separator = token.indexOf("=");
    if (separator <= 0) return null;
    const key = token.slice(0, separator);
    const value = token.slice(separator + 1);
    if (!/^[a-z_]+$/.test(key) || !value || fields[key] !== undefined) return null;
    fields[key] = value;
  }
  if (!REQUIRED[fields.type]?.every((key) => typeof fields[key] === "string")) return null;
  return { fields, body: match.groups.body ?? "" };
}

export function canonicalPayload(fields, body) {
  return Object.entries(fields)
    .filter(([key]) => key !== "sig")
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n") + `\n\n${body}`;
}

export function signEnvelope(fields, body, secret) {
  if (!secret) throw new Error("Protocol secret is required");
  return createHmac("sha256", secret).update(canonicalPayload(fields, body), "utf8").digest("hex");
}

export function verifyEnvelope(parsed, secret) {
  if (!parsed || !secret || !/^[a-f0-9]{64}$/i.test(parsed.fields.sig ?? "")) return false;
  const expected = Buffer.from(signEnvelope(parsed.fields, parsed.body, secret), "hex");
  const actual = Buffer.from(parsed.fields.sig, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function buildEnvelope(fields, body, secret) {
  const unsigned = { v: "1", ...fields };
  const sig = signEnvelope(unsigned, body, secret);
  const header = Object.entries({ ...unsigned, sig })
    .filter(([key]) => key !== "v")
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
  return `{{flocky:v${unsigned.v} ${header}}}\n${body}`;
}
