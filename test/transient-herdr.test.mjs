import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTransientHerdrRun, provisionTransientHerdrRun, shouldCleanupTransientRun, transientCheckoutPath } from "../.pi/extensions/flocky-agent-protocol/transient-herdr.mjs";

function fixture() {
  const owner = mkdtempSync(join(tmpdir(), "flocky-transient-"));
  const stream = join(owner, "stream");
  mkdirSync(join(owner, ".pi", "extensions", "flocky-agent-protocol"), { recursive: true });
  writeFileSync(join(owner, ".pi", "extensions", "flocky-agent-protocol", "index.ts"), "export default function() {}\n");
  mkdirSync(join(owner, "templates"), { recursive: true });
  writeFileSync(join(owner, "templates", "stream-AGENTS.md"), "# Stream instructions\nDo Flocky work.\n");
  mkdirSync(join(stream, ".git"), { recursive: true });
  writeFileSync(join(stream, "AGENTS.md"), "# Existing instructions\n");
  const config = {
    project: { id: "owner" },
    protocol: { secretEnv: "FLOCKY_PROTOCOL_SECRET" },
    compaction: { enabled: true },
    agents: {
      owner: { routes: { herdr: { paneId: "w0:p1", workspaceId: "w0", expectedCwd: owner, agent: "pi" } } },
      stream: { path: "./stream", description: "Fixture stream", routes: {} },
    },
  };
  return { owner, stream, config };
}

test("transient Herdr provisioning bootstraps an isolated checkout and verifies a Pi pane", async () => {
  const { owner, config } = fixture();
  const gitCalls = [];
  const herdrCalls = [];
  try {
    const run = await provisionTransientHerdrRun({
      ownerCwd: owner,
      config,
      streamId: "stream",
      ownerAgentId: "owner",
      protocolSecret: "test-secret",
      runId: "run-1",
      agentId: "transient-run-1",
      execGit: async (args, options) => {
        gitCalls.push({ args, cwd: options.cwd });
      },
      execHerdr: async (args) => {
        herdrCalls.push(args);
        if (args[0] === "workspace" && args[1] === "create") return { result: { workspace_id: "w1" } };
        if (args[0] === "pane" && args[1] === "list") return { result: { panes: [{ pane_id: "w1:p1" }] } };
        if (args[0] === "pane" && args[1] === "get") return { result: { pane: { pane_id: "w1:p1", agent: "pi", cwd: transientCheckoutPath(owner, "run-1") } } };
        return { result: {} };
      },
    });

    assert.deepEqual(gitCalls[0], { args: ["worktree", "add", "--detach", transientCheckoutPath(owner, "run-1"), "HEAD"], cwd: join(owner, "stream") });
    assert.equal(run.workspaceId, "w1");
    assert.equal(run.paneId, "w1:p1");
    assert.equal(run.checkoutPath, transientCheckoutPath(owner, "run-1"));
    assert.equal(existsSync(join(run.checkoutPath, ".pi", "extensions", "flocky-agent-protocol", "index.ts")), true);
    assert.equal(JSON.parse(readFileSync(join(run.checkoutPath, "flocky.config.json"), "utf8")).runtime.agentId, "transient-run-1");
    assert.match(readFileSync(join(run.checkoutPath, ".env"), "utf8"), /FLOCKY_PROTOCOL_SECRET=test-secret/);
    assert.match(readFileSync(join(run.checkoutPath, "AGENTS.md"), "utf8"), /flocky:stream-instructions:start/);
    assert.deepEqual(herdrCalls.map((args) => args.slice(0, 2)), [
      ["workspace", "create"],
      ["pane", "list"],
      ["pane", "rename"],
      ["pane", "run"],
      ["wait", "agent-status"],
      ["pane", "get"],
    ]);
  } finally { rmSync(owner, { recursive: true, force: true }); }
});

test("reviewer provisioning can reuse an existing transient checkout without another git worktree add", async () => {
  const { owner, config } = fixture();
  const gitCalls = [];
  try {
    const checkoutPath = transientCheckoutPath(owner, "run-1");
    mkdirSync(checkoutPath, { recursive: true });
    const run = await provisionTransientHerdrRun({
      ownerCwd: owner,
      config,
      streamId: "stream",
      ownerAgentId: "owner",
      protocolSecret: "test-secret",
      runId: "run-2",
      agentId: "transient-run-2",
      checkoutPath,
      execGit: async (args, options) => { gitCalls.push({ args, cwd: options.cwd }); },
      execHerdr: async (args) => {
        if (args[0] === "workspace" && args[1] === "create") return { result: { workspace_id: "w2" } };
        if (args[0] === "pane" && args[1] === "list") return { result: { panes: [{ pane_id: "w2:p1" }] } };
        if (args[0] === "pane" && args[1] === "get") return { result: { pane: { pane_id: "w2:p1", agent: "pi", cwd: checkoutPath } } };
        return { result: {} };
      },
    });
    assert.equal(gitCalls.length, 0);
    assert.equal(run.checkoutPath, checkoutPath);
    assert.equal(JSON.parse(readFileSync(join(run.checkoutPath, "flocky.config.json"), "utf8")).runtime.agentId, "transient-run-2");
  } finally { rmSync(owner, { recursive: true, force: true }); }
});

test("transient cleanup closes only the workspace when removeCheckout=false", async () => {
  const { owner } = fixture();
  const gitCalls = [];
  const herdrCalls = [];
  try {
    const root = transientCheckoutPath(owner, "run-2");
    mkdirSync(root, { recursive: true });
    await cleanupTransientHerdrRun({
      ownerCwd: owner,
      run: {
        run_id: "run-2",
        workspace_id: "w2",
        source_repo_path: join(owner, "stream"),
        checkout_path: root,
      },
      removeCheckout: false,
      execGit: async (args, options) => { gitCalls.push({ args, cwd: options.cwd }); },
      execHerdr: async (args) => { herdrCalls.push(args); return { result: {} }; },
    });
    assert.deepEqual(herdrCalls[0], ["workspace", "close", "w2"]);
    assert.equal(gitCalls.length, 0);
    assert.equal(existsSync(root), true);
  } finally { rmSync(owner, { recursive: true, force: true }); }
});

test("transient cleanup closes the workspace and removes the git worktree", async () => {
  const { owner } = fixture();
  const gitCalls = [];
  const herdrCalls = [];
  try {
    const root = transientCheckoutPath(owner, "run-2");
    mkdirSync(root, { recursive: true });
    await cleanupTransientHerdrRun({
      ownerCwd: owner,
      run: {
        run_id: "run-2",
        workspace_id: "w2",
        source_repo_path: join(owner, "stream"),
        checkout_path: root,
      },
      execGit: async (args, options) => { gitCalls.push({ args, cwd: options.cwd }); },
      execHerdr: async (args) => { herdrCalls.push(args); return { result: {} }; },
    });
    assert.deepEqual(herdrCalls[0], ["workspace", "close", "w2"]);
    assert.deepEqual(gitCalls[0], { args: ["worktree", "remove", "--force", root], cwd: join(owner, "stream") });
    assert.equal(existsSync(root), false);
  } finally { rmSync(owner, { recursive: true, force: true }); }
});

test("cleanup policy is success-sensitive", () => {
  assert.equal(shouldCleanupTransientRun("preserve", "success"), false);
  assert.equal(shouldCleanupTransientRun("cleanup-on-success", "success"), true);
  assert.equal(shouldCleanupTransientRun("cleanup-on-success", "failed"), false);
  assert.equal(shouldCleanupTransientRun("always-cleanup", "failed"), true);
});
