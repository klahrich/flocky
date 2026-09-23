import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyAttachment, applyAttachments, planAttachment, planAttachments } from "../.pi/extensions/flocky-agent-protocol/attachment.mjs";

function fixture() {
  const owner = mkdtempSync(join(tmpdir(), "flocky-attach-"));
  const stream = join(owner, "stream");
  mkdirSync(join(owner, ".pi", "extensions", "flocky-agent-protocol"), { recursive: true });
  writeFileSync(join(owner, ".pi", "extensions", "flocky-agent-protocol", "index.ts"), "export default function() {}\n");
  writeFileSync(join(owner, ".env"), "FLOCKY_PROTOCOL_SECRET=test-secret\n", "utf8");
  mkdirSync(join(owner, "templates"), { recursive: true });
  writeFileSync(join(owner, "templates", "stream-AGENTS.md"), "# Stream instructions\nDo Flocky work.\n");
  mkdirSync(join(stream, ".git"), { recursive: true });
  writeFileSync(join(stream, "AGENTS.md"), "# Existing project instructions\nKeep these.\n");
  const config = {
    project: { id: "owner" },
    agents: {
      owner: { routes: { herdr: { paneId: "w1:p1", expectedCwd: owner } } },
      stream: { path: "./stream", description: "Fixture stream", routes: {} },
    },
    protocol: { secretEnv: "FLOCKY_PROTOCOL_SECRET" },
    transport: { default: "herdr", fallbackOrder: ["herdr"] },
  };
  return { owner, stream, config };
}

test("attaching an existing stream installs Flocky files and preserves existing AGENTS content", () => {
  const { owner, stream, config } = fixture();
  try {
    const plan = planAttachment({ ownerCwd: owner, config, streamId: "stream" });
    assert.equal(plan.actions.some((action) => action.path === ".pi/extensions/flocky-agent-protocol"), true);
    applyAttachment({ ownerCwd: owner, config, streamId: "stream" });
    assert.equal(existsSync(join(stream, ".pi", "extensions", "flocky-agent-protocol", "index.ts")), true);
    assert.equal(JSON.parse(readFileSync(join(stream, "flocky.config.json"), "utf8")).runtime.agentId, "stream");
    const environment = readFileSync(join(stream, ".env"), "utf8");
    assert.match(environment, /FLOCKY_PROTOCOL_SECRET=test-secret/);
    assert.doesNotMatch(environment, /TELEGRAM_API_ID/);
    const agents = readFileSync(join(stream, "AGENTS.md"), "utf8");
    assert.match(agents, /Existing project instructions/);
    assert.match(agents, /flocky:stream-instructions:start/);
    applyAttachment({ ownerCwd: owner, config, streamId: "stream" });
    assert.equal((readFileSync(join(stream, "AGENTS.md"), "utf8").match(/flocky:stream-instructions:start/g) ?? []).length, 1);
  } finally { rmSync(owner, { recursive: true, force: true }); }
});

test("Telegram attachment requires Telegram credentials", () => {
  const { owner, config } = fixture();
  try {
    config.transport = { default: "telegram", fallbackOrder: ["telegram"] };
    mkdirSync(join(owner, ".agents", "skills", "telegram"), { recursive: true });
    assert.throws(() => planAttachment({ ownerCwd: owner, config, streamId: "stream" }), /TELEGRAM_API_ID, TELEGRAM_API_HASH/);
  } finally { rmSync(owner, { recursive: true, force: true }); }
});

test("attachment rejects conflicting stream environment values", () => {
  const { owner, stream, config } = fixture();
  try {
    writeFileSync(join(stream, ".env"), "FLOCKY_PROTOCOL_SECRET=different\n", "utf8");
    assert.throws(() => planAttachment({ ownerCwd: owner, config, streamId: "stream" }), /different FLOCKY_PROTOCOL_SECRET/);
  } finally { rmSync(owner, { recursive: true, force: true }); }
});

test("bulk attachment previews and applies all configured streams", () => {
  const { owner, stream, config } = fixture();
  const streamTwo = join(owner, "stream-two");
  try {
    mkdirSync(join(streamTwo, ".git"), { recursive: true });
    writeFileSync(join(streamTwo, "AGENTS.md"), "# Stream two\n", "utf8");
    config.agents.streamTwo = { path: "./stream-two", description: "Second stream", routes: {} };
    const review = planAttachments({ ownerCwd: owner, config });
    assert.equal(review.errors.length, 0);
    assert.deepEqual(review.plans.map((plan) => plan.streamId).sort(), ["stream", "streamTwo"].sort());
    const applied = applyAttachments({ ownerCwd: owner, config });
    assert.deepEqual(applied.map((plan) => plan.streamId).sort(), ["stream", "streamTwo"].sort());
    assert.equal(existsSync(join(stream, ".pi", "extensions", "flocky-agent-protocol", "index.ts")), true);
    assert.equal(existsSync(join(streamTwo, ".pi", "extensions", "flocky-agent-protocol", "index.ts")), true);
  } finally { rmSync(owner, { recursive: true, force: true }); }
});

test("bulk attachment review reports per-stream errors without dropping valid plans", () => {
  const { owner, config } = fixture();
  try {
    const review = planAttachments({ ownerCwd: owner, config, streamIds: ["stream", "missing"] });
    assert.deepEqual(review.plans.map((plan) => plan.streamId), ["stream"]);
    assert.deepEqual(review.errors, [{ streamId: "missing", error: "Unknown stream: missing" }]);
  } finally { rmSync(owner, { recursive: true, force: true }); }
});

test("attachment rejects a stream that is not an existing Git repository", () => {
  const { owner, config } = fixture();
  try {
    config.agents.stream.path = "./missing";
    assert.throws(() => planAttachment({ ownerCwd: owner, config, streamId: "stream" }), /does not exist or is not a Git repository/);
  } finally { rmSync(owner, { recursive: true, force: true }); }
});
