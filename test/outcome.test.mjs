import test from "node:test";
import assert from "node:assert/strict";
import { parseOutcome } from "../.pi/extensions/flocky-agent-protocol/outcome.mjs";

for (const status of ["SUCCESS", "PARTIAL", "BLOCKED", "FAILED", "REFUSED"]) {
  test(`parses declared ${status.toLowerCase()} outcome`, () => {
    const outcome = parseOutcome(`RESULT: ${status}\nSummary: work summary\nBlocker: none\nNext action: none`);
    assert.equal(outcome.status, status.toLowerCase());
    assert.equal(outcome.declared, true);
  });
}

test("missing result contract is conservatively partial", () => {
  const outcome = parseOutcome("Implemented the feature, probably.");
  assert.equal(outcome.status, "partial");
  assert.equal(outcome.declared, false);
  assert.match(outcome.reason, /without a valid RESULT marker/);
});
