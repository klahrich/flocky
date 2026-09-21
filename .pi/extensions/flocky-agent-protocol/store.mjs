import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const ACTIVE_TRANSIENT_STATUSES = ["provisioning", "ready", "dispatched", "running"];

export class FlockyStore {
  constructor(file) {
    mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS tasks (
        task_id TEXT PRIMARY KEY,
        sender TEXT NOT NULL,
        reply_to TEXT NOT NULL,
        answer_back INTEGER NOT NULL,
        body TEXT NOT NULL,
        raw_message TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        final_answer TEXT,
        outcome_status TEXT,
        outcome_reason TEXT
      ) STRICT;
      CREATE TABLE IF NOT EXISTS completions (
        task_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS scheduled_jobs (
        job_id TEXT PRIMARY KEY,
        definition TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS scheduled_runs (
        occurrence_key TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        task_id TEXT,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        error TEXT
      ) STRICT;
      CREATE TABLE IF NOT EXISTS delivery_attempts (
        id INTEGER PRIMARY KEY,
        outbox_id INTEGER NOT NULL,
        transport TEXT NOT NULL,
        status TEXT NOT NULL,
        error TEXT,
        attempted_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS dispatches (
        task_id TEXT PRIMARY KEY,
        recipient TEXT NOT NULL,
        transport TEXT NOT NULL,
        body TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS outbox (
        id INTEGER PRIMARY KEY,
        task_id TEXT NOT NULL UNIQUE,
        recipient TEXT NOT NULL,
        transport TEXT NOT NULL DEFAULT 'telegram',
        payload TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        delivered_transport TEXT,
        created_at INTEGER NOT NULL,
        sent_at INTEGER
      ) STRICT;
      CREATE TABLE IF NOT EXISTS transient_runs (
        run_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        parent_task_id TEXT,
        workflow_id TEXT,
        workflow_kind TEXT,
        workflow_role TEXT,
        agent_id TEXT NOT NULL UNIQUE,
        stream_id TEXT NOT NULL,
        source_repo_path TEXT NOT NULL,
        checkout_path TEXT NOT NULL,
        backend TEXT NOT NULL,
        workspace_id TEXT,
        pane_id TEXT,
        status TEXT NOT NULL,
        cleanup_policy TEXT NOT NULL,
        cleanup_state TEXT NOT NULL,
        result_status TEXT,
        result_body TEXT,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
    `);
    try { this.db.exec("ALTER TABLE outbox ADD COLUMN transport TEXT NOT NULL DEFAULT 'telegram'"); } catch { /* Existing databases already have the column. */ }
    try { this.db.exec("ALTER TABLE tasks ADD COLUMN outcome_status TEXT"); } catch { /* Existing databases already have the column. */ }
    try { this.db.exec("ALTER TABLE tasks ADD COLUMN outcome_reason TEXT"); } catch { /* Existing databases already have the column. */ }
    try { this.db.exec("ALTER TABLE outbox ADD COLUMN delivered_transport TEXT"); } catch { /* Existing databases already have the column. */ }
    try { this.db.exec("ALTER TABLE transient_runs ADD COLUMN workflow_kind TEXT"); } catch { /* Existing databases already have the column. */ }
    try { this.db.exec("ALTER TABLE transient_runs ADD COLUMN workflow_role TEXT"); } catch { /* Existing databases already have the column. */ }
    try { this.db.exec("ALTER TABLE transient_runs ADD COLUMN result_body TEXT"); } catch { /* Existing databases already have the column. */ }
  }

  saveScheduledJob(job) {
    const now = Date.now();
    this.db.prepare("INSERT INTO scheduled_jobs (job_id, definition, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(job_id) DO UPDATE SET definition = excluded.definition, enabled = excluded.enabled, updated_at = excluded.updated_at")
      .run(job.id, JSON.stringify(job), job.enabled === false ? 0 : 1, now, now);
  }

  scheduledJob(jobId) {
    const row = this.db.prepare("SELECT * FROM scheduled_jobs WHERE job_id = ?").get(jobId);
    return row ? { ...row, definition: JSON.parse(row.definition) } : null;
  }

  scheduledJobs() {
    return this.db.prepare("SELECT * FROM scheduled_jobs ORDER BY job_id").all().map((row) => ({ ...row, definition: JSON.parse(row.definition) }));
  }

  setScheduledJobEnabled(jobId, enabled) {
    return this.db.prepare("UPDATE scheduled_jobs SET enabled = ?, updated_at = ? WHERE job_id = ?").run(enabled ? 1 : 0, Date.now(), jobId).changes === 1;
  }

  claimScheduledRun(occurrenceKey, jobId, taskId) {
    const now = Date.now();
    return this.db.prepare("INSERT INTO scheduled_runs (occurrence_key, job_id, task_id, status, created_at, updated_at) VALUES (?, ?, ?, 'claimed', ?, ?) ON CONFLICT(occurrence_key) DO NOTHING")
      .run(occurrenceKey, jobId, taskId, now, now).changes === 1;
  }

  receiveTask({ taskId, sender, replyTo, answerBack, body, rawMessage }) {
    const now = Date.now();
    const result = this.db.prepare(`
      INSERT INTO tasks (task_id, sender, reply_to, answer_back, body, raw_message, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'received', ?, ?)
      ON CONFLICT(task_id) DO NOTHING
    `).run(taskId, sender, replyTo, answerBack ? 1 : 0, body, rawMessage, now, now);
    return result.changes === 1;
  }

  startTask(taskId) {
    this.db.prepare("UPDATE tasks SET status = 'running', updated_at = ? WHERE task_id = ? AND status = 'received'")
      .run(Date.now(), taskId);
  }

  settleTask(taskId, finalAnswer, outcomeStatus = "partial", outcomeReason = "") {
    this.db.prepare("UPDATE tasks SET status = 'settled', final_answer = ?, outcome_status = ?, outcome_reason = ?, updated_at = ? WHERE task_id = ?")
      .run(finalAnswer, outcomeStatus, outcomeReason, Date.now(), taskId);
  }

  failTask(taskId) {
    this.db.prepare("UPDATE tasks SET status = 'failed', updated_at = ? WHERE task_id = ?")
      .run(Date.now(), taskId);
  }

  task(taskId) {
    return this.db.prepare("SELECT * FROM tasks WHERE task_id = ?").get(taskId);
  }

  dispatchForTask(taskId) {
    return this.db.prepare("SELECT * FROM dispatches WHERE task_id = ?").get(taskId);
  }

  completionForTask(taskId) {
    const row = this.db.prepare("SELECT * FROM completions WHERE task_id = ?").get(taskId);
    return row ? { ...row, payload: JSON.parse(row.payload) } : null;
  }

  recordCompletion(taskId, completion) {
    this.db.prepare("INSERT INTO completions (task_id, status, payload, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(task_id) DO NOTHING")
      .run(taskId, completion.status, JSON.stringify(completion), Date.now());
  }

  recordDispatch(taskId, recipient, transport, body, payload) {
    this.db.prepare(`
      INSERT INTO dispatches (task_id, recipient, transport, body, payload, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(task_id) DO NOTHING
    `).run(taskId, recipient, transport, body, payload, Date.now());
  }

  enqueueResult(taskId, recipient, transport, payload) {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO outbox (task_id, recipient, transport, payload, status, created_at)
      VALUES (?, ?, ?, ?, 'pending', ?)
      ON CONFLICT(task_id) DO NOTHING
    `).run(taskId, recipient, transport, payload, now);
  }

  outboxForTask(taskId) {
    return this.db.prepare("SELECT * FROM outbox WHERE task_id = ?").get(taskId);
  }

  pendingOutbox() {
    return this.db.prepare("SELECT * FROM outbox WHERE status IN ('pending', 'retrying') ORDER BY id").all();
  }

  recordDeliveryAttempt(outboxId, transport, status, error = null) {
    this.db.prepare("INSERT INTO delivery_attempts (outbox_id, transport, status, error, attempted_at) VALUES (?, ?, ?, ?, ?)")
      .run(outboxId, transport, status, error ? String(error).slice(0, 2000) : null, Date.now());
    this.db.prepare("UPDATE outbox SET attempts = attempts + 1 WHERE id = ?").run(outboxId);
  }

  markSent(id, transport) {
    this.db.prepare("UPDATE outbox SET status = 'sent', sent_at = ?, last_error = NULL, delivered_transport = ? WHERE id = ?")
      .run(Date.now(), transport, id);
  }

  markRetry(id, error) {
    this.db.prepare("UPDATE outbox SET status = 'retrying', last_error = ? WHERE id = ?")
      .run(String(error).slice(0, 2000), id);
  }

  deliveryAttempts(outboxId) {
    return this.db.prepare("SELECT * FROM delivery_attempts WHERE outbox_id = ? ORDER BY id").all(outboxId);
  }

  registerTransientRun(run) {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO transient_runs (
        run_id, task_id, parent_task_id, workflow_id, workflow_kind, workflow_role, agent_id, stream_id,
        source_repo_path, checkout_path, backend, workspace_id, pane_id,
        status, cleanup_policy, cleanup_state, result_status, result_body, last_error,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      run.runId,
      run.taskId,
      run.parentTaskId ?? null,
      run.workflowId ?? null,
      run.workflowKind ?? null,
      run.workflowRole ?? null,
      run.agentId,
      run.streamId,
      run.sourceRepoPath,
      run.checkoutPath,
      run.backend,
      run.workspaceId ?? null,
      run.paneId ?? null,
      run.status ?? "provisioning",
      run.cleanupPolicy,
      run.cleanupState ?? "pending",
      run.resultStatus ?? null,
      run.resultBody ?? null,
      run.lastError ?? null,
      now,
      now,
    );
  }

  transientRun(runId) {
    return this.db.prepare("SELECT * FROM transient_runs WHERE run_id = ?").get(runId) ?? null;
  }

  transientRunForAgentTask(agentId, taskId) {
    return this.db.prepare(`
      SELECT * FROM transient_runs
      WHERE agent_id = ? AND task_id = ?
        AND status IN (${ACTIVE_TRANSIENT_STATUSES.map(() => "?").join(", ")})
      LIMIT 1
    `).get(agentId, taskId, ...ACTIVE_TRANSIENT_STATUSES) ?? null;
  }

  transientRuns(limit = 5) {
    return this.db.prepare("SELECT * FROM transient_runs ORDER BY created_at DESC LIMIT ?").all(limit);
  }

  transientRunsForWorkflow(workflowId) {
    return this.db.prepare("SELECT * FROM transient_runs WHERE workflow_id = ? ORDER BY created_at, run_id").all(workflowId);
  }

  markTransientRunReady(runId, details = {}) {
    return this.#updateTransientRun(runId, {
      status: "ready",
      workspace_id: details.workspaceId,
      pane_id: details.paneId,
      checkout_path: details.checkoutPath,
      last_error: null,
    });
  }

  markTransientRunDispatched(runId, details = {}) {
    return this.#updateTransientRun(runId, {
      status: "dispatched",
      pane_id: details.paneId,
      workspace_id: details.workspaceId,
      last_error: null,
    });
  }

  markTransientRunSettled(runId, resultStatus, resultBody) {
    return this.#updateTransientRun(runId, {
      status: "settled",
      result_status: resultStatus,
      result_body: resultBody,
      last_error: null,
    });
  }

  markTransientRunFailed(runId, error, resultBody) {
    return this.#updateTransientRun(runId, {
      status: "failed",
      result_body: resultBody,
      last_error: error ? String(error).slice(0, 2000) : null,
    });
  }

  markTransientRunExpired(runId, error = "expired") {
    return this.#updateTransientRun(runId, {
      status: "expired",
      last_error: error ? String(error).slice(0, 2000) : null,
    });
  }

  markTransientRunCleaned(runId, cleanupState = "cleaned", error = null) {
    return this.#updateTransientRun(runId, {
      cleanup_state: cleanupState,
      last_error: error ? String(error).slice(0, 2000) : null,
    });
  }

  completedTaskCount() {
    return this.db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE status = 'settled'").get().count;
  }

  statusSummary() {
    const taskCounts = this.db.prepare("SELECT status, COUNT(*) AS count FROM tasks GROUP BY status").all();
    const outboxCounts = this.db.prepare("SELECT status, COUNT(*) AS count FROM outbox GROUP BY status").all();
    const transientRunCounts = this.db.prepare("SELECT status, COUNT(*) AS count FROM transient_runs GROUP BY status").all();
    const recentTransientRuns = this.db.prepare("SELECT run_id, task_id, workflow_id, workflow_kind, workflow_role, agent_id, stream_id, backend, status, cleanup_policy, cleanup_state, result_status FROM transient_runs ORDER BY created_at DESC LIMIT 5").all();
    const latestFailure = this.db.prepare("SELECT task_id, recipient, transport, last_error FROM outbox WHERE last_error IS NOT NULL ORDER BY id DESC LIMIT 1").get();
    return { taskCounts, outboxCounts, transientRunCounts, recentTransientRuns, latestFailure: latestFailure ?? null };
  }

  close() { this.db.close(); }

  #updateTransientRun(runId, patch) {
    const entries = Object.entries(patch).filter(([, value]) => value !== undefined);
    if (!entries.length) return false;
    const setters = entries.map(([column]) => `${column} = ?`).join(", ");
    const values = entries.map(([, value]) => value);
    return this.db.prepare(`UPDATE transient_runs SET ${setters}, updated_at = ? WHERE run_id = ?`)
      .run(...values, Date.now(), runId).changes === 1;
  }
}
