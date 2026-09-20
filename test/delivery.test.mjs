import test from "node:test";
import assert from "node:assert/strict";
import { deliverWithFallback } from "../.pi/extensions/flocky-agent-protocol/delivery.mjs";

const config = {
  transport: { fallbackOrder: ["herdr", "telegram"] },
  agents: {
    stream: {
      routes: {
        herdr: { paneId: "w1:p1", expectedCwd: "C:/stream" },
        telegram: { target: "@stream_bot" },
      },
    },
  },
};

test("a stale Herdr route falls back to configured Telegram", async () => {
  const attempted = [];
  const result = await deliverWithFallback({
    item: { recipient: "stream", transport: "herdr" },
    config,
    async send({ transport }) {
      if (transport === "herdr") throw new Error("pane is stale");
    },
    onAttempt: (attempt) => attempted.push(attempt),
  });
  assert.equal(result.delivered, true);
  assert.equal(result.transport, "telegram");
  assert.deepEqual(attempted.map((attempt) => attempt.status), ["failed", "sent"]);
  assert.deepEqual(attempted.map((attempt) => attempt.transport), ["herdr", "telegram"]);
});

test("failed primary stays retryable when no fallback route is configured", async () => {
  const noFallback = { ...config, transport: { fallbackOrder: ["herdr"] }, agents: { stream: { routes: { herdr: config.agents.stream.routes.herdr } } } };
  const result = await deliverWithFallback({
    item: { recipient: "stream", transport: "herdr" },
    config: noFallback,
    async send() { throw new Error("pane is stale"); },
  });
  assert.equal(result.delivered, false);
  assert.match(result.error, /pane is stale/);
});
