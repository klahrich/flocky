import test from "node:test";
import assert from "node:assert/strict";
import { areValidLocalTimes, normalizeLocalTimes } from "../.pi/extensions/flocky-agent-protocol/schedule.mjs";

test("schedule local time validation accepts HH:mm values and trims whitespace", () => {
  const localTimes = normalizeLocalTimes([" 06:00 ", "16:00", "09:30"]);
  assert.deepEqual(localTimes, ["06:00", "16:00", "09:30"]);
  assert.equal(areValidLocalTimes(localTimes), true);
});

test("schedule local time validation rejects invalid values", () => {
  assert.equal(areValidLocalTimes([]), false);
  assert.equal(areValidLocalTimes(["6:00"]), false);
  assert.equal(areValidLocalTimes(["24:00"]), false);
  assert.equal(areValidLocalTimes(["07:60"]), false);
  assert.equal(areValidLocalTimes(["nope"]), false);
});
