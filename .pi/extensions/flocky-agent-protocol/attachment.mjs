import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const MANAGED_START = "<!-- flocky:stream-instructions:start -->";
const MANAGED_END = "<!-- flocky:stream-instructions:end -->";

export function planAttachment({ ownerCwd, config, streamId }) {
  const stream = config.agents?.[streamId];
  const ownerId = config.project?.id;
  if (!stream || streamId === ownerId) throw new Error(`Unknown stream: ${streamId}`);
  if (!stream.path) throw new Error(`Stream ${streamId} has no repository path`);
  const streamCwd = resolve(ownerCwd, stream.path);
  if (!existsSync(streamCwd) || !existsSync(join(streamCwd, ".git"))) throw new Error(`Stream repository does not exist or is not a Git repository: ${streamCwd}`);
  if (!ownerId || !config.agents?.[ownerId]) throw new Error("Project owner is missing from agent configuration");
  const ownerRoutes = config.agents[ownerId].routes ?? {};
  if (!ownerRoutes.herdr && !ownerRoutes.telegram && !config.agents[ownerId].telegramTarget) throw new Error("Configure a route for the project owner before attaching streams");
  const extensionSource = join(ownerCwd, ".pi", "extensions", "flocky-agent-protocol");
  if (!existsSync(extensionSource)) throw new Error(`Missing Flocky extension source: ${extensionSource}`);
  const telegramNeeded = config.transport?.default === "telegram" || config.transport?.fallbackOrder?.includes("telegram");
  const telegramSource = join(ownerCwd, ".agents", "skills", "telegram");
  if (telegramNeeded && !existsSync(telegramSource)) throw new Error(`Telegram transport is configured but the skill is missing: ${telegramSource}`);
  const actions = [
    { path: ".pi/extensions/flocky-agent-protocol", action: existsSync(join(streamCwd, ".pi", "extensions", "flocky-agent-protocol")) ? "replace Flocky extension" : "install Flocky extension" },
    { path: "flocky.config.json", action: existsSync(join(streamCwd, "flocky.config.json")) ? "replace local Flocky config" : "create local Flocky config" },
    { path: "AGENTS.md", action: existsSync(join(streamCwd, "AGENTS.md")) ? "update Flocky-managed instruction block" : "create Flocky stream instructions" },
    { path: ".pi/flocky/attachment.json", action: "record attachment metadata" },
  ];
  if (telegramNeeded) actions.splice(1, 0, { path: ".agents/skills/telegram", action: existsSync(join(streamCwd, ".agents", "skills", "telegram")) ? "replace Flocky Telegram skill" : "install Flocky Telegram skill" });
  return { streamCwd, extensionSource, telegramSource, telegramNeeded, actions };
}

export function applyAttachment({ ownerCwd, config, streamId }) {
  const plan = planAttachment({ ownerCwd, config, streamId });
  const destinationExtension = join(plan.streamCwd, ".pi", "extensions", "flocky-agent-protocol");
  mkdirSync(dirname(destinationExtension), { recursive: true });
  cpSync(plan.extensionSource, destinationExtension, { recursive: true, force: true });
  if (plan.telegramNeeded) {
    const target = join(plan.streamCwd, ".agents", "skills", "telegram");
    mkdirSync(dirname(target), { recursive: true });
    cpSync(plan.telegramSource, target, { recursive: true, force: true });
  }
  const streamConfig = {
    project: config.project,
    runtime: { agentId: streamId },
    agents: config.agents,
    protocol: config.protocol,
    transport: config.transport,
    compaction: config.compaction,
    onboarding: { version: 1, attachedAt: new Date().toISOString(), attachedBy: config.project.id },
  };
  writeAtomic(join(plan.streamCwd, "flocky.config.json"), `${JSON.stringify(streamConfig, null, 2)}\n`);
  updateAgentsFile(plan.streamCwd, readFileSync(join(ownerCwd, "templates", "stream-AGENTS.md"), "utf8"));
  writeAtomic(join(plan.streamCwd, ".pi", "flocky", "attachment.json"), `${JSON.stringify({ schemaVersion: 1, streamId, attachedAt: new Date().toISOString(), ownerProject: config.project.id }, null, 2)}\n`);
  return plan;
}

function updateAgentsFile(streamCwd, template) {
  const path = join(streamCwd, "AGENTS.md");
  const block = `${MANAGED_START}\n${template.trim()}\n${MANAGED_END}`;
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const matcher = new RegExp(`${escapeRegex(MANAGED_START)}[\\s\\S]*?${escapeRegex(MANAGED_END)}`);
  writeAtomic(path, matcher.test(existing) ? existing.replace(matcher, block) : `${existing.trimEnd()}${existing.trim() ? "\n\n" : ""}${block}\n`);
}

function writeAtomic(path, content) { mkdirSync(dirname(path), { recursive: true }); const temporary = `${path}.${process.pid}.tmp`; writeFileSync(temporary, content, "utf8"); renameSync(temporary, path); }
function escapeRegex(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
