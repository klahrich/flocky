import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildEnvelope, parseEnvelope, verifyEnvelope } from "./protocol.mjs";
import { FlockyStore } from "./store.mjs";
import { sendAsTelegramUser } from "./transport.mjs";
import { sendViaHerdr } from "./herdr.mjs";
import { ensureOnboarded } from "./onboarding.mjs";
import { registerFlockyCommands } from "./commands";
import { applyAttachment, applyAttachments, planAttachment, planAttachments } from "./attachment.mjs";
import { deliverWithFallback } from "./delivery.mjs";
import { loadProjectEnv } from "./config.mjs";
import { areValidLocalTimes, normalizeLocalTimes } from "./schedule.mjs";
import { NO_TEXT_FINAL_RESPONSE, buildResultBody } from "./result.mjs";
import { ensureInlineTaskBody } from "./message.mjs";
import { classifyInboundEnvelope } from "./inbound-trust.mjs";
import { buildImplementReviewApprovalPrompt, buildReviewerTask, finalImplementReviewStatus, renderImplementReviewSummary, shouldRunImplementReview } from "./implement-review.mjs";
import { resolveDelegationPlan } from "./mixed-mode.mjs";
import { cleanupTransientHerdrRun, provisionTransientHerdrRun, shouldCleanupTransientRun, transientAgentId, transientCheckoutPath } from "./transient-herdr.mjs";

type Config = {
  project?: { id?: string };
  runtime?: { agentId?: string };
  agents?: Record<string, { telegramTarget?: string; path?: string; description?: string; routes?: { telegram?: { target?: string }; herdr?: { paneId?: string; workspaceId?: string; expectedCwd?: string; agent?: string } } }>;
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
  let flushRequested = false;

  pi.registerTool({
    name: "flocky_complete",
    label: "Flocky Complete",
    description: "Record the one structured terminal outcome for the active delegated Flocky task.",
    promptSnippet: "Record the validated structured completion of the active Flocky task",
    promptGuidelines: ["For every delegated Flocky task, call flocky_complete exactly once after work and validation; do not claim a successful Flocky outcome in prose alone.", "Answer-backs are compact by design; put long detail in repo artifacts such as files, docs, or commit history and mention only the key refs in the completion fields."],
    parameters: Type.Object({
      status: Type.String({ description: "success, partial, blocked, failed, or refused" }),
      summary: Type.String(),
      completed: Type.Array(Type.String()),
      notCompleted: Type.Array(Type.String()),
      validation: Type.Array(Type.String()),
      reason: Type.String(),
      safeState: Type.String(),
      nextAction: Type.String(),
      artifacts: Type.Optional(Type.Array(Type.String())),
    }),
    async execute(_toolCallId, params) {
      if (!store || !activeTaskId) throw new Error("flocky_complete requires an active delegated Flocky task");
      if (!["success", "partial", "blocked", "failed", "refused"].includes(params.status)) throw new Error("Invalid Flocky completion status");
      if (!params.summary.trim() || !params.safeState.trim() || !params.nextAction.trim()) throw new Error("summary, safeState, and nextAction are required");
      if (params.status === "success" && (params.validation.length === 0 || params.notCompleted.length > 0)) throw new Error("success requires validation evidence and no remaining work");
      const completion = { ...params, artifacts: params.artifacts ?? [], status: params.status as "success" | "partial" | "blocked" | "failed" | "refused" };
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
        lines.push(`Transient runs: ${summary.transientRunCounts.map((row: any) => `${row.status}=${row.count}`).join(", ") || "none"}`);
        if (summary.recentTransientRuns?.length) lines.push(`Recent transient: ${summary.recentTransientRuns.map((run: any) => `${run.run_id}:${run.workflow_role ?? "single"}:${run.status}/${run.cleanup_state}`).join(", ")}`);
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
      const localTimes = normalizeLocalTimes(params.localTimes);
      if (!areValidLocalTimes(localTimes)) throw new Error("localTimes must use HH:mm");
      const taskName = `Flocky_${config.project?.id}_${params.job}`;
      const args = ["-ExecutionPolicy", "Bypass", "-File", join(ctx.cwd, "tools", "install-windows-flocky-schedule.ps1"), "-TaskName", taskName, "-ProjectPath", ctx.cwd, "-JobId", params.job, "-AtLocalTime", ...localTimes];
      if (!params.confirm) return { content: [{ type: "text", text: `Preview: ${taskName} will run ${params.job} daily at local times ${localTimes.join(", ")}. Confirm to install.` }], details: { taskName, args } };
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
      const task = ensureInlineTaskBody(params.task);
      const transport = params.transport ?? transportFor(config, params.recipient);
      if (transport !== "telegram") throw new Error("Scheduled jobs currently support telegram only; keep detailed context in repo artifacts and send a compact inline task.");
      if (!routeFor(config, params.recipient, transport)) throw new Error(`No ${transport} route is configured for ${params.recipient}`);
      const job = { id: params.id, recipient: params.recipient, task, cron: params.cron.trim(), timezone: params.timezone ?? "America/Toronto", answerBack: params.answerBack ?? true, transport, concurrencyKey: params.concurrencyKey ?? params.recipient, missedRunPolicy: params.missedRunPolicy ?? "skip", actionPolicy: "internal_task", enabled: true };
      store.saveScheduledJob(job);
      return { content: [{ type: "text", text: `Created schedule ${job.id}: ${job.cron} (${job.timezone}) → ${job.recipient} via ${job.transport}. Install its Windows trigger on the scheduler host before it can run.` }], details: job };
    },
  });

  pi.registerTool({
    name: "flocky_dispatch",
    label: "Flocky Dispatch",
    description: "Dispatch a signed durable task from the project owner to one configured stream agent.",
    promptSnippet: "Dispatch a task to a configured Flocky stream agent",
    promptGuidelines: ["Use flocky_dispatch to delegate repository work to a configured Flocky stream; do not manually compose Flocky envelopes.", "For a simple quoted user-to-stream message, pass exactly the quoted message as task text; do not ask the stream to resend it.", "Keep inline task text compact. Put longer specifications in repo artifacts such as files, docs, or commit history, then dispatch a concise task that references them."],
    parameters: Type.Object({
      stream: Type.String({ description: "Configured stream ID" }),
      task: Type.String({ description: "Complete task instructions and acceptance criteria" }),
      answerBack: Type.Optional(Type.Boolean({ description: "Whether the stream must report its final result to the owner; defaults to true" })),
      transport: Type.Optional(Type.String({ description: "Optional configured transport override: herdr or telegram" })),
      taskId: Type.Optional(Type.String({ description: "Reuse a prior task ID only to retry the exact same dispatch" })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (!store || !config || !agentId || !secret) throw new Error("Flocky is not configured; complete onboarding first");
      const body = ensureInlineTaskBody(params.task);
      const receipt = await executeDurableDispatch({
        ctx,
        signal,
        store,
        config,
        ownerAgentId: agentId,
        secret,
        streamId: params.stream,
        task: body,
        answerBack: params.answerBack ?? true,
        transport: params.transport,
        taskId: params.taskId,
      });
      return {
        content: [{ type: "text", text: `Task ${receipt.taskId} dispatched to ${params.stream} via ${receipt.transport} (${receipt.deliveryStatus}).` }],
        details: receipt,
      };
    },
  });

  pi.registerTool({
    name: "flocky_delegate",
    label: "Flocky Delegate",
    description: "Choose durable or transient execution for one repository task using one owner-facing tool.",
    promptSnippet: "Choose durable or transient Flocky execution for one repository task",
    promptGuidelines: ["Use flocky_delegate as the default mixed-mode owner tool when choosing between durable and transient execution. If transient implement-review is selected, preview it first so the user can approve or switch to durable."],
    parameters: Type.Object({
      stream: Type.String({ description: "Configured stream/repository ID" }),
      task: Type.String({ description: "Complete task instructions and acceptance criteria" }),
      mode: Type.Optional(Type.String({ description: "auto, durable, or transient" })),
      workflow: Type.Optional(Type.String({ description: "single or implement-review" })),
      cleanup: Type.Optional(Type.String({ description: "preserve, cleanup-on-success, or always-cleanup for transient runs" })),
      transport: Type.Optional(Type.String({ description: "Optional durable transport override: herdr or telegram" })),
      confirm: Type.Optional(Type.Boolean({ description: "Required to proceed when transient implement-review was previewed and approved by the user" })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (!store || !config || !agentId || !secret) throw new Error("Flocky is not configured; complete onboarding first");
      const body = ensureInlineTaskBody(params.task);
      const plan = resolveDelegationPlan({ mode: params.mode, workflow: params.workflow });

      if (plan.tool === "flocky_dispatch") {
        const receipt = await executeDurableDispatch({
          ctx,
          signal,
          store,
          config,
          ownerAgentId: agentId,
          secret,
          streamId: params.stream,
          task: body,
          answerBack: true,
          transport: params.transport,
        });
        return {
          content: [{ type: "text", text: `Delegated via durable ${params.stream} agent (${receipt.transport}, ${receipt.deliveryStatus}).` }],
          details: { mode: "durable", workflow: "single", ...receipt },
        };
      }

      if (plan.tool === "flocky_transient_dispatch") {
        validateTransientDispatchContext(config, agentId, params.stream);
        const cleanupPolicy = validateCleanupPolicy(params.cleanup);
        const receipt = await executeTransientDispatch({ ctx, signal, store, config, ownerAgentId: agentId, secret, streamId: params.stream, task: body, cleanupPolicy });
        return {
          content: [{ type: "text", text: `Delegated via transient worker ${receipt.agentId} for ${params.stream}.` }],
          details: { mode: "transient", workflow: "single", ...receipt },
        };
      }

      validateTransientDispatchContext(config, agentId, params.stream);
      const cleanupPolicy = validateCleanupPolicy(params.cleanup);
      const outcome = await executeTransientImplementReview({
        ctx,
        signal,
        store,
        config,
        ownerAgentId: agentId,
        secret,
        streamId: params.stream,
        task: body,
        cleanupPolicy,
        confirm: params.confirm,
      });
      if (!outcome.approved) {
        return {
          content: [{ type: "text", text: `${outcome.preview} After approval, call flocky_delegate again with workflow=implement-review and confirm=true. To switch, call flocky_delegate with mode=durable.` }],
          details: { mode: "transient", workflow: "implement-review", approved: false, stream: params.stream, cleanupPolicy, preview: outcome.preview },
        };
      }
      return {
        content: [{ type: "text", text: `Delegated via transient implement-review workflow ${outcome.workflowId} for ${params.stream}.` }],
        details: { mode: "transient", workflow: "implement-review", ...outcome },
      };
    },
  });

  pi.registerTool({
    name: "flocky_transient_dispatch",
    label: "Flocky Transient Dispatch",
    description: "Spawn a one-off transient Herdr Pi worker for one signed delegated coding task.",
    promptSnippet: "Spawn a transient Herdr worker for one repository task",
    promptGuidelines: ["Use flocky_transient_dispatch when the user explicitly wants transient execution rather than a durable stream conversation."],
    parameters: Type.Object({
      stream: Type.String({ description: "Configured stream/repository ID" }),
      task: Type.String({ description: "Complete task instructions and acceptance criteria" }),
      cleanup: Type.Optional(Type.String({ description: "preserve, cleanup-on-success, or always-cleanup" })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (!store || !config || !agentId || !secret) throw new Error("Flocky is not configured; complete onboarding first");
      validateTransientDispatchContext(config, agentId, params.stream);
      const cleanupPolicy = validateCleanupPolicy(params.cleanup);
      const body = params.task.trim();
      if (!body) throw new Error("Task instructions cannot be empty");
      const receipt = await executeTransientDispatch({ ctx, signal, store, config, ownerAgentId: agentId, secret, streamId: params.stream, task: body, cleanupPolicy });
      return {
        content: [{ type: "text", text: `Transient task ${receipt.taskId} dispatched to ${receipt.agentId} for ${params.stream} via Herdr.` }],
        details: receipt,
      };
    },
  });

  pi.registerTool({
    name: "flocky_transient_implement_review",
    label: "Flocky Transient Implement Review",
    description: "Preview or run a transient implementer worker followed by a transient reviewer/tester worker on the same checkout.",
    promptSnippet: "Preview or run a transient implement-review workflow for one repository task",
    promptGuidelines: ["Before using flocky_transient_implement_review for coding work, first preview it to the user and get explicit approval, with a clear option to switch to the durable stream instead."],
    parameters: Type.Object({
      stream: Type.String({ description: "Configured stream/repository ID" }),
      task: Type.String({ description: "Complete task instructions and acceptance criteria" }),
      cleanup: Type.Optional(Type.String({ description: "preserve, cleanup-on-success, or always-cleanup" })),
      confirm: Type.Optional(Type.Boolean({ description: "Set true only after the user approves transient implement-review for this coding task" })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (!store || !config || !agentId || !secret) throw new Error("Flocky is not configured; complete onboarding first");
      validateTransientDispatchContext(config, agentId, params.stream);
      const cleanupPolicy = validateCleanupPolicy(params.cleanup);
      const body = params.task.trim();
      if (!body) throw new Error("Task instructions cannot be empty");
      const outcome = await executeTransientImplementReview({
        ctx,
        signal,
        store,
        config,
        ownerAgentId: agentId,
        secret,
        streamId: params.stream,
        task: body,
        cleanupPolicy,
        confirm: params.confirm,
      });
      if (!outcome.approved) {
        return {
          content: [{ type: "text", text: `${outcome.preview} After the user approves, call flocky_transient_implement_review again with confirm=true. If they want ongoing back-and-forth instead, use the durable stream.` }],
          details: { approved: false, stream: params.stream, cleanupPolicy, preview: outcome.preview },
        };
      }
      return {
        content: [{ type: "text", text: `Transient implement-review workflow ${outcome.workflowId} started for ${params.stream}; implementer task ${outcome.taskId} is running.` }],
        details: outcome,
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

  pi.registerTool({
    name: "flocky_attach_streams",
    label: "Attach Flocky Streams",
    description: "Preview or attach Flocky-managed files for multiple registered stream repositories at once.",
    promptSnippet: "Preview or attach multiple registered stream repositories to Flocky at once",
    promptGuidelines: ["Use flocky_attach_streams when the user wants to refresh or attach several configured streams in one project-level action."],
    parameters: Type.Object({
      streams: Type.Optional(Type.Array(Type.String({ description: "Registered stream ID" }))),
      confirm: Type.Boolean({ description: "False returns the exact multi-stream change plan; true applies that reviewed plan" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!config || !agentId) throw new Error("Flocky is not configured; complete onboarding first");
      if (agentId !== config.project?.id) throw new Error("Only the project-owner agent can attach streams");
      const review = planAttachments({ ownerCwd: ctx.cwd, config, streamIds: params.streams ?? [] });
      const planText = renderAttachmentReview(review);
      if (!params.confirm) {
        return { content: [{ type: "text", text: `Attachment plan for ${review.plans.length} stream(s):\n${planText}\n\nReview this plan, then call flocky_attach_streams with confirm=true.` }], details: { streamIds: review.streamIds, plans: review.plans.map((plan: any) => ({ stream: plan.streamId, actions: plan.actions })), errors: review.errors, applied: false } };
      }
      if (review.errors.length) throw new Error(`Cannot attach streams:\n${planText}`);
      const applied = applyAttachments({ ownerCwd: ctx.cwd, config, streamIds: params.streams ?? [] });
      return { content: [{ type: "text", text: `Attached ${applied.length} stream(s): ${applied.map((plan: any) => plan.streamId).join(", ")}. Start/reload Pi in those repositories to activate the update.` }], details: { streamIds: applied.map((plan: any) => plan.streamId), plans: applied.map((plan: any) => ({ stream: plan.streamId, actions: plan.actions })), errors: [], applied: true } };
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
      return { action: "handled" };
    }
    const { fields, body } = parsed;
    const trusted = classifyInboundEnvelope({ parsed, config, store });
    if (!trusted.trusted) {
      ctx.ui.notify(`Ignored Flocky envelope from untrusted sender ${fields.from}: ${trusted.reason}`, "warning");
      return { action: "handled" };
    }
    if (fields.type === "compact" && fields.from !== agentId) {
      ctx.compact({ customInstructions: "Compact at this signed request; preserve active task state and recent implementation details." });
      return { action: "handled" };
    }
    if (fields.type === "result") {
      if (trusted.kind === "transient") return await handleTransientInboundResult({ ctx, store, config, ownerAgentId: agentId, secret, run: trusted.run, resultStatus: fields.status, resultBody: body });
      return;
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
    const ownerInstructions = config && agentId === config.project?.id ? configuredStreamInstructions(config) : "";
    const parsed = parseEnvelope(event.prompt);
    if (parsed?.fields.type === "task" && secret && verifyEnvelope(parsed, secret) && config && classifyInboundEnvelope({ parsed, config, store }).trusted) {
      activeTaskId = parsed.fields.task_id;
      latestAnswer = "";
      return { systemPrompt: `${event.systemPrompt}${ownerInstructions}\n\nThis is an active delegated Flocky task. Before ending, call flocky_complete exactly once with the validated terminal outcome. Keep any answer-back compact and put long detail in repo artifacts such as files, docs, or commit history. A successful prose answer without flocky_complete will be reported as unverified partial.` };
    } else {
      activeTaskId = undefined;
      latestAnswer = "";
      return ownerInstructions ? { systemPrompt: `${event.systemPrompt}${ownerInstructions}` } : undefined;
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
    const answer = latestAnswer || NO_TEXT_FINAL_RESPONSE;
    const completion = store.completionForTask(taskId)?.payload;
    const outcome = completion
      ? { status: completion.status, declared: true, reason: completion.reason }
      : { status: "partial", declared: false, reason: "Stream settled without calling flocky_complete; outcome is unverified." };
    store.settleTask(taskId, answer, outcome.status, outcome.reason);

    const task = store.task(taskId);
    if (!task || !task.answer_back) return;
    const recipient = task.sender;
    const transport = transportFor(config, recipient);
    if (!transport) {
      store.failTask(taskId);
      ctx.ui.notify(`Cannot report ${taskId}: no configured route for ${recipient}`, "error");
      return;
    }
    const body = buildResultBody({ agentId, taskId, answer, completion, outcome });
    const payload = buildEnvelope({ type: "result", task_id: taskId, from: agentId, status: outcome.status }, body, secret);
    store.enqueueResult(taskId, recipient, transport, payload);
    await flushOutbox(ctx);
    maybeCompact(ctx);
  });

  async function flushOutbox(ctx: any, signal?: AbortSignal) {
    if (!store || !config) return;
    if (sending) { flushRequested = true; return; }
    sending = true;
    try {
      do {
        flushRequested = false;
        await flushOutboxForDispatch({ ctx, signal, store, config });
      } while (flushRequested);
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

async function handleTransientInboundResult({ ctx, store, config, ownerAgentId, secret, run, resultStatus, resultBody }: { ctx: any; store: FlockyStore; config: Config; ownerAgentId: string; secret: string; run: any; resultStatus: string; resultBody: string }) {
  store.markTransientRunSettled(run.run_id, resultStatus, resultBody);
  const settledRun = store.transientRun(run.run_id) ?? { ...run, status: "settled", result_status: resultStatus, result_body: resultBody };
  if (settledRun.workflow_kind === "implement-review") {
    return await handleImplementReviewInboundResult({ ctx, store, config, ownerAgentId, secret, run: settledRun });
  }
  await settlePlainTransientRun(ctx, store, settledRun, resultStatus);
  return;
}

async function handleImplementReviewInboundResult({ ctx, store, config, ownerAgentId, secret, run }: { ctx: any; store: FlockyStore; config: Config; ownerAgentId: string; secret: string; run: any }) {
  const workflowRuns = store.transientRunsForWorkflow(run.workflow_id);
  const implementer = workflowRuns.find((candidate: any) => candidate.workflow_role === "implementer") ?? (run.workflow_role === "implementer" ? run : null);
  const reviewer = workflowRuns.find((candidate: any) => candidate.workflow_role === "reviewer") ?? (run.workflow_role === "reviewer" ? run : null);
  if (!implementer) return;

  if (run.workflow_role === "implementer") {
    if (!shouldRunImplementReview(run.result_status)) {
      return await finalizeImplementReviewWorkflow({ ctx, store, implementer, reviewer: null });
    }
    try {
      await cleanupTransientHerdrRun({ ownerCwd: ctx.cwd, run, removeCheckout: false });
      store.markTransientRunCleaned(run.run_id, "workspace_closed");
    } catch (error) {
      store.markTransientRunCleaned(run.run_id, "workspace_close_failed", message(error));
      ctx.ui.notify(`Could not close implementer workspace for ${run.run_id}: ${message(error)}`, "warning");
    }

    const originalTask = store.dispatchForTask(run.task_id)?.body ?? "";
    const reviewerTask = buildReviewerTask({
      originalTask,
      implementerTaskId: run.task_id,
      implementerStatus: run.result_status,
      implementerReport: run.result_body,
    });
    try {
      const reviewerReceipt = await spawnTransientRun({
        ctx,
        store,
        config,
        ownerAgentId,
        secret,
        streamId: run.stream_id,
        task: reviewerTask,
        cleanupPolicy: run.cleanup_policy,
        workflowId: run.workflow_id,
        workflowKind: "implement-review",
        workflowRole: "reviewer",
        parentTaskId: run.task_id,
        checkoutPath: run.checkout_path,
        signal: ctx.signal,
      });
      ctx.ui.notify(`Started transient reviewer ${reviewerReceipt.agentId} for workflow ${run.workflow_id}.`, "info");
      return { action: "handled" };
    } catch (error: any) {
      const reviewerRun = error?.flockyRunId ? store.transientRun(error.flockyRunId) : null;
      return await finalizeImplementReviewWorkflow({ ctx, store, implementer: store.transientRun(implementer.run_id) ?? implementer, reviewer: reviewerRun, reviewerLaunchError: message(error) });
    }
  }

  return await finalizeImplementReviewWorkflow({ ctx, store, implementer, reviewer: run });
}

async function finalizeImplementReviewWorkflow({ ctx, store, implementer, reviewer, reviewerLaunchError }: { ctx: any; store: FlockyStore; implementer: any; reviewer: any; reviewerLaunchError?: string }) {
  const finalStatus = finalImplementReviewStatus({
    implementerStatus: implementer?.result_status,
    reviewerStatus: reviewer?.result_status,
    reviewerLaunchError,
  });
  const cleanupCarrier = reviewer ?? implementer;
  if (cleanupCarrier && shouldCleanupTransientRun(cleanupCarrier.cleanup_policy, finalStatus)) {
    try {
      await cleanupTransientHerdrRun({ ownerCwd: ctx.cwd, run: cleanupCarrier });
      store.markTransientRunCleaned(cleanupCarrier.run_id, "cleaned");
    } catch (error) {
      store.markTransientRunCleaned(cleanupCarrier.run_id, "cleanup_failed", message(error));
      ctx.ui.notify(`Could not clean workflow ${cleanupCarrier.workflow_id ?? cleanupCarrier.run_id}: ${message(error)}`, "error");
    }
  } else if (cleanupCarrier) {
    store.markTransientRunCleaned(cleanupCarrier.run_id, "preserved");
  }
  const summary = renderImplementReviewSummary({
    workflowId: implementer?.workflow_id ?? reviewer?.workflow_id ?? "unknown",
    streamId: implementer?.stream_id ?? reviewer?.stream_id ?? "unknown",
    implementer,
    reviewer,
    reviewerLaunchError,
  });
  return { action: "transform", text: `A transient implement-review workflow has completed. Review the combined report below and respond to the user with a concise synthesis.\n\n${summary}` };
}

async function settlePlainTransientRun(ctx: any, store: FlockyStore, run: any, resultStatus: string) {
  if (shouldCleanupTransientRun(run.cleanup_policy, resultStatus)) {
    try {
      await cleanupTransientHerdrRun({ ownerCwd: ctx.cwd, run });
      store.markTransientRunCleaned(run.run_id, "cleaned");
      ctx.ui.notify(`Cleaned transient run ${run.run_id} after ${resultStatus} result.`, "info");
    } catch (error) {
      store.markTransientRunCleaned(run.run_id, "cleanup_failed", message(error));
      ctx.ui.notify(`Could not clean transient run ${run.run_id}: ${message(error)}`, "error");
    }
  } else {
    store.markTransientRunCleaned(run.run_id, "preserved");
  }
}

async function executeDurableDispatch({ ctx, signal, store, config, ownerAgentId, secret, streamId, task, answerBack, transport, taskId }: { ctx: any; signal?: AbortSignal; store: FlockyStore; config: Config; ownerAgentId: string; secret: string; streamId: string; task: string; answerBack: boolean; transport?: string; taskId?: string }) {
  if (ownerAgentId !== config.project?.id) throw new Error("Only the project-owner agent can dispatch Flocky tasks");
  if (!config.agents?.[streamId] || streamId === ownerAgentId) throw new Error(`Unknown stream: ${streamId}`);
  const selectedTransport = transport ?? transportFor(config, streamId);
  if (selectedTransport !== "telegram" && selectedTransport !== "herdr") throw new Error("Transport must be herdr or telegram");
  if (!routeFor(config, streamId, selectedTransport)) throw new Error(`No ${selectedTransport} route is configured for ${streamId}`);
  const durableTaskId = taskId ?? randomUUID();
  const body = ensureInlineTaskBody(task);
  const payload = buildEnvelope({ type: "task", task_id: durableTaskId, from: ownerAgentId, to: streamId, reply_to: ownerAgentId, answer_back: answerBack ? "yes" : "no" }, body, secret);
  const prior = store.dispatchForTask(durableTaskId);
  if (prior && prior.payload !== payload) throw new Error(`Task ID ${durableTaskId} already belongs to a different dispatch`);
  store.recordDispatch(durableTaskId, streamId, selectedTransport, body, payload);
  store.enqueueResult(durableTaskId, streamId, selectedTransport, payload);
  await flushOutboxForDispatch({ ctx, signal, store, config });
  const outbox = store.outboxForTask(durableTaskId);
  return { taskId: durableTaskId, stream: streamId, transport: selectedTransport, deliveryStatus: outbox?.status ?? "pending" };
}

async function executeTransientDispatch({ ctx, signal, store, config, ownerAgentId, secret, streamId, task, cleanupPolicy, workflowId, workflowKind, workflowRole, parentTaskId, checkoutPath }: { ctx: any; signal?: AbortSignal; store: FlockyStore; config: Config; ownerAgentId: string; secret: string; streamId: string; task: string; cleanupPolicy: string; workflowId?: string; workflowKind?: string; workflowRole?: string; parentTaskId?: string; checkoutPath?: string }) {
  try {
    return await spawnTransientRun({ ctx, store, config, ownerAgentId, secret, streamId, task, cleanupPolicy, workflowId, workflowKind, workflowRole, parentTaskId, checkoutPath, signal });
  } catch (error: any) {
    await maybeCleanupFailedTransientRun(ctx.cwd, store, error?.flockyRunId, cleanupPolicy, error);
    throw error;
  }
}

async function executeTransientImplementReview({ ctx, signal, store, config, ownerAgentId, secret, streamId, task, cleanupPolicy, confirm }: { ctx: any; signal?: AbortSignal; store: FlockyStore; config: Config; ownerAgentId: string; secret: string; streamId: string; task: string; cleanupPolicy: string; confirm?: boolean }) {
  if (!confirm) return { approved: false, preview: buildImplementReviewApprovalPrompt({ streamId }) };
  const workflowId = randomUUID();
  const receipt = await executeTransientDispatch({
    ctx,
    signal,
    store,
    config,
    ownerAgentId,
    secret,
    streamId,
    task,
    cleanupPolicy,
    workflowId,
    workflowKind: "implement-review",
    workflowRole: "implementer",
  });
  return { approved: true, workflowId, ...receipt };
}

async function spawnTransientRun({ ctx, store, config, ownerAgentId, secret, streamId, task, cleanupPolicy, workflowId, workflowKind, workflowRole, parentTaskId, checkoutPath, signal }: { ctx: any; store: FlockyStore; config: Config; ownerAgentId: string; secret: string; streamId: string; task: string; cleanupPolicy: string; workflowId?: string; workflowKind?: string; workflowRole?: string; parentTaskId?: string; checkoutPath?: string; signal?: AbortSignal }) {
  const stream = config.agents?.[streamId];
  if (!stream?.path) throw new Error(`Stream ${streamId} has no repository path`);
  const taskId = randomUUID();
  const runId = randomUUID();
  const agentId = transientAgentId(runId);
  const sourceRepoPath = resolve(ctx.cwd, stream.path);
  const transientCheckout = checkoutPath ? resolve(checkoutPath) : transientCheckoutPath(ctx.cwd, runId);
  store.registerTransientRun({
    runId,
    taskId,
    parentTaskId,
    workflowId,
    workflowKind,
    workflowRole,
    agentId,
    streamId,
    sourceRepoPath,
    checkoutPath: transientCheckout,
    backend: "herdr",
    cleanupPolicy,
    status: "provisioning",
  });
  try {
    const provisioned = await provisionTransientHerdrRun({ ownerCwd: ctx.cwd, config, streamId, ownerAgentId, cleanupPolicy, runId, agentId, protocolSecret: secret, checkoutPath });
    store.markTransientRunReady(runId, { workspaceId: provisioned.workspaceId, paneId: provisioned.paneId, checkoutPath: provisioned.checkoutPath });
    const payload = buildEnvelope({ type: "task", task_id: taskId, from: ownerAgentId, to: agentId, reply_to: ownerAgentId, answer_back: "yes" }, task, secret);
    store.recordDispatch(taskId, agentId, "herdr", task, payload);
    await sendViaHerdr({ cwd: ctx.cwd, route: provisioned.route, text: payload, signal });
    store.markTransientRunDispatched(runId, { workspaceId: provisioned.workspaceId, paneId: provisioned.paneId });
    return { taskId, runId, agentId, stream: streamId, backend: "herdr", cleanupPolicy, workspaceId: provisioned.workspaceId, paneId: provisioned.paneId, checkoutPath: provisioned.checkoutPath, workflowId, workflowKind, workflowRole };
  } catch (error) {
    store.markTransientRunFailed(runId, message(error));
    const wrapped = error instanceof Error ? error : new Error(String(error));
    (wrapped as any).flockyRunId = runId;
    throw wrapped;
  }
}

async function maybeCleanupFailedTransientRun(ownerCwd: string, store: FlockyStore, runId: string | undefined, cleanupPolicy: string, failure: unknown) {
  if (cleanupPolicy !== "always-cleanup" || !runId) return;
  const run = store.transientRun(runId);
  if (!run) return;
  try {
    await cleanupTransientHerdrRun({ ownerCwd, run });
    store.markTransientRunCleaned(runId, "cleaned");
  } catch (cleanupError) {
    store.markTransientRunCleaned(runId, "cleanup_failed", `${message(failure)}; cleanup: ${message(cleanupError)}`);
  }
}

async function flushOutboxForDispatch({ ctx, signal, store, config }: { ctx: any; signal?: AbortSignal; store: FlockyStore; config: Config }) {
  for (const item of store.pendingOutbox()) {
    const delivery = await deliverWithFallback({
      item,
      config,
      send: async ({ transport, route }: any) => {
        if (transport === "herdr") return sendViaHerdr({ cwd: ctx.cwd, route, text: item.payload, signal: signal ?? ctx.signal });
        return sendAsTelegramUser({ cwd: ctx.cwd, config, target: route.target, text: item.payload, signal: signal ?? ctx.signal });
      },
      onAttempt: ({ transport, status, error }: any) => store.recordDeliveryAttempt(item.id, transport, status, error),
    });
    if (delivery.delivered) {
      store.markSent(item.id, delivery.transport);
      ctx.ui.notify(`Delivered task ${item.task_id} to ${item.recipient} via ${delivery.transport}`, "info");
    } else {
      store.markRetry(item.id, delivery.error);
      ctx.ui.notify(`Could not deliver task ${item.task_id}: ${delivery.error}`, "error");
    }
  }
}

function validateTransientDispatchContext(config: Config, ownerAgentId: string | undefined, streamId: string) {
  if (ownerAgentId !== config.project?.id) throw new Error("Only the project-owner agent can dispatch transient Flocky tasks");
  if (process.env.HERDR_ENV !== "1") throw new Error("Transient Herdr dispatch requires the owner Pi session to run inside Herdr");
  if (!config.agents?.[streamId] || streamId === ownerAgentId) throw new Error(`Unknown stream: ${streamId}`);
  if (!config.agents?.[ownerAgentId ?? ""]?.routes?.herdr?.paneId) throw new Error("The project owner needs a configured Herdr route before transient workers can report back");
}

function validateCleanupPolicy(cleanup: string | undefined) {
  const cleanupPolicy = cleanup ?? "cleanup-on-success";
  if (!["preserve", "cleanup-on-success", "always-cleanup"].includes(cleanupPolicy)) throw new Error("cleanup must be preserve, cleanup-on-success, or always-cleanup");
  return cleanupPolicy;
}

function loadConfig(cwd: string): Config {
  const path = join(cwd, "flocky.config.json");
  if (!existsSync(path)) throw new Error("missing flocky.config.json (copy flocky.config.example.json)");
  return JSON.parse(readFileSync(path, "utf8")) as Config;
}

function renderAttachmentReview(review: { plans: any[]; errors: Array<{ streamId: string; error: string }> }) {
  const sections = review.plans.map((plan: any) => `${plan.streamId}:\n${plan.actions.map((item: any) => `- ${item.action}: ${item.path}`).join("\n")}`);
  if (review.errors.length) sections.push(`Errors:\n${review.errors.map(({ streamId, error }) => `- ${streamId}: ${error}`).join("\n")}`);
  return sections.join("\n\n");
}

function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((part: any) => part?.type === "text" && typeof part.text === "string").map((part: any) => part.text).join("\n");
}

function transportFor(config: Config, agent: string): "telegram" | "herdr" | undefined {
  const preferred = config.transport?.default ?? "telegram";
  if (routeFor(config, agent, preferred)) return preferred;
  for (const candidate of config.transport?.fallbackOrder ?? []) {
    if ((candidate === "telegram" || candidate === "herdr") && routeFor(config, agent, candidate)) return candidate;
  }
  return undefined;
}

function configuredStreamInstructions(config: Config): string {
  const ownerId = config.project?.id;
  const streams = Object.entries(config.agents ?? {}).filter(([id]) => id !== ownerId);
  if (!streams.length) return "";
  const list = streams.map(([id, stream]) => `- ${id}${stream.description ? `: ${stream.description}` : ""}`).join("\n");
  return `\n\nConfigured Flocky streams:\n${list}\n\nWhen the user addresses one of these stream IDs (for example, “send hi to stream-a”), use flocky_dispatch for a direct durable task or flocky_delegate for repository work. For a simple quoted message, dispatch only the quoted text (task: hi), not an instruction for the stream to resend it. Do not use the Telegram skill or manually compose an envelope for a configured stream; Flocky chooses its configured transport.`;
}

function routeFor(config: Config, agent: string, transport: string | undefined): any {
  const route = config.agents?.[agent];
  if (transport === "telegram") {
    const target = route?.routes?.telegram?.target ?? route?.telegramTarget;
    return target ? { target } : undefined;
  }
  return transport === "herdr" ? route?.routes?.herdr : undefined;
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
