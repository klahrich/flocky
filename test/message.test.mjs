import test from "node:test";
import assert from "node:assert/strict";
import { COMPACT_RESULT_BODY_CHAR_LIMIT, INLINE_PAYLOAD_CHAR_LIMIT, INLINE_TASK_CHAR_LIMIT, ensureInlineTaskBody, ensurePayloadWithinCompactLimit, extractArtifactRefs } from "../.pi/extensions/flocky-agent-protocol/message.mjs";

test("compact message limits expose conservative inline budgets", () => {
  assert.equal(INLINE_TASK_CHAR_LIMIT, 2200);
  assert.equal(INLINE_PAYLOAD_CHAR_LIMIT, 3500);
  assert.equal(COMPACT_RESULT_BODY_CHAR_LIMIT, 1800);
});

test("inline task guard accepts concise tasks and rejects oversized ones with artifact guidance", () => {
  assert.equal(ensureInlineTaskBody("Review docs/prompts/dispatch.md and report back."), "Review docs/prompts/dispatch.md and report back.");
  assert.throws(
    () => ensureInlineTaskBody("x".repeat(INLINE_TASK_CHAR_LIMIT + 1)),
    /Move long detail into repo artifacts such as files, docs, or commit history/,
  );
});

test("payload guard rejects oversized compact payloads", () => {
  assert.equal(ensurePayloadWithinCompactLimit("ok", "telegram"), "ok");
  assert.throws(
    () => ensurePayloadWithinCompactLimit("x".repeat(INLINE_PAYLOAD_CHAR_LIMIT + 1), "telegram"),
    /telegram payload exceeded the compact inline limit/,
  );
});

test("artifact extraction finds file paths and commit hashes from compact text", () => {
  assert.deepEqual(
    extractArtifactRefs(["Updated docs/prompts/dispatch.md in commit d34db33 and test/result.test.mjs."]),
    ["docs/prompts/dispatch.md", "test/result.test.mjs", "commit d34db33"],
  );
});
