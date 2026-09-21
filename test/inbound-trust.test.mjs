import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyInboundEnvelope } from "../.pi/extensions/flocky-agent-protocol/inbound-trust.mjs";
import { FlockyStore } from "../.pi/extensions/flocky-agent-protocol/store.mjs";

const config = {
  agents: {
    owner: { routes: { herdr: { paneId: "w1:p1", expectedCwd: "C:/owner" } } },
    stream: { routes: { telegram: { target: "@stream_bot" } } },
  },
};

test("configured durable senders remain trusted", () => {
  const result = classifyInboundEnvelope({ parsed: { fields: { type: "task", from: "stream", task_id: "task-1" } }, config });
  assert.equal(result.trusted, true);
  assert.equal(result.kind, "durable");
});

test("transient result senders are trusted only while active for the matching task", () => {
  const dir = mkdtempSync(join(tmpdir(), "flocky-trust-"));
  try {
    const store = new FlockyStore(join(dir, "flocky.db"));
    store.registerTransientRun({
      runId: "run-1",
      taskId: "task-1",
      agentId: "transient-run-1",
      streamId: "landing",
      sourceRepoPath: "C:/repo",
      checkoutPath: "C:/repo/transient/run-1/repo",
      backend: "herdr",
      cleanupPolicy: "preserve",
      status: "dispatched",
    });
    const trusted = classifyInboundEnvelope({ parsed: { fields: { type: "result", from: "transient-run-1", task_id: "task-1" } }, config, store });
    assert.equal(trusted.trusted, true);
    assert.equal(trusted.kind, "transient");
    assert.equal(trusted.run.run_id, "run-1");

    const wrongTask = classifyInboundEnvelope({ parsed: { fields: { type: "result", from: "transient-run-1", task_id: "task-2" } }, config, store });
    assert.equal(wrongTask.trusted, false);

    store.markTransientRunSettled("run-1", "success");
    const afterSettlement = classifyInboundEnvelope({ parsed: { fields: { type: "result", from: "transient-run-1", task_id: "task-1" } }, config, store });
    assert.equal(afterSettlement.trusted, false);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("unknown non-durable transient task senders are rejected", () => {
  const result = classifyInboundEnvelope({ parsed: { fields: { type: "task", from: "transient-run-1", task_id: "task-1" } }, config });
  assert.equal(result.trusted, false);
});
