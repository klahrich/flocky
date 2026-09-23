import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { applyAttachment, applyAttachments, planAttachment, planAttachments } from "./attachment.mjs";

type Agent = { path?: string; description?: string; routes?: { herdr?: any; telegram?: any } };
type Config = { project: { id: string }; agents: Record<string, Agent> };

export function registerFlockyCommands(pi: ExtensionAPI) {
  pi.registerCommand("flocky", {
    description: "Show Flocky command help",
    handler: async (args, ctx) => {
      const command = args.trim();
      if (!command || command === "help") return ctx.ui.notify(flockyHelp(), "info");
      if (command === "streams") return ctx.ui.notify(streamsHelp(), "info");
      if (command === "routes") return ctx.ui.notify(routesHelp(), "info");
      throw new Error("Usage: /flocky [help|streams|routes]");
    },
  });

  pi.registerCommand("streams", {
    description: "List, add, edit, or remove Flocky stream repositories",
    handler: async (args, ctx) => {
      const command = args.trim();
      if (!command || command === "list") return showStreams(ctx);
      if (command === "help") return ctx.ui.notify(streamsHelp(), "info");
      if (command === "add") return addStream(ctx);
      if (command.startsWith("edit ")) return editStream(ctx, command.slice(5).trim());
      if (command.startsWith("remove ")) return removeStream(ctx, command.slice(7).trim());
      throw new Error("Usage: /streams [help|list|add|edit <id>|remove <id>] (then /attach-stream <id>)");
    },
  });

  pi.registerCommand("attach-stream", {
    description: "Preview and attach an existing stream repository to Flocky",
    handler: async (args, ctx) => {
      requireTui(ctx, "/attach-stream");
      const id = args.trim();
      if (!id) throw new Error("Usage: /attach-stream <stream-id>");
      const config = load(ctx.cwd);
      const plan = planAttachment({ ownerCwd: ctx.cwd, config, streamId: id });
      const preview = plan.actions.map((item: any) => `• ${item.action}: ${item.path}`).join("\n");
      if (!await ctx.ui.confirm(`Attach ${id} to Flocky?`, `${preview}\n\nOnly Flocky-owned files will be created or updated.`)) return;
      applyAttachment({ ownerCwd: ctx.cwd, config, streamId: id });
      ctx.ui.notify(`Attached ${id} to Flocky. Start/reload Pi in that stream repository to activate it.`, "info");
    },
  });

  pi.registerCommand("attach-streams", {
    description: "Preview and attach Flocky-managed files for multiple stream repositories at once",
    handler: async (args, ctx) => {
      requireTui(ctx, "/attach-streams");
      const ids = args.trim() ? args.trim().split(/\s+/).filter(Boolean) : [];
      const config = load(ctx.cwd);
      const review = planAttachments({ ownerCwd: ctx.cwd, config, streamIds: ids });
      const preview = renderAttachmentReview(review);
      if (review.errors.length) throw new Error(`Attachment preview found issues:\n${preview}`);
      const label = ids.length ? ids.join(", ") : `${review.plans.length} configured streams`;
      if (!await ctx.ui.confirm(`Attach ${label} to Flocky?`, `${preview}\n\nOnly Flocky-owned files will be created or updated.`)) return;
      const applied = applyAttachments({ ownerCwd: ctx.cwd, config, streamIds: ids });
      ctx.ui.notify(`Attached ${applied.length} stream(s) to Flocky. Start/reload Pi in those repositories to activate the update.`, "info");
    },
  });

  pi.registerCommand("routes", {
    description: "List, discover, verify, or remove Flocky transport routes",
    handler: async (args, ctx) => {
      const command = args.trim();
      if (!command || command === "list") return showRoutes(ctx);
      if (command === "help") return ctx.ui.notify(routesHelp(), "info");
      if (command === "discover") return discoverHerdrRoutes(pi, ctx);
      if (command === "verify") return verifyHerdrRoutes(pi, ctx);
      if (command.startsWith("remove ")) return removeRoute(ctx, command.slice(7).trim());
      throw new Error("Usage: /routes [help|list|discover|verify|remove <stream-id> [herdr|telegram]]");
    },
  });
}

async function showStreams(ctx: any) {
  const config = load(ctx.cwd);
  const streams = streamEntries(config);
  if (!streams.length) return ctx.ui.notify("No streams are configured.", "info");
  ctx.ui.notify(streams.map(([id, stream]) => `${id} — ${stream.path ?? "no path"}\n  ${stream.description ?? "no description"}`).join("\n"), "info");
}

async function addStream(ctx: any) {
  requireTui(ctx, "/streams add");
  const config = load(ctx.cwd);
  const id = await askId(ctx, "Stream ID", "e.g. landing");
  if (!id) return;
  if (config.agents[id]) throw new Error(`Agent/stream ${id} already exists`);
  const path = await askExistingRepository(ctx, `../${id}`);
  const description = await ask(ctx, "Stream description", "What does this stream own?");
  if (!path || !description) return;
  config.agents[id] = { path, description, routes: {} };
  save(ctx.cwd, config);
  ctx.ui.notify(`Registered stream ${id}`, "info");
  if (!await ctx.ui.confirm(`Attach ${id} now?`, "Attach installs the Flocky extension, local config, and a managed AGENTS.md block in the existing stream repository.")) return;
  const plan = planAttachment({ ownerCwd: ctx.cwd, config, streamId: id });
  const preview = plan.actions.map((item: any) => `• ${item.action}: ${item.path}`).join("\n");
  if (!await ctx.ui.confirm(`Apply attachment plan for ${id}?`, preview)) return;
  applyAttachment({ ownerCwd: ctx.cwd, config, streamId: id });
  ctx.ui.notify(`Attached ${id} to Flocky.`, "info");
}

async function editStream(ctx: any, id: string) {
  requireTui(ctx, "/streams edit");
  const config = load(ctx.cwd);
  const stream = requireStream(config, id);
  const path = await ctx.ui.input(`Repository path for ${id}`, stream.path ?? "");
  if (path == null) return;
  const description = await ctx.ui.input(`Description for ${id}`, stream.description ?? "");
  if (description == null) return;
  if (path.trim() && !isExistingRepository(ctx.cwd, path.trim())) throw new Error(`Stream repository does not exist or is not a Git repository: ${resolve(ctx.cwd, path.trim())}`);
  stream.path = path.trim() || stream.path;
  stream.description = description.trim() || stream.description;
  save(ctx.cwd, config);
  ctx.ui.notify(`Updated stream ${id}`, "info");
}

async function removeStream(ctx: any, id: string) {
  const config = load(ctx.cwd);
  requireStream(config, id);
  if (id === config.project.id) throw new Error("The project owner is not a removable stream");
  if (!await ctx.ui.confirm(`Remove ${id}?`, "This removes its Flocky configuration and routes, not its repository or Herdr workspace.")) return;
  delete config.agents[id];
  save(ctx.cwd, config);
  ctx.ui.notify(`Removed stream ${id}`, "info");
}

async function showRoutes(ctx: any) {
  const config = load(ctx.cwd);
  const lines = streamEntries(config).map(([id, stream]) => {
    const herdr = stream.routes?.herdr?.paneId ? `herdr:${stream.routes.herdr.paneId}` : "herdr:unconfigured";
    const telegram = stream.routes?.telegram?.target ? `telegram:${stream.routes.telegram.target}` : "telegram:unconfigured";
    return `${id} — ${herdr}; ${telegram}`;
  });
  ctx.ui.notify(lines.length ? lines.join("\n") : "No stream routes are configured.", "info");
}

async function discoverHerdrRoutes(pi: ExtensionAPI, ctx: any) {
  requireTui(ctx, "/routes discover");
  if (process.env.HERDR_ENV !== "1") throw new Error("Herdr route discovery requires Pi to run inside Herdr");
  const config = load(ctx.cwd);
  const workspaces = (await herdr(pi, ["workspace", "list"]))?.result?.workspaces ?? [];
  const panes = (await Promise.all(workspaces.map(async (workspace: any) => ((await herdr(pi, ["pane", "list", "--workspace", workspace.workspace_id]))?.result?.panes ?? [])))).flat();
  let saved = 0;
  for (const [id, stream] of streamEntries(config)) {
    if (!stream.path) continue;
    const expected = resolve(ctx.cwd, stream.path);
    const pane = panes.find((candidate: any) => candidate.agent === "pi" && samePath(candidate.cwd, expected));
    if (!pane) continue;
    const overwrite = stream.routes?.herdr?.paneId && stream.routes.herdr.paneId !== pane.pane_id;
    if (overwrite && !await ctx.ui.confirm(`Replace Herdr route for ${id}?`, `${stream.routes?.herdr?.paneId} → ${pane.pane_id}`)) continue;
    if (!overwrite && !await ctx.ui.confirm(`Save Herdr route for ${id}?`, `${pane.pane_id} — ${pane.cwd} — ${pane.agent_status}`)) continue;
    stream.routes ??= {};
    stream.routes.herdr = { paneId: pane.pane_id, workspaceId: pane.workspace_id, expectedCwd: pane.cwd, agent: "pi", verifiedAt: new Date().toISOString() };
    saved++;
  }
  if (saved) save(ctx.cwd, config);
  ctx.ui.notify(saved ? `Saved ${saved} Herdr route(s).` : "No matching new Herdr routes were found.", "info");
}

async function verifyHerdrRoutes(pi: ExtensionAPI, ctx: any) {
  if (process.env.HERDR_ENV !== "1") throw new Error("Herdr route verification requires Pi to run inside Herdr");
  const config = load(ctx.cwd);
  const results: string[] = [];
  for (const [id, stream] of streamEntries(config)) {
    const route = stream.routes?.herdr;
    if (!route?.paneId) { results.push(`${id}: no Herdr route`); continue; }
    try {
      const pane = (await herdr(pi, ["pane", "get", route.paneId]))?.result?.pane;
      const valid = pane?.agent === "pi" && samePath(pane.cwd, route.expectedCwd);
      results.push(`${id}: ${valid ? "valid" : "stale"}${pane?.agent_status ? ` (${pane.agent_status})` : ""}`);
    } catch { results.push(`${id}: unavailable (${route.paneId})`); }
  }
  ctx.ui.notify(results.join("\n") || "No stream routes are configured.", "info");
}

async function removeRoute(ctx: any, args: string) {
  const [id, transport = "herdr"] = args.split(/\s+/, 2);
  if (transport !== "herdr" && transport !== "telegram") throw new Error("Route transport must be herdr or telegram");
  const config = load(ctx.cwd);
  const stream = requireStream(config, id);
  if (!stream.routes?.[transport]) throw new Error(`${id} has no ${transport} route`);
  if (!await ctx.ui.confirm(`Remove ${transport} route for ${id}?`, "The agent and repository stay configured.")) return;
  delete stream.routes[transport];
  save(ctx.cwd, config);
  ctx.ui.notify(`Removed ${transport} route for ${id}`, "info");
}

function flockyHelp() {
  return [
    "Flocky help",
    "",
    "Configuration",
    "• /streams — list configured stream repositories",
    "• /streams help — stream setup and management help",
    "• /attach-stream <id> — preview and attach one registered stream",
    "• /attach-streams [ids...] — preview and attach registered streams in bulk",
    "",
    "Transport routes",
    "• /routes — list configured Herdr and Telegram routes",
    "• /routes help — route discovery, verification, and removal help",
    "",
    "More help",
    "• /flocky help — this overview",
    "• /flocky streams — stream management help",
    "• /flocky routes — route management help",
    "",
    "For dispatch, schedules, status, and transient workers, ask the owner agent; it uses the appropriate Flocky tool.",
  ].join("\n");
}

function streamsHelp() {
  return [
    "Stream management",
    "",
    "• /streams or /streams list — show registered streams, paths, and descriptions",
    "• /streams add — register an existing Git repository, then optionally attach Flocky to it",
    "• /streams edit <id> — change a stream's repository path or description",
    "• /streams remove <id> — remove its Flocky configuration and routes; its repository and Herdr workspace are kept",
    "• /attach-stream <id> — preview and attach Flocky-managed files for one registered stream",
    "• /attach-streams [id ...] — preview and attach all registered streams, or only the listed IDs",
    "",
    "A stream ID uses lowercase letters, digits, and hyphens. Stream repositories must already exist and be Git repositories.",
  ].join("\n");
}

function routesHelp() {
  return [
    "Route management",
    "",
    "• /routes or /routes list — show saved Herdr and Telegram routes for every stream",
    "• /routes discover — find matching Pi panes in managed Herdr workspaces and ask before saving each route",
    "• /routes verify — check whether saved Herdr routes still point to matching Pi panes",
    "• /routes remove <id> [herdr|telegram] — remove one saved route without removing the stream or repository",
    "",
    "Herdr discovery and verification require Pi to be running inside Herdr. Route changes are confirmation-gated.",
  ].join("\n");
}

function renderAttachmentReview(review: { plans: any[]; errors: Array<{ streamId: string; error: string }> }) {
  const sections = review.plans.map((plan) => `${plan.streamId}:\n${plan.actions.map((item: any) => `• ${item.action}: ${item.path}`).join("\n")}`);
  if (review.errors.length) sections.push(`Errors:\n${review.errors.map(({ streamId, error }) => `• ${streamId}: ${error}`).join("\n")}`);
  return sections.join("\n\n");
}

function load(cwd: string): Config { const path = join(cwd, "flocky.config.json"); if (!existsSync(path)) throw new Error("Flocky is not onboarded yet"); return JSON.parse(readFileSync(path, "utf8")); }
function save(cwd: string, config: Config) { const file = join(cwd, "flocky.config.json"); const temporary = `${file}.${process.pid}.tmp`; writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, "utf8"); renameSync(temporary, file); }
function streamEntries(config: Config): Array<[string, Agent]> { return Object.entries(config.agents).filter(([id]) => id !== config.project.id); }
function requireStream(config: Config, id: string): Agent { const stream = config.agents[id]; if (!stream || id === config.project.id) throw new Error(`Unknown stream ${id}`); return stream; }
async function ask(ctx: any, title: string, placeholder: string) { const value = await ctx.ui.input(title, placeholder); return value?.trim(); }
async function askExistingRepository(ctx: any, suggestedPath = "../stream-id") { while (true) { const path = await ask(ctx, "Repository path", suggestedPath); if (!path || isExistingRepository(ctx.cwd, path)) return path; ctx.ui.notify(`Stream repository does not exist or is not a Git repository: ${resolve(ctx.cwd, path)}`, "error"); } }
function isExistingRepository(cwd: string, path: string) { const absolute = resolve(cwd, path); return existsSync(absolute) && existsSync(join(absolute, ".git")); }
async function askId(ctx: any, title: string, placeholder: string) { while (true) { const value = await ask(ctx, title, placeholder); if (!value || /^[a-z0-9][a-z0-9-]*$/.test(value)) return value; ctx.ui.notify("Use lowercase letters, digits, and hyphens.", "warning"); } }
function requireTui(ctx: any, label: string) { if (ctx.mode !== "tui") throw new Error(`${label} requires Pi TUI mode`); }
async function herdr(pi: ExtensionAPI, args: string[]) { const result = await pi.exec("herdr", args, { timeout: 30000 }); if (result.code !== 0) throw new Error(result.stderr || `herdr ${args.join(" ")} failed`); return JSON.parse(result.stdout); }
function samePath(left: string, right: string) { return typeof left === "string" && resolve(left).toLowerCase() === resolve(right).toLowerCase(); }
