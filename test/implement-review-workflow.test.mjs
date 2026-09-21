import test from "node:test";
import assert from "node:assert/strict";
import { buildImplementReviewApprovalPrompt, buildReviewerTask, finalImplementReviewStatus, renderImplementReviewSummary, shouldRunImplementReview } from "../.pi/extensions/flocky-agent-protocol/implement-review.mjs";

test("implement-review approval prompt is short and offers durable fallback", () => {
  const text = buildImplementReviewApprovalPrompt({ streamId: "landing" });
  assert.equal(text, "Use transient implement+review agents for this coding task on landing? Or switch to the durable landing agent.");
});

test("implement-review runs reviewer for success and partial implementer outcomes only", () => {
  assert.equal(shouldRunImplementReview("success"), true);
  assert.equal(shouldRunImplementReview("partial"), true);
  assert.equal(shouldRunImplementReview("blocked"), false);
  assert.equal(shouldRunImplementReview("failed"), false);
  assert.equal(shouldRunImplementReview("refused"), false);
});

test("reviewer task includes original task and implementer report", () => {
  const task = buildReviewerTask({
    originalTask: "Build the landing page.",
    implementerTaskId: "task-1",
    implementerStatus: "success",
    implementerReport: "RESULT: SUCCESS\nSummary: Built the page.",
  });
  assert.match(task, /Original task:/);
  assert.match(task, /Build the landing page/);
  assert.match(task, /Implementer task ID: task-1/);
  assert.match(task, /RESULT: SUCCESS/);
});

test("workflow final status respects reviewer outcome and launch failures", () => {
  assert.equal(finalImplementReviewStatus({ implementerStatus: "success", reviewerStatus: "success" }), "success");
  assert.equal(finalImplementReviewStatus({ implementerStatus: "partial", reviewerStatus: "success" }), "partial");
  assert.equal(finalImplementReviewStatus({ implementerStatus: "success", reviewerStatus: "blocked" }), "blocked");
  assert.equal(finalImplementReviewStatus({ implementerStatus: "blocked" }), "blocked");
  assert.equal(finalImplementReviewStatus({ implementerStatus: "success", reviewerLaunchError: "spawn failed" }), "partial");
});

test("combined summary includes both runs and final status", () => {
  const text = renderImplementReviewSummary({
    workflowId: "wf-1",
    streamId: "landing",
    implementer: { run_id: "run-1", task_id: "task-1", result_status: "success", result_body: "RESULT: SUCCESS\nSummary: done" },
    reviewer: { run_id: "run-2", task_id: "task-2", result_status: "failed", result_body: "RESULT: FAILED\nReason: tests failed" },
  });
  assert.match(text, /Workflow status: FAILED/);
  assert.match(text, /Implementer stage:/);
  assert.match(text, /Reviewer stage:/);
  assert.match(text, /task-1/);
  assert.match(text, /task-2/);
  assert.match(text, /tests failed/);
});
