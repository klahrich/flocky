import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

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
    `);
    try { this.db.exec("ALTER TABLE outbox ADD COLUMN transport TEXT NOT NULL DEFAULT 'telegram'"); } catch { /* Existing databases already have the column. */ }
    try { this.db.exec("ALTER TABLE tasks ADD COLUMN outcome_status TEXT"); } catch { /* Existing databases already have the column. */ }
    try { this.db.exec("ALTER TABLE tasks ADD COLUMN outcome_reason TEXT"); } catch { /* Existing databases already have the column. */ }
    try { this.db.exec("ALTER TABLE outbox ADD COLUMN delivered_transport TEXT"); } catch { /* Existing databases already have the column. */ }
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

  completedTaskCount() {
    return this.db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE status = 'settled'").get().count;
  }

  statusSummary() {
    const taskCounts = this.db.prepare("SELECT status, COUNT(*) AS count FROM tasks GROUP BY status").all();
    const outboxCounts = this.db.prepare("SELECT status, COUNT(*) AS count FROM outbox GROUP BY status").all();
    const latestFailure = this.db.prepare("SELECT task_id, recipient, transport, last_error FROM outbox WHERE last_error IS NOT NULL ORDER BY id DESC LIMIT 1").get();
    return { taskCounts, outboxCounts, latestFailure: latestFailure ?? null };
  }

  close() { this.db.close(); }
}
