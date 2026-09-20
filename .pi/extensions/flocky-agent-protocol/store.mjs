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
        final_answer TEXT
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
        created_at INTEGER NOT NULL,
        sent_at INTEGER
      ) STRICT;
    `);
    try { this.db.exec("ALTER TABLE outbox ADD COLUMN transport TEXT NOT NULL DEFAULT 'telegram'"); } catch { /* Existing databases already have the column. */ }
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

  settleTask(taskId, finalAnswer) {
    this.db.prepare("UPDATE tasks SET status = 'settled', final_answer = ?, updated_at = ? WHERE task_id = ?")
      .run(finalAnswer, Date.now(), taskId);
  }

  failTask(taskId) {
    this.db.prepare("UPDATE tasks SET status = 'failed', updated_at = ? WHERE task_id = ?")
      .run(Date.now(), taskId);
  }

  enqueueResult(taskId, recipient, transport, payload) {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO outbox (task_id, recipient, transport, payload, status, created_at)
      VALUES (?, ?, ?, ?, 'pending', ?)
      ON CONFLICT(task_id) DO NOTHING
    `).run(taskId, recipient, transport, payload, now);
  }

  pendingOutbox() {
    return this.db.prepare("SELECT * FROM outbox WHERE status IN ('pending', 'retrying') ORDER BY id").all();
  }

  markSent(id) {
    this.db.prepare("UPDATE outbox SET status = 'sent', attempts = attempts + 1, sent_at = ?, last_error = NULL WHERE id = ?")
      .run(Date.now(), id);
  }

  markRetry(id, error) {
    this.db.prepare("UPDATE outbox SET status = 'retrying', attempts = attempts + 1, last_error = ? WHERE id = ?")
      .run(String(error).slice(0, 2000), id);
  }

  completedTaskCount() {
    return this.db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE status = 'settled'").get().count;
  }

  close() { this.db.close(); }
}
