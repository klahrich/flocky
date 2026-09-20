#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { FlockyStore } from "../.pi/extensions/flocky-agent-protocol/store.mjs";
import { buildEnvelope } from "../.pi/extensions/flocky-agent-protocol/protocol.mjs";
import { loadProjectEnv } from "../.pi/extensions/flocky-agent-protocol/config.mjs";
import { sendAsTelegramUser } from "../.pi/extensions/flocky-agent-protocol/transport.mjs";
import { sendViaHerdr } from "../.pi/extensions/flocky-agent-protocol/herdr.mjs";

const args = process.argv.slice(2);
const value = (name) => args[args.indexOf(name) + 1];
const jobId = value("--job");
const cwd = resolve(value("--cwd") ?? process.cwd());
if (!jobId) throw new Error("Usage: node tools/flocky-schedule.mjs --job <schedule-id> [--cwd <project-dir>] [--occurrence <key>]");
loadProjectEnv(cwd);
const configPath = join(cwd, "flocky.config.json");
if (!existsSync(configPath)) throw new Error("Flocky project configuration is missing");
const config = JSON.parse(readFileSync(configPath, "utf8"));
const owner = config.project?.id;
const secret = process.env[config.protocol?.secretEnv ?? "FLOCKY_PROTOCOL_SECRET"];
if (!owner || !secret) throw new Error("Project ID or protocol secret is unavailable");
const store = new FlockyStore(join(cwd, ".pi", "flocky", "flocky.db"));
try {
  const row = store.scheduledJob(jobId);
  if (!row?.enabled) throw new Error(`Schedule ${jobId} is missing or disabled`);
  const job = row.definition;
  const recipient = config.agents?.[job.recipient];
  if (!recipient) throw new Error(`Schedule recipient ${job.recipient} is no longer configured`);
  const route = job.transport === "telegram" ? recipient.routes?.telegram?.target ?? recipient.telegramTarget : recipient.routes?.herdr;
  if (!route) throw new Error(`No ${job.transport} route is configured for ${job.recipient}`);
  const occurrence = value("--occurrence") ?? `${job.id}:${occurrenceHour(new Date(), job.timezone)}`;
  const taskId = randomUUID();
  if (!store.claimScheduledRun(occurrence, job.id, taskId)) { console.log(`Skipped duplicate occurrence ${occurrence}`); process.exitCode = 0; }
  else {
    const payload = buildEnvelope({ type: "task", task_id: taskId, from: owner, to: job.recipient, reply_to: owner, answer_back: job.answerBack ? "yes" : "no" }, job.task, secret);
    store.recordDispatch(taskId, job.recipient, job.transport, job.task, payload);
    store.enqueueResult(taskId, job.recipient, job.transport, payload);
    const outbox = store.outboxForTask(taskId);
    try {
      if (job.transport === "telegram") await sendAsTelegramUser({ cwd, config, target: route, text: payload });
      else await sendViaHerdr({ cwd, route, text: payload });
      store.recordDeliveryAttempt(outbox.id, job.transport, "sent"); store.markSent(outbox.id, job.transport);
      console.log(`Scheduled run ${occurrence} dispatched as ${taskId}`);
    } catch (error) { store.recordDeliveryAttempt(outbox.id, job.transport, "failed", error); store.markRetry(outbox.id, error); throw error; }
  }
} finally { store.close(); }

function occurrenceHour(date, timeZone) {
  const parts = new Intl.DateTimeFormat("sv-SE", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:00[${timeZone}]`;
}
