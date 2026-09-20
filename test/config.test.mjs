import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProjectEnv } from "../.pi/extensions/flocky-agent-protocol/config.mjs";

test("project .env loads absent variables without overwriting process values", () => {
  const directory = mkdtempSync(join(tmpdir(), "flocky-env-"));
  const before = process.env.FLOCKY_CONFIG_TEST;
  const beforeExisting = process.env.FLOCKY_CONFIG_EXISTING;
  try {
    writeFileSync(join(directory, ".env"), "FLOCKY_CONFIG_TEST='loaded value'\nFLOCKY_CONFIG_EXISTING=from-file\n", "utf8");
    process.env.FLOCKY_CONFIG_EXISTING = "from-process";
    delete process.env.FLOCKY_CONFIG_TEST;
    loadProjectEnv(directory);
    assert.equal(process.env.FLOCKY_CONFIG_TEST, "loaded value");
    assert.equal(process.env.FLOCKY_CONFIG_EXISTING, "from-process");
  } finally {
    if (before === undefined) delete process.env.FLOCKY_CONFIG_TEST; else process.env.FLOCKY_CONFIG_TEST = before;
    if (beforeExisting === undefined) delete process.env.FLOCKY_CONFIG_EXISTING; else process.env.FLOCKY_CONFIG_EXISTING = beforeExisting;
    rmSync(directory, { recursive: true, force: true });
  }
});
