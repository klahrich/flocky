import test from "node:test";
import assert from "node:assert/strict";
import { buildEnvelope, parseEnvelope, verifyEnvelope } from "../.pi/extensions/flocky-agent-protocol/protocol.mjs";

test("a built task envelope parses and verifies", () => {
  const secret = "test-secret";
  const text = buildEnvelope({ type: "task", task_id: "task-1", from: "owner", to: "stream", reply_to: "owner", answer_back: "yes" }, "Implement it.", secret);
  const parsed = parseEnvelope(text);
  assert.equal(parsed.fields.task_id, "task-1");
  assert.equal(parsed.body, "Implement it.");
  assert.equal(verifyEnvelope(parsed, secret), true);
});

test("transport newline normalization preserves envelope verification", () => {
  const text = buildEnvelope({ type: "task", task_id: "task-newline", from: "owner", to: "stream", reply_to: "owner", answer_back: "yes" }, "Line one\nLine two", "secret");
  const transportNormalized = text.replace(/\n/g, "\r\n") + "\r\n";
  assert.equal(verifyEnvelope(parseEnvelope(transportNormalized), "secret"), true);
});

test("tampering with a signed body fails verification", () => {
  const text = buildEnvelope({ type: "task", task_id: "task-1", from: "owner", to: "stream", reply_to: "owner", answer_back: "yes" }, "Implement it.", "secret");
  assert.equal(verifyEnvelope(parseEnvelope(text.replace("Implement", "Delete")), "secret"), false);
});

test("unknown envelope types and malformed values do not parse", () => {
  assert.equal(parseEnvelope("{{flocky:v1 type=unknown from=a sig=x}}\nHi"), null);
  assert.equal(parseEnvelope("{{flocky:v1 type=task task_id=x from=a reply_to=b answer_back=yes}}\nHi"), null);
});
