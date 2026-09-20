import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildEnvelope, parseEnvelope, verifyEnvelope } from "./protocol.mjs";
import { FlockyStore } from "./store.mjs";
import { sendAsTelegramUser } from "./transport.mjs";
import { sendViaHerdr } from "./herdr.mjs";
import { ensureOnboarded } from "./onboarding.mjs";
import { registerFlockyCommands } from "./commands";
import { applyAttachment, planAttachment } from "./attachment.mjs";
import { parseOutcome } from "./outcome.mjs";
import { deliverWithFallback } from "./delivery.mjs";
import { loadProjectEnv } from "./config.mjs";

type Config = {
  project?: { id?: string };
  runtime?: { agentId?: string };
  agents?: Record<string, { telegramTarget?: string; path?: string; routes?: { telegram?: { target?: string }; herdr?: { paneId?: string; workspaceId?: string; expectedCwd?: string; agent?: string } } }>;
  protocol?: { secretEnv?: string };
  transport?: { default?: "telegram" | "herdr"; fallbackOrder?: string[]; [key: string]: unknown };
  compaction?: { enabled?: boolean; afterCompletedTasks?: number; contextPercent?: number };
};

export default function flockyAgentProtocol(pi: ExtensionAPI) {
  registerFlockyCommands(pi);
  let store: FlockyStore | undefined;
  let config: Config | undefined;
  let agentId: string | undefined;
  let secret: string | undefined;
  let activeTaskId: string | undefined;
  let latestAnswer = "";
  let sending = false;

  pi.registerTool({
    name: "flocky_complete",
    label: "Flocky Complete",
    description: "Record the one structured terminal outcome for the active delegated Flocky task.",
    promptSnippet: "Record the validated structured completion of the active Flocky task",
    promptGuidelines: ["For every delegated Flocky task, call flocky_complete exactly once after work and validation; do not claim a successful Flocky outcome in prose alone."],
    parameters: Type.Object({
      status: Type.String({ description: "success, partial, blocked, failed, or refused" }),
      summary: Type.String(),
      completed: Type.Array(Type.String()),
      notCompleted: Type.Array(Type.String()),
      validation: Type.Array(Type.String()),
      reason: Type.String(),
      safeState: Type.String(),
      nextAction: Type.String(),
    }),
    async execute(_toolCallId, params) {
      if (!store || !activeTaskId) throw new Error("flocky_complete requires an active delegated Flocky task");
      if (!["success", "partial", "blocked", "failed", "refused"].includes(params.status)) throw new Error("Invalid Flocky completion status");
      if (!params.summary.trim() || !params.safeState.trim() || !params.nextAction.trim()) throw new Error("summary, safeState, and nextAction are required");
      if (params.status === "success" && (params.validation.length === 0 || params.notCompleted.length > 0)) throw new Error("success requires validation evidence and no remaining work");
      const completion = { ...params, status: params.status as "success" | "partial" | "blocked" | "failed" | "refused" };
      if (store.completionForTask(activeTaskId)) throw new Error("This Flocky task already has a completion record");
      store.recordCompletion(activeTaskId, completion);
      return { content: [{ type: "text", text: `Recorded ${completion.status} completion for ${activeTaskId}.` }], details: { taskId: activeTaskId, completion }, terminate: true };
    },
  });

  pi.registerTool({
    name: "flocky_status",
    label: "Flocky Status",
    description: "Show non-secret Flocky protocol, task, and outbox diagnostic state for this agent.",
    promptSnippet: "Inspect Flocky protocol and delivery status",
    promptGuidelines: ["Use flocky_status when diagnosing Flocky setup, a missing task, or an undelivered stream result."],
    parameters: Type.Object({}),
    async execute() {
      const summary = store?.statusSummary();
      const active = Boolean(store && config && agentId && secret);
      const lines = [
        `Protocol: ${active ? "active" : "inactive"}`,
        `Agent ID: ${agentId ?? "unavailable"}`,
        `Configuration: ${config ? "loaded" : "unavailable"}`,
        `Protocol secret: ${secret ? "available" : "missing"}`,
        `Database: ${store ? "open at .pi/flocky/flocky.db" : "unavailable"}`,
      ];
      if (summary) {
        lines.push(`Tasks: ${summary.taskCounts.map((row: any) => `${row.status}=${row.count}`).join(", ") || "none"}`);
        lines.push(`Outbox: ${summary.outboxCounts.map((row: any) => `${row.status}=${row.count}`).join(", ") || "none"}`);
        if (summary.latestFailure) lines.push(`Latest delivery error: ${summary.latestFailure.task_id} → ${summary.latestFailure.recipient} via ${summary.latestFailure.transport}: ${summary.latestFailure.last_error}`);
      }
      return { content: [{ type: "text", text: lines.join("\n") }], details: { active, agentId, summary } };
    },
  });

  pi.registerTool({
    name: "flocky_schedule_pause",
    label: "Pause Flocky Schedule",
    description: "Durably disable a scheduled Flocky job so future runner invocations refuse to dispatch it.",
    parameters: Type.Object({ job: Type.String(), confirm: Type.Boolean() }),
    async execute(_id, params) {
      if (!store || !agentId || agentId !== config?.project?.id) throw new Error("Only the active project owner can pause schedules");
      if (!store.scheduledJob(params.job)) throw new Error(`Unknown schedule: ${params.job}`);
      if (!params.confirm) return { content: [{ type: "text", text: `Preview: pause ${params.job}. Existing Windows triggers will remain but safely skip dispatch until removed or re-enabled.` }] };
      store.setScheduledJobEnabled(params.job, false);
      return { content: [{ type: "text", text: `Paused Flocky schedule ${params.job}.` }] };
    },
  });

  pi.registerTool({
    name: "flocky_schedule_uninstall_windows",
    label: "Uninstall Windows Flocky Schedule",
    description: "Preview or remove only the named Windows Task Scheduler trigger for an existing Flocky schedule.",
    parameters: Type.Object({ job: Type.String(), confirm: Type.Boolean() }),
    async execute(_id, params, _signal, _update, ctx) {
      if (!store || !agentId || agentId !== config?.project?.id) throw new Error("Only the active project owner can uninstall schedules");
      if (!store.scheduledJob(params.job)) throw new Error(`Unknown schedule: ${params.job}`);
      const taskName = `Flocky_${config.project?.id}_${params.job}`;
      if (!params.confirm) return { content: [{ type: "text", text: `Preview: remove only Windows task ${taskName}; the durable Flocky schedule remains unchanged.` }], details: { taskName } };
      const result = await pi.exec("powershell", ["-NoProfile", "-Command", `Unregister-ScheduledTask -TaskName '${taskName.replace(/'/g, "''")}' -Confirm:$false`], { timeout: 30000 });
      if (result.code !== 0) throw new Error(result.stderr || result.stdout || "Windows task removal failed");
      return { content: [{ type: "text", text: `Removed Windows task ${taskName}.` }], details: { taskName, removed: true } };
    },
  });

  pi.registerTool({
    name: "flocky_schedule_install_windows",
    label: "Install Windows Flocky Schedule",
    description: "Preview or install the local Windows Task Scheduler trigger for an existing Flocky schedule.",
    parameters: Type.Object({ job: Type.String(), localTimes: Type.Array(Type.String()), confirm: Type.Boolean() }),
    async execute(_id, params, _signal, _update, ctx) {
      if (!store || !agentId || agentId !== config?.project?.id) throw new Error("Only the active project owner can install schedules");
      if (!store.scheduledJob(params.job)) throw new Error(`Unknown schedule: ${params.job}`);
      if (!params.localTimes.length || params.localTimes.some((time) => !/^([01]\\d|2[0-3]):[0-5]\\d$/.test(time))) throw new Error("localTimes must use HH:mm");
      const taskName = `Flocky_${config.project?.id}_${params.job}`;
      const args = ["-ExecutionPolicy", "Bypass", "-File", join(ctx.cwd, "tools", "install-windows-flocky-schedule.ps1"), "-TaskName", taskName, "-ProjectPath", ctx.cwd, "-JobId", params.job, "-AtLocalTime", ...params.localTimes];
      if (!params.confirm) return { content: [{ type: "text", text: `Preview: ${taskName} will run ${params.job} daily at local times ${params.localTimes.join(", ")}. Confirm to install.` }], details: { taskName, args } };
      const result = await pi.exec("powershell", [...args, "-Apply"], { timeout: 30000 });
      if (result.code !== 0) throw new Error(result.stderr || result.stdout || "Windows task installation failed");
      return { content: [{ type: "text", text: result.stdout.trim() }], details: { taskName, installed: true } };
    },
  });

  pi.registerTool({
    name: "flocky_schedule_create",
    label: "Create Flocky Schedule",
    description: "Create or update a confirmed recurring internal Flocky task. Windows execution is installed separately on the designated scheduler host.",
    promptSnippet: "Create a confirmed recurring Flocky schedule",
    promptGuidelines: ["Use only after showing the user a schedule preview and receiving explicit confirmation. Default timezone is America/Toronto. Scheduled targets must be configured streams."],
    parameters: Type.Object({
      id: Type.String(), recipient: Type.String(), task: Type.String(), cron: Type.String({ description: "Five-field cron" }),
      timezone: Type.Optional(Type.String()), answerBack: Type.Optional(Type.Boolean()), transport: Type.Optional(Type.String()),
      concurrencyKey: Type.Optional(Type.String()), missedRunPolicy: Type.Optional(Type.String()),
    }),
    async execute(_id, params) {
      if (!store || !config || !agentId || agentId !== config.project?.id) throw new Error("Only an active project owner can create schedules");
      if (!config.agents?.[params.recipient] || params.recipient === agentId) throw new Error(`Unknown stream: ${params.recipient}`);
      if (!params.task.trim() || !/^\S+(\s+\S+){4}$/.test(params.cron.trim())) throw new Error("A non-empty task and five-field cron schedule are required");
      const transport = params.transport ?? transportFor(config, params.recipient);
      if (!routeFor(config, params.recipient, transport)) throw new Error(`No ${transport} route is configured for ${params.recipient}`);
      const job = { id: params.id, recipient: params.recipient, task: params.task.trim(), cron: params.cron.trim(), timezone: params.timezone ?? "America/Toronto", answerBack: params.answerBack ?? true, transport, concurrencyKey: params.concurrencyKey ?? params.recipient, missedRunPolicy: params.missedRunPolicy ?? "skip", actionPolicy: "internal_task", enabled: true };
      store.saveScheduledJob(job);
      return { content: [{ type: "text", text: `Created schedule ${job.id}: ${job.cron} (${job.timezone}) → ${job.recipient} via ${job.transport}. Install its Windows trigger on the scheduler host before it can run.` }], details: job };
    },
  });

  pi.registerTool({
    name: "flocky_dispatch", 
    label: "Flocky Dispatch",
    description: "Dispatch a signed durable task from the project owner to one configured stream agent.",
    promptSnippet: "Dispatch a task to a configured Flocky stream agent",
    promptGuidelines: ["Use flocky_dispatch to delegate repository work to a configured Flocky stream; do not manually compose Flocky envelopes."],
    parameters: Type.Object({
      stream: Type.String({ description: "Configured stream ID" }),
      task: Type.String({ description: "Complete task instructions and acceptance criteria" }),
      answerBack: Type.Optional(Type.Boolean({ description: "Whether the stream must report its final result to the owner; defaults to true" })),
      transport: Type.Optional(Type.String({ description: "Optional configured transport override: herdr or telegram" })),
      taskId: Type.Optional(Type.String({ description: "Reuse a prior task ID only to retry the exact same dispatch" })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (!store || !config || !agentId || !secret) throw new Error("Flocky is not configured; complete onboarding first");
      if (agentId !== config.project?.id) throw new Error("Only the project-owner agent can dispatch Flocky tasks");
      if (!config.agents?.[params.stream] || params.stream === agentId) throw new Error(`Unknown stream: ${params.stream}`);
      const answerBack = params.answerBack ?? true;
      const selectedTransport = params.transport ?? transportFor(config, params.stream);
      if (selectedTransport !== "telegram" && selectedTransport !== "herdr") throw new Error("Transport must be herdr or telegram");
      if (!routeFor(config, params.stream, selectedTransport)) throw new Error(`No ${selectedTransport} route is configured for ${params.stream}`);
      const taskId = params.taskId ?? randomUUID();
      const body = params.task.trim();
      if (!body) throw new Error("Task instructions cannot be empty");
      const payload = buildEnvelope({ type: "task", task_id: taskId, from: agentId, to: params.stream, reply_to: agentId, answer_back: answerBack ? "yes" : "no" }, body, secret);
      const prior = store.dispatchForTask(taskId);
      if (prior && prior.payload !== payload) throw new Error(`Task ID ${taskId} already belongs to a different dispatch`);
      store.recordDispatch(taskId, params.stream, selectedTransport, body, payload);
      store.enqueueResult(taskId, params.stream, selectedTransport, payload);
      await flushOutbox(ctx, signal);
      const outbox = store.outboxForTask(taskId);
      const state = outbox?.status ?? "pending";
      return {
        content: [{ type: "text", text: `Task ${taskId} dispatched to ${params.stream} via ${selectedTransport} (${state}).` }],
        details: { taskId, stream: params.stream, transport: selectedTransport, deliveryStatus: state },
      };
    },
  });

  pi.registerTool({
    name: "flocky_attach_stream",
    label: "Attach Flocky Stream",
    description: "Preview or attach an existing Git stream repository to the Flocky protocol framework.",
    promptSnippet: "Attach a registered existing Git stream repository to Flocky",
    promptGuidelines: ["Use flocky_attach_stream only when the user asks to attach a newly registered stream or attachment is known to be incomplete; do not call it merely to dispatch an already attached stream."],
    parameters: Type.Object({
      stream: Type.String({ description: "Registered stream ID" }),
      confirm: Type.Boolean({ description: "False returns the exact file-change plan; true applies that reviewed plan" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!config || !agentId) throw new Error("Flocky is not configured; complete onboarding first");
      if (agentId !== config.project?.id) throw new Error("Only the project-owner agent can attach streams");
      const plan = planAttachment({ ownerCwd: ctx.cwd, config, streamId: params.stream });
      if (!params.confirm) {
        return { content: [{ type: "text", text: `Attachment plan for ${params.stream}:\n${plan.actions.map((item: any) => `- ${item.action}: ${item.path}`).join("\n")}\n\nReview this plan, then call flocky_attach_stream with confirm=true.` }], details: { stream: params.stream, actions: plan.actions, applied: false } };
      }
      const applied = applyAttachment({ ownerCwd: ctx.cwd, config, streamId: params.stream });
      return { content: [{ type: "text", text: `Attached ${params.stream} at ${applied.streamCwd}. Installed Flocky-owned files: ${applied.actions.map((item: any) => item.path).join(", ")}.` }], details: { stream: params.stream, actions: applied.actions, applied: true } };
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    try {
      loadProjectEnv(ctx.cwd);
      await ensureOnboarded(pi, ctx);
      config = loadConfig(ctx.cwd);
      agentId = config.runtime?.agentId;
      secret = process.env[config.protocol?.secretEnv ?? "FLOCKY_PROTOCOL_SECRET"];
      if (!agentId || !secret) throw new Error("runtime.agentId or protocol secret is missing");
      store = new FlockyStore(join(ctx.cwd, ".pi", "flocky", "flocky.db"));
      ctx.ui.notify(`Flocky protocol active as ${agentId}`, "info");
      void flushOutbox(ctx);
    } catch (error) {
      store?.close();
      store = undefined;
      ctx.ui.notify(`Flocky protocol inactive: ${message(error)}`, "warning");
    }
  });

  pi.on("session_shutdown", () => { store?.close(); store = undefined; });

  pi.on("input", async (event, ctx) => {
    if (!store || !config || !agentId || !secret) return;
    const parsed = parseEnvelope(event.text);
    if (!parsed) return;
    if (!verifyEnvelope(parsed, secret)) {
      ctx.ui.notify("Ignored Flocky envelope with an invalid signature", "warning");
      return;
    }
    const { fields, body } = parsed;
    if (!config.agents?.[fields.from]) {
      ctx.ui.notify(`Ignored Flocky envelope from unknown agent ${fields.from}`, "warning");
      return;
    }
    if (fields.type === "compact" && fields.from !== agentId) {
      ctx.compact({ customInstructions: "Compact at this signed request; preserve active task state and recent implementation details." });
      return { action: "handled" };
    }
    if (fields.type !== "task") return;
    if (fields.to !== agentId) {
      ctx.ui.notify(`Ignored task ${fields.task_id}: addressed to ${fields.to}`, "warning");
      return;
    }
    const inserted = store.receiveTask({
      taskId: fields.task_id,
      sender: fields.from,
      replyTo: fields.reply_to,
      answerBack: fields.answer_back === "yes",
      body,
      rawMessage: event.text,
    });
    ctx.ui.notify(inserted ? `Received Flocky task ${fields.task_id}` : `Ignored duplicate task ${fields.task_id}`, "info");
  });

  pi.on("before_agent_start", (event) => {
    if (!store) return;
    const parsed = parseEnvelope(event.prompt);
    if (parsed?.fields.type === "task") {
      activeTaskId = parsed.fields.task_id;
      latestAnswer = "";
      store.startTask(activeTaskId);
      return { systemPrompt: `${event.systemPrompt}\n\nThis is an active delegated Flocky task. Before ending, call flocky_complete exactly once with the validated terminal outcome. A successful prose answer without flocky_complete will be reported as unverified partial.` };
    } else {
      activeTaskId = undefined;
      latestAnswer = "";
    }
  });

  pi.on("message_end", (event) => {
    if (!activeTaskId || event.message.role !== "assistant") return;
    const text = textContent(event.message.content);
    if (text.trim()) latestAnswer = text.trim();
  });

  // Finalize at each low-level agent run. agent_settled waits until *all* queued
  // prompts drain, which can otherwise overwrite a prior task's active ID.
  pi.on("agent_end", async (_event, ctx) => {
    if (!store || !config || !agentId || !secret || !activeTaskId) return;
    const taskId = activeTaskId;
    activeTaskId = undefined;
    const answer = latestAnswer || "Task settled without a textual final response. Review the session transcript for details.";
    const completion = store.completionForTask(taskId)?.payload;
    const outcome = completion
      ? { status: completion.status, declared: true, reason: completion.reason }
      : { status: "partial", declared: false, reason: "Stream settled without calling flocky_complete; outcome is unverified." };
    store.settleTask(taskId, answer, outcome.status, outcome.reason);

    const task = parseEnvelope(findTaskRawMessage(ctx, taskId));
    if (!task || task.fields.answer_back !== "yes") return;
    const recipient = task.fields.from;
    const transport = transportFor(config, recipient);
    if (!transport) {
      store.failTask(taskId);
      ctx.ui.notify(`Cannot report ${taskId}: no configured route for ${recipient}`, "error");
      return;
    }
    const structured = completion ? renderCompletion(completion) : "";
    const outcomeNote = outcome.declared ? "" : `\n\nFlocky note: ${outcome.reason}`;
    const raw = answer ? `\n\nRaw assistant message:\n${answer}` : "";
    const body = `Result from stream \`${agentId}\` for task ${taskId}:\n\n${structured || answer}${outcomeNote}${structured ? raw : ""}`;
    const payload = buildEnvelope({ type: "result", task_id: taskId, from: agentId, status: outcome.status }, body, secret);
    store.enqueueResult(taskId, recipient, transport, payload);
    await flushOutbox(ctx);
    maybeCompact(ctx);
  });

  async function flushOutbox(ctx: any, signal?: AbortSignal) {
    if (!store || !config || sending) return;
    sending = true;
    try {
      for (const item of store.pendingOutbox()) {
        const delivery = await deliverWithFallback({
          item,
          config,
          send: async ({ transport, route }: any) => {
            if (transport === "herdr") return sendViaHerdr({ cwd: ctx.cwd, route, text: item.payload, signal: signal ?? ctx.signal });
            return sendAsTelegramUser({ cwd: ctx.cwd, config, target: route.target, text: item.payload, signal: signal ?? ctx.signal });
          },
          onAttempt: ({ transport, status, error }: any) => store?.recordDeliveryAttempt(item.id, transport, status, error),
        });
        if (delivery.delivered) {
          store.markSent(item.id, delivery.transport);
          ctx.ui.notify(`Delivered task ${item.task_id} to ${item.recipient} via ${delivery.transport}`, "info");
        } else {
          store.markRetry(item.id, delivery.error);
          ctx.ui.notify(`Could not deliver task ${item.task_id}: ${delivery.error}`, "error");
        }
      }
    } finally { sending = false; }
  }

  function maybeCompact(ctx: any) {
    if (!store || !config?.compaction?.enabled) return;
    const completed = store.completedTaskCount();
    const taskLimit = config.compaction.afterCompletedTasks ?? 4;
    const usage = ctx.getContextUsage?.();
    const percent = usage?.tokens && usage?.contextWindow ? (usage.tokens / usage.contextWindow) * 100 : 0;
    if (completed > 0 && (completed % taskLimit === 0 || percent >= (config.compaction.contextPercent ?? 75))) {
      ctx.compact({ customInstructions: "Preserve the current stream architecture, recent changes, validation results, and unresolved work." });
    }
  }
}

function loadConfig(cwd: string): Config {
  const path = join(cwd, "flocky.config.json");
  if (!existsSync(path)) throw new Error("missing flocky.config.json (copy flocky.config.example.json)");
  return JSON.parse(readFileSync(path, "utf8")) as Config;
}

function renderCompletion(completion: { status: string; summary: string; completed: string[]; notCompleted: string[]; validation: string[]; reason: string; safeState: string; nextAction: string }): string {
  const list = (items: string[]) => items.length ? items.map((item) => `- ${item}`).join("\n") : "- none";
  return `RESULT: ${completion.status.toUpperCase()}\nSummary: ${completion.summary}\nCompleted:\n${list(completion.completed)}\nNot completed:\n${list(completion.notCompleted)}\nValidation:\n${list(completion.validation)}\nReason: ${completion.reason || "none"}\nSafe state: ${completion.safeState}\nNext action: ${completion.nextAction}`;
}

function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((part: any) => part?.type === "text" && typeof part.text === "string").map((part: any) => part.text).join("\n");
}

function findTaskRawMessage(ctx: any, taskId: string): string {
  for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
    const message = entry.type === "message" ? entry.message : undefined;
    if (message?.role !== "user") continue;
    const text = textContent(message.content);
    const parsed = parseEnvelope(text);
    if (parsed?.fields.type === "task" && parsed.fields.task_id === taskId) return text;
  }
  return "";
}

function transportFor(config: Config, agent: string): "telegram" | "herdr" | undefined {
  const preferred = config.transport?.default ?? "telegram";
  if (routeFor(config, agent, preferred)) return preferred;
  for (const candidate of config.transport?.fallbackOrder ?? []) {
    if ((candidate === "telegram" || candidate === "herdr") && routeFor(config, agent, candidate)) return candidate;
  }
  return undefined;
}

function routeFor(config: Config, agent: string, transport: string): any {
  const route = config.agents?.[agent];
  if (transport === "telegram") {
    const target = route?.routes?.telegram?.target ?? route?.telegramTarget;
    return target ? { target } : undefined;
  }
  return transport === "herdr" ? route?.routes?.herdr : undefined;
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
