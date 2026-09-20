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
    store.recordDispatch("dispatch-1", "stream", "herdr", "do work", "signed task");
    assert.equal(store.dispatchForTask("dispatch-1").recipient, "stream");
    store.enqueueResult("abc", "owner", "telegram", "message");
    const [outbox] = store.pendingOutbox();
    store.markRetry(outbox.id, "offline");
    assert.equal(store.pendingOutbox()[0].last_error, "offline");
    store.markSent(outbox.id);
    assert.equal(store.pendingOutbox().length, 0);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
