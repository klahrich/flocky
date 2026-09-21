import test from "node:test";
import assert from "node:assert/strict";
import { valueArg } from "../tools/cli-args.mjs";

test("valueArg returns undefined when the flag is absent instead of the first argument", () => {
  const args = ["--cwd", "C:/repo", "--job", "hourly-job"];
  assert.equal(valueArg(args, "--occurrence"), undefined);
});

test("valueArg returns the value that follows a present flag", () => {
  const args = ["--cwd", "C:/repo", "--job", "hourly-job", "--occurrence", "job:2026-09-21T09:00[America/Toronto]"];
  assert.equal(valueArg(args, "--job"), "hourly-job");
  assert.equal(valueArg(args, "--occurrence"), "job:2026-09-21T09:00[America/Toronto]");
});
