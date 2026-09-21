import { randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";

const MANAGED_START = "<!-- flocky:stream-instructions:start -->";
const MANAGED_END = "<!-- flocky:stream-instructions:end -->";

export async function provisionTransientHerdrRun({
  ownerCwd,
  config,
  streamId,
  ownerAgentId,
  cleanupPolicy = "cleanup-on-success",
  runId = randomUUID(),
  agentId = transientAgentId(runId),
  protocolSecret,
  piCommand = "pi",
  checkoutPath: requestedCheckoutPath,
  execGit = runGit,
  execHerdr = runHerdr,
}) {
  if (!["preserve", "cleanup-on-success", "always-cleanup"].includes(cleanupPolicy)) throw new Error("Invalid transient cleanup policy");
  const stream = config?.agents?.[streamId];
  if (!stream?.path) throw new Error(`Unknown stream or missing repository path: ${streamId}`);
  const sourceRepoPath = resolve(ownerCwd, stream.path);
  if (!existsSync(sourceRepoPath) || !existsSync(join(sourceRepoPath, ".git"))) throw new Error(`Stream repository does not exist or is not a Git repository: ${sourceRepoPath}`);

  const ownerRoute = config?.agents?.[ownerAgentId]?.routes?.herdr;
  if (!ownerRoute?.paneId || !ownerRoute?.expectedCwd) throw new Error(`Owner ${ownerAgentId} needs a configured Herdr route for transient results`);
  if (!protocolSecret) throw new Error("Protocol secret is required for transient workers");

  const checkoutPath = requestedCheckoutPath ? resolve(requestedCheckoutPath) : transientCheckoutPath(ownerCwd, runId);
  const root = transientRunRoot(ownerCwd, runId, checkoutPath);
  mkdirSync(root, { recursive: true });
  if (!requestedCheckoutPath) await execGit(["worktree", "add", "--detach", checkoutPath, "HEAD"], { cwd: sourceRepoPath });
  else mkdirSync(checkoutPath, { recursive: true });
  bootstrapTransientWorker({ ownerCwd, checkoutPath, config, ownerAgentId, agentId, ownerRoute, protocolSecret });

  const created = await execHerdr(["workspace", "create", "--cwd", checkoutPath, "--label", `${streamId}-${runId}`, "--no-focus"]);
  const workspaceId = created?.result?.workspace?.workspace_id ?? created?.result?.workspace_id;
  if (!workspaceId) throw new Error("Could not determine transient Herdr workspace ID");
  const panes = (await execHerdr(["pane", "list", "--workspace", workspaceId]))?.result?.panes ?? [];
  const pane = panes[0];
  if (!pane?.pane_id) throw new Error(`No initial pane found for transient workspace ${workspaceId}`);
  const paneId = pane.pane_id;
  await execHerdr(["pane", "rename", paneId, agentId]);
  await execHerdr(["pane", "run", paneId, piCommand]);
  await execHerdr(["wait", "agent-status", paneId, "--status", "idle", "--timeout", "30000"]);
  const verified = (await execHerdr(["pane", "get", paneId]))?.result?.pane;
  if (verified?.agent !== "pi") throw new Error(`Transient Herdr pane ${paneId} is not a Pi agent`);
  if (!samePath(verified.cwd, checkoutPath)) throw new Error(`Transient Herdr pane ${paneId} does not match checkout ${checkoutPath}`);

  return {
    runId,
    agentId,
    streamId,
    backend: "herdr",
    cleanupPolicy,
    sourceRepoPath,
    checkoutPath,
    workspaceId,
    paneId,
    route: { paneId, workspaceId, expectedCwd: checkoutPath, agent: "pi" },
  };
}

export async function cleanupTransientHerdrRun({ ownerCwd, run, removeCheckout = true, execGit = runGit, execHerdr = runHerdr }) {
  const errors = [];
  if (run?.workspace_id || run?.workspaceId) {
    try { await execHerdr(["workspace", "close", run.workspace_id ?? run.workspaceId]); }
    catch (error) { errors.push(message(error)); }
  }
  if (removeCheckout && run?.source_repo_path && run?.checkout_path) {
    try { await execGit(["worktree", "remove", "--force", run.checkout_path], { cwd: run.source_repo_path }); }
    catch (error) { errors.push(message(error)); }
  }
  if (removeCheckout) rmSync(transientRunRoot(ownerCwd, run?.run_id ?? run?.runId ?? "", run?.checkout_path ?? run?.checkoutPath), { recursive: true, force: true });
  if (errors.length) throw new Error(errors.join("; "));
}

export function shouldCleanupTransientRun(cleanupPolicy, resultStatus) {
  return cleanupPolicy === "always-cleanup" || (cleanupPolicy === "cleanup-on-success" && resultStatus === "success");
}

export function transientAgentId(runId) {
  return `transient-${String(runId).toLowerCase()}`;
}

export function transientRunRoot(ownerCwd, runId, checkoutPath) {
  if (checkoutPath) return dirname(resolve(checkoutPath));
  return join(ownerCwd, ".pi", "flocky", "transient", runId);
}

export function transientCheckoutPath(ownerCwd, runId) {
  return join(transientRunRoot(ownerCwd, runId), "repo");
}

function bootstrapTransientWorker({ ownerCwd, checkoutPath, config, ownerAgentId, agentId, ownerRoute, protocolSecret }) {
  const extensionSource = join(ownerCwd, ".pi", "extensions", "flocky-agent-protocol");
  if (!existsSync(extensionSource)) throw new Error(`Missing Flocky extension source: ${extensionSource}`);
  const templatePath = join(ownerCwd, "templates", "stream-AGENTS.md");
  if (!existsSync(templatePath)) throw new Error(`Missing transient worker instructions template: ${templatePath}`);

  const destinationExtension = join(checkoutPath, ".pi", "extensions", "flocky-agent-protocol");
  mkdirSync(dirname(destinationExtension), { recursive: true });
  cpSync(extensionSource, destinationExtension, { recursive: true, force: true });

  const streamConfig = {
    project: config.project,
    runtime: { agentId },
    agents: {
      [ownerAgentId]: config.agents[ownerAgentId],
    },
    protocol: config.protocol,
    transport: { default: "herdr", fallbackOrder: ["herdr"] },
    compaction: config.compaction,
    onboarding: { version: 1, transientAttachedAt: new Date().toISOString(), transientOwner: ownerAgentId },
    transient: { enabled: true, runType: "herdr", ownerRoute },
  };
  writeAtomic(join(checkoutPath, "flocky.config.json"), `${JSON.stringify(streamConfig, null, 2)}\n`);
  const secretEnv = config.protocol?.secretEnv ?? "FLOCKY_PROTOCOL_SECRET";
  writeAtomic(join(checkoutPath, ".env"), `${secretEnv}=${protocolSecret}\n`);
  updateAgentsFile(checkoutPath, readFileSync(templatePath, "utf8"));
}

function updateAgentsFile(streamCwd, template) {
  const path = join(streamCwd, "AGENTS.md");
  const block = `${MANAGED_START}\n${template.trim()}\n${MANAGED_END}`;
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const matcher = new RegExp(`${escapeRegex(MANAGED_START)}[\\s\\S]*?${escapeRegex(MANAGED_END)}`);
  writeAtomic(path, matcher.test(existing) ? existing.replace(matcher, block) : `${existing.trimEnd()}${existing.trim() ? "\n\n" : ""}${block}\n`);
}

function writeAtomic(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, content, "utf8");
  renameSync(temporary, path);
}

function escapeRegex(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function samePath(left, right) { return typeof left === "string" && resolve(left).toLowerCase() === resolve(right).toLowerCase(); }
function message(error) { return error instanceof Error ? error.message : String(error); }

function runGit(args, { cwd, signal } = {}) {
  return spawnJson("git", args, { cwd, signal, json: false }).then((result) => result.stdout);
}

function runHerdr(args, { signal } = {}) {
  return spawnJson(process.env.FLOCKY_HERDR_COMMAND || "herdr", args, { signal, json: true, shell: String(process.env.FLOCKY_HERDR_COMMAND || "herdr").toLowerCase().endsWith(".cmd") });
}

function spawnJson(command, args, { cwd, signal, json, shell = false }) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, env: process.env, windowsHide: true, shell });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(stderr.trim() || `${command} ${args.join(" ")} exited ${code}`));
      if (!json) return resolvePromise({ stdout: stdout.trim() });
      if (!stdout.trim()) return resolvePromise({});
      try { resolvePromise(JSON.parse(stdout)); } catch (error) { reject(error); }
    });
    signal?.addEventListener("abort", () => child.kill(), { once: true });
  });
}
