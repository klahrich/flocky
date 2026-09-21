import test from "node:test";
import assert from "node:assert/strict";
import { resolveDelegationPlan } from "../.pi/extensions/flocky-agent-protocol/mixed-mode.mjs";

test("auto mode defaults to durable single-worker dispatch", () => {
  assert.deepEqual(resolveDelegationPlan({}), {
    mode: "durable",
    workflow: "single",
    tool: "flocky_dispatch",
    requiresApproval: false,
  });
});

test("auto mode routes implement-review to transient approval flow", () => {
  assert.deepEqual(resolveDelegationPlan({ workflow: "implement-review" }), {
    mode: "transient",
    workflow: "implement-review",
    tool: "flocky_transient_implement_review",
    requiresApproval: true,
  });
});

test("explicit transient single-worker requests stay transient", () => {
  assert.deepEqual(resolveDelegationPlan({ mode: "transient" }), {
    mode: "transient",
    workflow: "single",
    tool: "flocky_transient_dispatch",
    requiresApproval: false,
  });
});

test("durable mode rejects transient-only workflows", () => {
  assert.throws(() => resolveDelegationPlan({ mode: "durable", workflow: "implement-review" }), /Durable mode supports only the single workflow/);
});
