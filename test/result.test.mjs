import test from "node:test";
import assert from "node:assert/strict";
import { NO_TEXT_FINAL_RESPONSE, buildResultBody, hasMeaningfulAssistantAnswer } from "../.pi/extensions/flocky-agent-protocol/result.mjs";
import { COMPACT_RESULT_BODY_CHAR_LIMIT } from "../.pi/extensions/flocky-agent-protocol/message.mjs";

const completion = {
  status: "success",
  summary: "Did the work and kept the answer-back compact.",
  completed: ["Updated docs/prompts/dispatch.md", "Shipped commit d34db33", "Added test/result.test.mjs coverage"],
  notCompleted: [],
  validation: ["npm test passed", "Verified origin/master contains d34db33"],
  reason: "none",
  safeState: "Repo is consistent and the detailed rationale lives in docs/prompts/dispatch.md.",
  nextAction: "Reuse docs/prompts/dispatch.md when dispatching a follow-up task.",
  artifacts: ["docs/prompts/dispatch.md", "commit d34db33"],
};

test("structured result stays compact and omits placeholder raw assistant message", () => {
  const body = buildResultBody({
    agentId: "stream",
    taskId: "task-123",
    answer: NO_TEXT_FINAL_RESPONSE,
    completion,
    outcome: { status: "success", declared: true, reason: "none" },
  });
  assert.doesNotMatch(body, /Raw assistant message:/);
  assert.match(body, /Result: SUCCESS/);
  assert.match(body, /Artifacts:\n- docs\/prompts\/dispatch\.md\n- commit d34db33/);
  assert.ok(body.length <= COMPACT_RESULT_BODY_CHAR_LIMIT, `result body length ${body.length}`);
});

test("structured result stays compact even when the assistant wrote extra prose", () => {
  const body = buildResultBody({
    agentId: "stream",
    taskId: "task-123",
    answer: "Implemented and verified with a much longer freeform note that should stay out of compact transport answer-backs.",
    completion,
    outcome: { status: "success", declared: true, reason: "none" },
  });
  assert.doesNotMatch(body, /Raw assistant message:/);
  assert.match(body, /Next action: Reuse docs\/prompts\/dispatch\.md/);
});

test("placeholder detector only treats real assistant text as meaningful", () => {
  assert.equal(hasMeaningfulAssistantAnswer(NO_TEXT_FINAL_RESPONSE), false);
  assert.equal(hasMeaningfulAssistantAnswer("   "), false);
  assert.equal(hasMeaningfulAssistantAnswer("A real final note"), true);
});
