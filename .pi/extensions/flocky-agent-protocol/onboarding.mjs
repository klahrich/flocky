import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { applyAttachments, planAttachments } from "./attachment.mjs";

export async function ensureOnboarded(pi, ctx) {
  const configPath = join(ctx.cwd, "flocky.config.json");
  if (existsSync(configPath)) return false;
  if (ctx.mode !== "tui") {
    ctx.ui.notify("Flocky needs onboarding. Start Pi in TUI mode to configure this project.", "warning");
    return false;
  }
  const start = await ctx.ui.confirm("Set up Flocky?", "This project has no flocky.config.json. Start the project onboarding wizard now?");
  if (!start) return false;

  const suggestedId = basename(ctx.cwd).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "project";
  const projectId = await requiredInput(ctx, "Project ID", suggestedId, /^[a-z0-9][a-z0-9-]*$/, "Use lowercase letters, digits, and hyphens.");
  if (!projectId) return false;
  const description = await requiredInput(ctx, "Project description", "What is this project and what outcome does it serve?", /[\s\S]+/, "A description is required.");
  if (description == null) return false;

  const agents = { [projectId]: {} };
  while (await ctx.ui.confirm("Add a stream?", "Add each repository that needs its own long-running Pi agent.")) {
    const id = await requiredInput(ctx, "Stream ID", "e.g. landing", /^[a-z0-9][a-z0-9-]*$/, "Use lowercase letters, digits, and hyphens.");
    if (!id) break;
    if (agents[id]) { ctx.ui.notify(`Stream ${id} already exists`, "warning"); continue; }
    const path = await existingRepositoryPath(ctx, `../${id}`);
    if (!path) break;
    const streamDescription = await requiredInput(ctx, "Stream description", "What does this stream own?", /[\s\S]+/, "A description is required.");
    if (streamDescription == null) break;
    agents[id] = { path, description: streamDescription, routes: {} };
  }

  const transport = await ctx.ui.select("Default stream transport", ["herdr", "telegram"]);
  if (!transport) return false;
  const config = {
    project: { id: projectId, description, ownerAgentId: projectId },
    runtime: { agentId: projectId },
    agents,
    protocol: { secretEnv: "FLOCKY_PROTOCOL_SECRET" },
    transport: { default: transport, fallbackOrder: [transport] },
    compaction: { enabled: true, afterCompletedTasks: 4, contextPercent: 75 },
    onboarding: { version: 1, completedAt: new Date().toISOString() },
  };

  // Persist the core project identity before optional route discovery/provisioning.
  // A failed Herdr call must not discard a completed onboarding wizard.
  writeConfig(configPath, config);
  try {
    if (transport === "telegram") await collectTelegramRoutes(ctx, config);
    if (transport === "herdr") await configureHerdrRoutes(pi, ctx, config);
  } catch (error) {
    ctx.ui.notify(`Flocky was configured, but transport routes need attention: ${message(error)}`, "warning");
  }
  // Save any routes collected above, or retain the core configuration after a failure.
  writeConfig(configPath, config);
  if (transport !== "herdr") await attachInitialStreams(ctx, config);
  writeProjectDescription(ctx.cwd, projectId, description, config.agents);
  updateOwnerAgentsFile(ctx.cwd, readFileSync(join(ctx.cwd, "templates", "project-owner-AGENTS.md"), "utf8"));
  ctx.ui.notify("Flocky onboarding complete. Protocol routing is now active.", "info");
  return true;
}

async function attachInitialStreams(ctx, config) {
  const streamIds = Object.keys(config.agents).filter((id) => id !== config.project.id);
  if (!streamIds.length) return true;
  const review = planAttachments({ ownerCwd: ctx.cwd, config, streamIds });
  const preview = [
    ...review.plans.map((plan) => `${plan.streamId}:\n${plan.actions.map((item) => `• ${item.action}: ${item.path}`).join("\n")}`),
    ...(review.errors.length ? [`Problems:\n${review.errors.map(({ streamId, error }) => `• ${streamId}: ${error}`).join("\n")}`] : []),
  ].join("\n\n");
  if (review.errors.length) {
    ctx.ui.notify(`Streams were registered but could not be attached yet:\n${preview}`, "warning");
    return false;
  }
  if (!await ctx.ui.confirm("Attach configured streams now?", `${preview}\n\nAttachment installs the Flocky extension, stream-local configuration, and a managed AGENTS.md block in each stream repository.`)) {
    ctx.ui.notify("Streams were registered but not attached. Use /attach-stream or /attach-streams later.", "warning");
    return false;
  }
  const attached = applyAttachments({ ownerCwd: ctx.cwd, config, streamIds });
  ctx.ui.notify(`Attached ${attached.length} configured stream(s). Restart Pi in already-running stream repositories to activate Flocky.`, "info");
  return true;
}

async function collectTelegramRoutes(ctx, config) {
  for (const [id, agent] of Object.entries(config.agents)) {
    const target = await ctx.ui.input(`Telegram target for ${id}`, `@${id}_bot (leave blank to configure later)`);
    if (target?.trim()) {
      agent.routes ??= {};
      agent.routes.telegram = { target: target.trim() };
    }
  }
}

async function configureHerdrRoutes(pi, ctx, config) {
  if (process.env.HERDR_ENV !== "1") {
    ctx.ui.notify("Herdr was selected but Pi is not running inside Herdr. Routes can be configured later.", "warning");
    return;
  }
  const workspaceId = process.env.HERDR_WORKSPACE_ID;
  if (!workspaceId) return;
  const workspaces = (await herdr(pi, ["workspace", "list"]))?.result?.workspaces ?? [];
  const panes = (await Promise.all(workspaces.map(async (workspace) => ((await herdr(pi, ["pane", "list", "--workspace", workspace.workspace_id]))?.result?.panes ?? [])))).flat();
  const ownerPane = panes.find((pane) => pane.pane_id === process.env.HERDR_PANE_ID && pane.agent === "pi" && samePath(pane.cwd, ctx.cwd));
  if (ownerPane && await ctx.ui.confirm("Save the project-owner Herdr route?", `${ownerPane.pane_id} — ${ownerPane.cwd}`)) {
    config.agents[config.project.id].routes = { herdr: routeFromPane(ownerPane) };
  }
  const attached = await attachInitialStreams(ctx, config);
  const missing = [];
  for (const [id, agent] of Object.entries(config.agents)) {
    if (id === config.project.id) continue;
    const expected = resolve(ctx.cwd, agent.path);
    const pane = panes.find((candidate) => candidate.agent === "pi" && samePath(candidate.cwd, expected));
    if (!pane) { missing.push([id, agent]); continue; }
    if (await ctx.ui.confirm(`Save Herdr route for ${id}?`, `${pane.pane_id} — ${pane.cwd} — ${pane.agent_status}`)) {
      agent.routes.herdr = routeFromPane(pane);
    }
  }
  if (!missing.length) return;
  if (!attached) {
    ctx.ui.notify("Unattached streams will not be launched. Attach them first, then launch or discover their routes.", "warning");
    return;
  }
  const launch = await ctx.ui.confirm("Launch unmatched stream agents?", `${missing.map(([id]) => id).join(", ")} will each receive a dedicated Herdr workspace.`);
  if (!launch) return;
  for (const [id, agent] of missing) {
    if (!await ctx.ui.confirm(`Launch ${id}?`, `Create a dedicated workspace at ${agent.path} and start Pi.`)) continue;
    const absolutePath = resolve(ctx.cwd, agent.path);
    const created = await herdr(pi, ["workspace", "create", "--cwd", absolutePath, "--label", id, "--no-focus"]);
    const newWorkspace = created?.result?.workspace?.workspace_id ?? created?.result?.workspace_id;
    if (!newWorkspace) { ctx.ui.notify(`Could not determine workspace for ${id}`, "error"); continue; }
    const newPanes = (await herdr(pi, ["pane", "list", "--workspace", newWorkspace]))?.result?.panes ?? [];
    const pane = newPanes[0];
    if (!pane?.pane_id) { ctx.ui.notify(`No initial pane found for ${id}`, "error"); continue; }
    await herdr(pi, ["pane", "rename", pane.pane_id, id]);
    await herdr(pi, ["pane", "run", pane.pane_id, "pi"]);
    try { await herdr(pi, ["wait", "agent-status", pane.pane_id, "--status", "idle", "--timeout", "30000"]); } catch { /* Keep unverified route out of config. */ }
    const verified = (await herdr(pi, ["pane", "get", pane.pane_id]))?.result?.pane;
    if (verified?.agent === "pi" && samePath(verified.cwd, absolutePath)) agent.routes.herdr = routeFromPane(verified);
    else ctx.ui.notify(`${id} launched but could not be verified; configure its route later.`, "warning");
  }
}

async function herdr(pi, args) {
  const result = await pi.exec("herdr", args, { timeout: 35000 });
  if (result.code !== 0) throw new Error(result.stderr || `herdr ${args.join(" ")} failed`);
  return parseHerdrResponse(result.stdout);
}

// `herdr pane run` can intentionally succeed without a JSON receipt.
export function parseHerdrResponse(stdout) {
  const output = typeof stdout === "string" ? stdout.trim() : "";
  return output ? JSON.parse(output) : {};
}
function routeFromPane(pane) { return { paneId: pane.pane_id, workspaceId: pane.workspace_id, expectedCwd: pane.cwd, agent: "pi", verifiedAt: new Date().toISOString() }; }
function samePath(left, right) { return typeof left === "string" && resolve(left).toLowerCase() === resolve(right).toLowerCase(); }
async function existingRepositoryPath(ctx, suggestedPath = "../stream-id") { while (true) { const path = await requiredInput(ctx, "Repository path", suggestedPath, /[\s\S]+/, "A repository path is required."); if (path == null) return null; const absolute = resolve(ctx.cwd, path); if (existsSync(absolute) && existsSync(join(absolute, ".git"))) return path; ctx.ui.notify(`Stream repository does not exist or is not a Git repository: ${absolute}`, "error"); } }
async function requiredInput(ctx, title, placeholder, matcher, error) { while (true) { const value = await ctx.ui.input(title, placeholder); if (value == null) return null; if (matcher.test(value.trim())) return value.trim(); ctx.ui.notify(error, "warning"); } }
function writeConfig(file, config) { mkdirSync(dirname(file), { recursive: true }); writeAtomic(file, `${JSON.stringify(config, null, 2)}\n`); }
function writeProjectDescription(cwd, id, description, agents) { const path = join(cwd, "projects", id, "PROJECT.md"); mkdirSync(dirname(path), { recursive: true }); const streams = Object.entries(agents).filter(([key]) => key !== id).map(([key, agent]) => `- **${key}** — ${agent.description}`).join("\n"); writeAtomic(path, `# ${id}\n\n${description}\n\n## Streams\n${streams}\n`); }
function updateOwnerAgentsFile(cwd, template) {
  const path = join(cwd, "AGENTS.md");
  const start = "<!-- flocky:owner-instructions:start -->";
  const end = "<!-- flocky:owner-instructions:end -->";
  const block = `${start}\n${template.trim()}\n${end}`;
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const matcher = new RegExp(`${escapeRegex(start)}[\\s\\S]*?${escapeRegex(end)}`);
  writeAtomic(path, matcher.test(existing) ? existing.replace(matcher, block) : `${existing.trimEnd()}${existing.trim() ? "\n\n" : ""}${block}\n`);
}
function escapeRegex(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function writeAtomic(file, content) { const temporary = `${file}.${process.pid}.tmp`; writeFileSync(temporary, content, "utf8"); renameSync(temporary, file); }
function message(error) { return error instanceof Error ? error.message : String(error); }
function basename(path) { return path.replace(/[\\/]$/, "").split(/[\\/]/).pop(); }
