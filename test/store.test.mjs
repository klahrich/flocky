import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FlockyStore } from "../.pi/extensions/flocky-agent-protocol/store.mjs";

test("store deduplicates tasks and retains an outbox retry", () => {
  const dir = mkdtempSync(join(tmpdir(), "flocky-test-"));
  try {
    const store = new FlockyStore(join(dir, "flocky.db"));
    const task = { taskId: "abc", sender: "owner", replyTo: "stream", answerBack: true, body: "work", rawMessage: "raw" };
    assert.equal(store.receiveTask(task), true);
    assert.equal(store.receiveTask(task), false);
    store.startTask("abc");
    store.settleTask("abc", "done", "blocked", "missing credential");
    store.recordCompletion("abc", { status: "success", summary: "done" });
    assert.equal(store.completionForTask("abc").payload.status, "success");
    store.recordDispatch("dispatch-1", "stream", "herdr", "do work", "signed task");
    assert.equal(store.dispatchForTask("dispatch-1").recipient, "stream");
    store.enqueueResult("abc", "owner", "telegram", "message");
    const [outbox] = store.pendingOutbox();
    store.recordDeliveryAttempt(outbox.id, "herdr", "failed", "offline");
    store.markRetry(outbox.id, "offline");
    assert.equal(store.pendingOutbox()[0].last_error, "offline");
    assert.equal(store.deliveryAttempts(outbox.id)[0].transport, "herdr");
    store.markSent(outbox.id, "telegram");
    assert.equal(store.pendingOutbox().length, 0);
    assert.equal(store.statusSummary().taskCounts.find((row) => row.status === "settled").count, 1);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("store tracks transient run trust lifecycle", () => {
  const dir = mkdtempSync(join(tmpdir(), "flocky-transient-store-"));
  try {
    const store = new FlockyStore(join(dir, "flocky.db"));
    store.registerTransientRun({
      runId: "run-1",
      taskId: "task-1",
      agentId: "transient-run-1",
      streamId: "landing",
      sourceRepoPath: "C:/repo",
      checkoutPath: "C:/repo/.pi/flocky/transient/run-1/repo",
      backend: "herdr",
      cleanupPolicy: "cleanup-on-success",
    });
    assert.equal(store.transientRunForAgentTask("transient-run-1", "task-1").run_id, "run-1");
    store.markTransientRunReady("run-1", { workspaceId: "w1", paneId: "w1:p1" });
    store.markTransientRunDispatched("run-1", { workspaceId: "w1", paneId: "w1:p1" });
    let summary = store.statusSummary();
    assert.equal(summary.transientRunCounts.find((row) => row.status === "dispatched").count, 1);
    store.markTransientRunSettled("run-1", "success", "RESULT: SUCCESS\nSummary: ok");
    assert.equal(store.transientRunForAgentTask("transient-run-1", "task-1"), null);
    store.markTransientRunCleaned("run-1");
    const run = store.transientRun("run-1");
    assert.equal(run.result_status, "success");
    assert.equal(run.result_body, "RESULT: SUCCESS\nSummary: ok");
    assert.equal(run.cleanup_state, "cleaned");
    store.registerTransientRun({
      runId: "run-2",
      taskId: "task-2",
      agentId: "transient-run-2",
      streamId: "landing",
      sourceRepoPath: "C:/repo",
      checkoutPath: "C:/repo/.pi/flocky/transient/run-2/repo",
      backend: "herdr",
      cleanupPolicy: "preserve",
    });
    store.markTransientRunFailed("run-2", "launch failed");
    assert.equal(store.transientRunForAgentTask("transient-run-2", "task-2"), null);
    summary = store.statusSummary();
    assert.equal(summary.recentTransientRuns.length >= 2, true);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("store can retrieve workflow-linked transient runs in order", () => {
  const dir = mkdtempSync(join(tmpdir(), "flocky-workflow-store-"));
  try {
    const store = new FlockyStore(join(dir, "flocky.db"));
    store.registerTransientRun({
      runId: "run-1",
      taskId: "task-1",
      workflowId: "wf-1",
      workflowKind: "implement-review",
      workflowRole: "implementer",
      agentId: "transient-run-1",
      streamId: "landing",
      sourceRepoPath: "C:/repo",
      checkoutPath: "C:/repo/.pi/flocky/transient/run-1/repo",
      backend: "herdr",
      cleanupPolicy: "preserve",
    });
    store.registerTransientRun({
      runId: "run-2",
      taskId: "task-2",
      parentTaskId: "task-1",
      workflowId: "wf-1",
      workflowKind: "implement-review",
      workflowRole: "reviewer",
      agentId: "transient-run-2",
      streamId: "landing",
      sourceRepoPath: "C:/repo",
      checkoutPath: "C:/repo/.pi/flocky/transient/run-1/repo",
      backend: "herdr",
      cleanupPolicy: "preserve",
    });
    store.markTransientRunSettled("run-1", "success", "implementer report");
    store.markTransientRunSettled("run-2", "blocked", "reviewer report");
    const workflowRuns = store.transientRunsForWorkflow("wf-1");
    assert.deepEqual(workflowRuns.map((run) => run.workflow_role), ["implementer", "reviewer"]);
    assert.deepEqual(workflowRuns.map((run) => run.result_body), ["implementer report", "reviewer report"]);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
