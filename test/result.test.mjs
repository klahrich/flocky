import test from "node:test";
import assert from "node:assert/strict";
import { NO_TEXT_FINAL_RESPONSE, buildResultBody, hasMeaningfulAssistantAnswer } from "../.pi/extensions/flocky-agent-protocol/result.mjs";

const completion = { status: "success", summary: "done", completed: ["work"], notCompleted: [], validation: ["test"], reason: "", safeState: "clean", nextAction: "none" };

test("structured result omits synthetic raw assistant answer", () => {
  const body = buildResultBody({ agentId: "stream", taskId: "task", answer: NO_TEXT_FINAL_RESPONSE, completion, outcome: { declared: true } });
  assert.match(body, /RESULT: SUCCESS/);
  assert.doesNotMatch(body, /Raw assistant message/);
});

test("structured result retains meaningful raw assistant answer", () => {
  const body = buildResultBody({ agentId: "stream", taskId: "task", answer: "Human detail", completion, outcome: { declared: true } });
  assert.match(body, /Raw assistant message:\nHuman detail/);
  assert.equal(hasMeaningfulAssistantAnswer("  Human detail "), true);
});
