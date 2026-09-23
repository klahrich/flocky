import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const MANAGED_START = "<!-- flocky:stream-instructions:start -->";
const MANAGED_END = "<!-- flocky:stream-instructions:end -->";

export function attachmentStreamIds(config, streamIds = []) {
  const ownerId = config.project?.id;
  const configured = Object.keys(config.agents ?? {}).filter((id) => id !== ownerId);
  const selected = streamIds.length ? [...new Set(streamIds)] : configured;
  if (!selected.length) throw new Error("No stream repositories are configured for attachment");
  return selected;
}

export function planAttachments({ ownerCwd, config, streamIds = [], replaceConflictingEnvironment = false }) {
  const selected = attachmentStreamIds(config, streamIds);
  const plans = [];
  const errors = [];
  for (const streamId of selected) {
    try {
      plans.push(planAttachment({ ownerCwd, config, streamId, replaceConflictingEnvironment }));
    } catch (error) {
      errors.push({ streamId, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { streamIds: selected, plans, errors };
}

export function applyAttachments({ ownerCwd, config, streamIds = [], replaceConflictingEnvironment = false }) {
  const review = planAttachments({ ownerCwd, config, streamIds, replaceConflictingEnvironment });
  if (review.errors.length) throw new Error(`Cannot attach streams:\n${review.errors.map(({ streamId, error }) => `- ${streamId}: ${error}`).join("\n")}`);
  return review.plans.map((plan) => applyAttachment({ ownerCwd, config, streamId: plan.streamId, replaceConflictingEnvironment }));
}

export function planAttachment({ ownerCwd, config, streamId, replaceConflictingEnvironment = false }) {
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
  const environment = planEnvironmentSync(ownerCwd, streamCwd, telegramNeeded, replaceConflictingEnvironment);
  const actions = [
    { path: ".env", action: environment.action },
    { path: ".pi/extensions/flocky-agent-protocol", action: existsSync(join(streamCwd, ".pi", "extensions", "flocky-agent-protocol")) ? "replace Flocky extension" : "install Flocky extension" },
    { path: "flocky.config.json", action: existsSync(join(streamCwd, "flocky.config.json")) ? "replace local Flocky config" : "create local Flocky config" },
    { path: "AGENTS.md", action: existsSync(join(streamCwd, "AGENTS.md")) ? "update Flocky-managed instruction block" : "create Flocky stream instructions" },
    { path: ".pi/flocky/attachment.json", action: "record attachment metadata" },
  ];
  if (telegramNeeded) actions.splice(1, 0, { path: ".agents/skills/telegram", action: existsSync(join(streamCwd, ".agents", "skills", "telegram")) ? "replace Flocky Telegram skill" : "install Flocky Telegram skill" });
  return { streamId, streamCwd, extensionSource, telegramSource, telegramNeeded, actions };
}

export function applyAttachment({ ownerCwd, config, streamId, replaceConflictingEnvironment = false }) {
  const plan = planAttachment({ ownerCwd, config, streamId, replaceConflictingEnvironment });
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
  syncEnvironment(ownerCwd, plan.streamCwd, plan.telegramNeeded, replaceConflictingEnvironment);
  writeAtomic(join(plan.streamCwd, "flocky.config.json"), `${JSON.stringify(streamConfig, null, 2)}\n`);
  updateAgentsFile(plan.streamCwd, readFileSync(join(ownerCwd, "templates", "stream-AGENTS.md"), "utf8"));
  writeAtomic(join(plan.streamCwd, ".pi", "flocky", "attachment.json"), `${JSON.stringify({ schemaVersion: 1, streamId, attachedAt: new Date().toISOString(), ownerProject: config.project.id }, null, 2)}\n`);
  return plan;
}

function requiredEnvironmentKeys(telegramNeeded) {
  return telegramNeeded ? ["FLOCKY_PROTOCOL_SECRET", "TELEGRAM_API_ID", "TELEGRAM_API_HASH"] : ["FLOCKY_PROTOCOL_SECRET"];
}

function planEnvironmentSync(ownerCwd, streamCwd, telegramNeeded, replaceConflictingEnvironment = false) {
  const required = requiredEnvironmentKeys(telegramNeeded);
  const source = readEnv(join(ownerCwd, ".env"));
  const missing = required.filter((key) => !source[key]);
  if (missing.length) throw new Error(`Owner .env is missing required Flocky transport values: ${missing.join(", ")}`);
  const targetPath = join(streamCwd, ".env");
  const target = readEnv(targetPath);
  const conflicting = required.filter((key) => target[key] && target[key] !== source[key]);
  if (conflicting.length && !replaceConflictingEnvironment) throw new Error(`Stream .env has a different ${conflicting.join(", ")}; resolve it manually before attachment`);
  const additions = required.filter((key) => !target[key]);
  if (conflicting.length) return { action: `replace conflicting local Flocky values (${conflicting.join(", ")})${additions.length ? ` and add (${additions.join(", ")})` : ""}` };
  return { action: additions.length ? (existsSync(targetPath) ? `append required local Flocky values (${additions.join(", ")})` : "create required local Flocky .env values") : "keep existing required local Flocky .env values" };
}

function syncEnvironment(ownerCwd, streamCwd, telegramNeeded, replaceConflictingEnvironment = false) {
  const plan = planEnvironmentSync(ownerCwd, streamCwd, telegramNeeded, replaceConflictingEnvironment);
  if (plan.action.startsWith("keep")) return;
  const source = readEnv(join(ownerCwd, ".env"));
  const targetPath = join(streamCwd, ".env");
  const required = requiredEnvironmentKeys(telegramNeeded);
  const target = readEnv(targetPath);
  let existing = existsSync(targetPath) ? readFileSync(targetPath, "utf8").trimEnd() : "";
  for (const key of required) {
    if (target[key] && target[key] !== source[key]) {
      const expression = new RegExp(`^\\s*${key}\\s*=.*$`, "m");
      existing = existing.replace(expression, `${key}=${source[key]}`);
    }
  }
  const additions = required.filter((key) => !target[key]).map((key) => `${key}=${source[key]}`);
  writeAtomic(targetPath, additions.length ? `${existing}${existing ? "\n" : ""}# Flocky local transport configuration\n${additions.join("\n")}\n` : `${existing}\n`);
}

function readEnv(path) {
  if (!existsSync(path)) return {};
  const values = {};
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) { const line = raw.trim(); const separator = line.indexOf("="); if (!line || line.startsWith("#") || separator <= 0) continue; let value = line.slice(separator + 1).trim(); if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1); values[line.slice(0, separator).trim()] = value; }
  return values;
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
