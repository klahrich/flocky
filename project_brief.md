# Flocky: Telegram-Orchestrated Pi Agents

## Purpose

Flocky is a reusable, top-level orchestration repository for a project that spans multiple code repositories (called **streams**). A user talks to one project-owner Pi agent through Telegram. The owner understands the project and dispatches repository-specific work to long-running stream Pi agents.

The project owner does not implement product code itself. Each stream agent works in its own repository and sends a durable completion report back to the owner.

This repository is intended to be cloned for any top-level project. Per-project differences are limited to the project description, configured streams, and local credentials.

## Roles

### Project-owner agent

- Has one user-facing Telegram bot.
- Holds project-level knowledge: goals, architecture, stream map, priorities, and cross-stream implications.
- Answers questions that do not require stream work.
- Dispatches stream work when a request affects one or more stream repositories.
- Receives, evaluates, and summarizes stream results for the user.
- Does not directly edit stream product code.

### Stream agent

- Is a long-running Pi agent rooted in exactly one stream repository.
- Has its own Telegram bot, normally used by the project owner rather than directly by the user.
- Implements, tests, and reports work in its repository.
- Replies to the project owner only for authenticated tasks that requested a reply.
- Processes one dispatched task at a time; later tasks are queued FIFO.

## Transport model

The normal user-facing Telegram bridge handles the conversation between a human and a Pi agent.

Agent-to-agent dispatch is different: the project owner sends a message **to a stream bot** through a logged-in Telegram user account (MTProto). The Bot API cannot make one bot submit an inbound message to another bot. The stream bot’s normal inbound bridge then delivers the task into its Pi session.

The same MTProto path is used for stream-to-owner completion reports.

The reusable Telegram skill is stored at `.agents/skills/telegram/`. It provides `send_as_user.py` for messages that must make a target bot react.

## Authenticated protocol

Agent messages begin with a signed first-line envelope, followed by the human-readable task or result body.

```text
{{flocky:v1 type=task task_id=01J... from=project-owner reply_to=landing answer_back=yes sig=<hex>}}
Implement the revised hero section. Preserve the current mobile layout.
```

```text
{{flocky:v1 type=result task_id=01J... from=landing status=success sig=<hex>}}
Summary: ...
Changes: ...
Validation: ...
Blockers: none
```

Required envelope fields vary by type:

| Type | Required fields |
|---|---|
| `task` | `task_id`, `from`, `reply_to`, `answer_back`, `sig` |
| `result` | `task_id`, `from`, `status`, `sig` |
| `compact` | `from`, `sig` |

`sig` is an HMAC-SHA256 signature over the canonical envelope fields (everything except `sig`) plus the body, using `FLOCKY_PROTOCOL_SECRET`. The signature prevents a normal Telegram user from forging an agent task by typing an envelope-shaped message.

Agent IDs are stable logical identifiers and are separate from Telegram usernames. The project-owner agent ID is exactly the project ID (for example, `my-project`); each stream agent ID is exactly its stream ID (for example, `website-stream`).

## Durable task lifecycle

The Pi extension uses SQLite, at `.pi/flocky/flocky.db`, rather than a single overwrite file. This prevents crossed replies when additional messages arrive while an agent is working.

Incoming tasks move through:

```text
received -> running -> settled -> delivered
                       \-> failed
```

An outbox record is created before a completion message is sent. A failed delivery remains retryable and cannot silently lose the result. `task_id` is unique and provides idempotency for duplicate Telegram delivery.

The extension uses Pi lifecycle events as follows:

1. `input`: parse and verify protocol envelopes, then persist accepted tasks.
2. `before_agent_start`: associate the actual prompt with its durable task and mark it running.
3. `message_end`: remember the latest non-empty assistant prose for the active task.
4. `agent_settled`: after retries, compaction, and queued continuations have stopped, enqueue and send the final result.

`message_end` alone is not a completion event because it can observe an intermediate tool-calling assistant message.

## Concurrency policy

Version 1 permits one active dispatched task per stream-agent Pi session. Additional valid tasks remain in durable FIFO order and Pi’s normal queued-input behavior controls when they begin.

Parallel work should use separate streams or separately provisioned agent sessions/worktrees—not multiple concurrent tasks in one long-running coding session. During Herdr onboarding, every launched stream agent receives its own dedicated Herdr workspace; stream agents are never launched into the project owner’s current workspace.

## Compaction

Compaction is stream-local. The project owner must not send a literal `/compact` prompt as a maintenance mechanism.

At a settled task boundary, the stream extension may call Pi’s compaction API when configured context or completed-task thresholds are reached. A signed `compact` control envelope is available as an explicit override. Compaction never starts while a task is active.

## Configuration and secrets

`flocky.config.json` is local and ignored by Git. It maps the project owner and streams to logical IDs, repository paths, and Telegram targets. The committed `flocky.config.example.json` contains no tokens or secrets.

Secrets stay in environment variables or local secret stores:

- `FLOCKY_PROTOCOL_SECRET` — HMAC signing secret.
- `TELEGRAM_API_ID` / `TELEGRAM_API_HASH` — MTProto application credentials.
- The cached Telethon session is local and ignored.

## Repository contents

```text
.pi/extensions/flocky-agent-protocol/  Pi lifecycle extension
.agents/skills/telegram/               MTProto and Bot API transport skill
projects/<project>/                    project-level planning knowledge
templates/                             owner and stream AGENTS.md templates
tools/                                 stream/project configuration commands
test/                                  protocol and persistence tests
```

## Initial implementation scope

1. Initialize the reusable repository and config schema.
2. Add signed envelope parsing and verification.
3. Add SQLite inbox/outbox persistence and idempotency.
4. Add the Pi extension lifecycle integration and MTProto sender.
5. Add owner/stream agent instruction templates.
6. Add stream management commands inspired by the prior Flocky repository.
7. Test protocol, persistence, duplicate delivery, and sender behavior with a mock before real Telegram rollout.
