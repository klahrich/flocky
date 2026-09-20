import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildEnvelope, parseEnvelope, verifyEnvelope } from "../.pi/extensions/flocky-agent-protocol/protocol.mjs";
import { FlockyStore } from "../.pi/extensions/flocky-agent-protocol/store.mjs";
import { parseOutcome } from "../.pi/extensions/flocky-agent-protocol/outcome.mjs";
import { deliverWithFallback } from "../.pi/extensions/flocky-agent-protocol/delivery.mjs";

const secret = "integration-test-secret";
const config = {
  transport: { fallbackOrder: ["herdr", "telegram"] },
  agents: {
    owner: { routes: { herdr: { paneId: "w1:p1", expectedCwd: "C:/owner" }, telegram: { target: "@owner_bot" } } },
    stream: { routes: { herdr: { paneId: "w2:p1", expectedCwd: "C:/stream" }, telegram: { target: "@stream_bot" } } },
  },
};

async function flush(store, item, send) {
  const delivery = await deliverWithFallback({
    item,
    config,
    send,
    onAttempt: (attempt) => store.recordDeliveryAttempt(item.id, attempt.transport, attempt.status, attempt.error),
  });
  if (delivery.delivered) store.markSent(item.id, delivery.transport);
  else store.markRetry(item.id, delivery.error);
  return delivery;
}

test("owner-to-stream-to-owner lifecycle preserves correlation, retries, and semantic outcome", async () => {
  const directory = mkdtempSync(join(tmpdir(), "flocky-lifecycle-"));
  const owner = new FlockyStore(join(directory, "owner.db"));
  const stream = new FlockyStore(join(directory, "stream.db"));
  try {
    const taskId = "task-001";
    const taskBody = "Inspect the repository only; do not edit files.";
    const taskPayload = buildEnvelope({ type: "task", task_id: taskId, from: "owner", reply_to: "stream", answer_back: "yes" }, taskBody, secret);
    owner.recordDispatch(taskId, "stream", "herdr", taskBody, taskPayload);
    owner.enqueueResult(taskId, "stream", "herdr", taskPayload);

    let inboundTask = "";
    const taskDelivery = await flush(owner, owner.pendingOutbox()[0], async ({ transport }) => {
      if (transport === "herdr") throw new Error("stale stream pane");
      inboundTask = taskPayload;
    });
    assert.equal(taskDelivery.transport, "telegram");
    assert.deepEqual(owner.deliveryAttempts(owner.outboxForTask(taskId).id).map((attempt) => attempt.transport), ["herdr", "telegram"]);

    const parsedTask = parseEnvelope(inboundTask);
    assert.equal(verifyEnvelope(parsedTask, secret), true);
    assert.equal(stream.receiveTask({ taskId, sender: "owner", replyTo: "stream", answerBack: true, body: parsedTask.body, rawMessage: inboundTask }), true);
    assert.equal(stream.receiveTask({ taskId, sender: "owner", replyTo: "stream", answerBack: true, body: parsedTask.body, rawMessage: inboundTask }), false);
    stream.startTask(taskId);

    const answer = "RESULT: SUCCESS\nSummary: Repository inspected.\nCompleted: Read Git status.\nNot completed: none\nValidation: Git status was clean.\nBlocker: none\nSafe state: No files changed.\nNext action: none";
    const outcome = parseOutcome(answer);
    stream.settleTask(taskId, answer, outcome.status, outcome.reason);
    const resultPayload = buildEnvelope({ type: "result", task_id: taskId, from: "stream", status: outcome.status }, answer, secret);
    stream.enqueueResult(taskId, "owner", "herdr", resultPayload);

    let inboundResult = "";
    const resultDelivery = await flush(stream, stream.pendingOutbox()[0], async ({ transport }) => {
      if (transport === "herdr") throw new Error("stale owner pane");
      inboundResult = resultPayload;
    });
    assert.equal(resultDelivery.transport, "telegram");
    const parsedResult = parseEnvelope(inboundResult);
    assert.equal(verifyEnvelope(parsedResult, secret), true);
    assert.equal(parsedResult.fields.task_id, taskId);
    assert.equal(parsedResult.fields.status, "success");

    const secondTask = buildEnvelope({ type: "task", task_id: "task-002", from: "owner", reply_to: "stream", answer_back: "yes" }, "Report branch only.", secret);
    const parsedSecond = parseEnvelope(secondTask);
    assert.equal(stream.receiveTask({ taskId: "task-002", sender: "owner", replyTo: "stream", answerBack: true, body: parsedSecond.body, rawMessage: secondTask }), true);
    stream.startTask("task-002");
    stream.settleTask("task-002", "RESULT: PARTIAL\nSummary: queued test\nReason: test complete", "partial", "test complete");
    assert.equal(stream.completedTaskCount(), 2);
  } finally {
    owner.close();
    stream.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("invalid signature and absent routes never produce delivery", async () => {
  const payload = buildEnvelope({ type: "task", task_id: "task-bad", from: "owner", reply_to: "stream", answer_back: "yes" }, "safe work", secret);
  assert.equal(verifyEnvelope(parseEnvelope(payload.replace("safe", "unsafe")), secret), false);
  const result = await deliverWithFallback({ item: { recipient: "unknown", transport: "herdr" }, config, async send() { throw new Error("should not send"); } });
  assert.equal(result.delivered, false);
  assert.match(result.error, /No configured route/);
});
