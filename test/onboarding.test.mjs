import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureOnboarded } from "../.pi/extensions/flocky-agent-protocol/onboarding.mjs";

test("onboarding completes an owner-only project so streams can be added later", async () => {
  const directory = mkdtempSync(join(tmpdir(), "flocky-onboarding-"));
  const notifications = [];
  const confirms = [true, false]; // Start onboarding; do not add a stream yet.
  const ctx = {
    cwd: directory,
    mode: "tui",
    ui: {
      confirm: async () => confirms.shift(),
      input: async (title) => ({ "Project ID": "owner", "Project description": "Owner-only test project", "Telegram target for owner": "@owner_bot" })[title],
      select: async () => "telegram",
      notify: (...args) => notifications.push(args),
    },
  };

  try {
    // The owner instruction template is an onboarding requirement, not part of this behavior.
    const templates = join(directory, "templates");
    mkdirSync(templates);
    writeFileSync(join(templates, "project-owner-AGENTS.md"), "Owner instructions", "utf8");

    assert.equal(await ensureOnboarded({}, ctx), true);
    const configPath = join(directory, "flocky.config.json");
    assert.equal(existsSync(configPath), true);
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    assert.deepEqual(Object.keys(config.agents), ["owner"]);
    assert.equal(config.agents.owner.routes.telegram.target, "@owner_bot");
    assert.equal(existsSync(join(directory, "projects", "owner", "PROJECT.md")), true);
    assert.equal(notifications.at(-1)[0], "Flocky onboarding complete. Protocol routing is now active.");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("onboarding retains configuration when Herdr route discovery fails", async () => {
  const directory = mkdtempSync(join(tmpdir(), "flocky-onboarding-herdr-"));
  const previousHerdr = process.env.HERDR_ENV;
  const previousWorkspace = process.env.HERDR_WORKSPACE_ID;
  const notifications = [];
  const confirms = [true, false];
  const ctx = {
    cwd: directory,
    mode: "tui",
    ui: {
      confirm: async () => confirms.shift(),
      input: async (title) => ({ "Project ID": "owner", "Project description": "Route-failure test" })[title],
      select: async () => "herdr",
      notify: (...args) => notifications.push(args),
    },
  };

  try {
    mkdirSync(join(directory, "templates"));
    writeFileSync(join(directory, "templates", "project-owner-AGENTS.md"), "Owner instructions", "utf8");
    process.env.HERDR_ENV = "1";
    process.env.HERDR_WORKSPACE_ID = "owner-workspace";
    const pi = { exec: async () => ({ code: 1, stderr: "Herdr unavailable" }) };

    assert.equal(await ensureOnboarded(pi, ctx), true);
    assert.equal(existsSync(join(directory, "flocky.config.json")), true);
    assert.equal(JSON.parse(readFileSync(join(directory, "flocky.config.json"), "utf8")).transport.default, "herdr");
    assert.ok(notifications.some(([text, level]) => level === "warning" && text.includes("transport routes need attention: Herdr unavailable")));
  } finally {
    if (previousHerdr === undefined) delete process.env.HERDR_ENV; else process.env.HERDR_ENV = previousHerdr;
    if (previousWorkspace === undefined) delete process.env.HERDR_WORKSPACE_ID; else process.env.HERDR_WORKSPACE_ID = previousWorkspace;
    rmSync(directory, { recursive: true, force: true });
  }
});
