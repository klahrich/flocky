# Flocky

Flocky is a project-owner workspace for coordinating Pi agents across multiple existing Git repositories, called **streams**. One owner agent holds the project map and delegates repository work to durable stream agents or one-off transient Herdr workers.

Flocky supports **Herdr** and **Telegram** transports. It keeps agent-to-agent tasks authenticated, durable, and correlated with their results.

- New here? Follow **[First project](#first-project)**.
- Already operating a project? Start with **[Day-to-day use](#day-to-day-use)** or **[Operate streams and routes](#operate-streams-and-routes)**.
- Looking for technical protocol detail? Read [project_brief.md](project_brief.md).

## What Flocky does

- Maintains one project-owner Pi agent and one durable Pi agent per stream repository.
- Sends signed Flocky tasks to configured stream IDs and returns structured results to the owner.
- Uses SQLite for durable inbox, outbox, retry, task, and schedule state.
- Supports both long-running stream conversations and transient Herdr workers.
- Keeps local credentials, stream configuration, and runtime state out of Git.

A **stream** is always an existing Git repository. Flocky never creates or deletes stream repositories.

## Prerequisites

| Requirement | Needed for |
|---|---|
| Git and an existing repository for every stream | All setups |
| Pi | All setups |
| `FLOCKY_PROTOCOL_SECRET` | All setups; onboarding can generate it locally |
| Herdr | Herdr routes, durable Herdr streams, and transient workers |
| `TELEGRAM_API_ID` and `TELEGRAM_API_HASH` | Telegram transport only |

Copy `.env.example` to `.env` if you want to provide values manually. The two Telegram credentials are optional unless you select Telegram transport. If `FLOCKY_PROTOCOL_SECRET` is missing, TUI onboarding offers to generate a random local secret and save it in `.env`.

```bash
git clone <this-repository> my-project-orchestrator
cd my-project-orchestrator
npm test
pi
```

> Use a GitHub template-derived repository or a clone of this repository as the owner workspace. For Herdr onboarding, start the owner Pi session inside Herdr.

## First project

On first TUI start, Flocky guides you through onboarding.

1. Choose a project ID and write a project description.
2. Add each stream using its **existing Git repository root** and a short ownership description.
3. Select Herdr or Telegram as the default stream transport.
4. Confirm the generated attachment preview. Flocky installs only its own extension, stream-local configuration, environment values, and a managed block in each stream's `AGENTS.md`.
5. For Herdr, confirm discovered routes and optionally launch unmatched stream agents in dedicated Herdr workspaces.

During attachment, all agents must share the project protocol secret. If a selected stream has a conflicting local secret, onboarding explains the conflict and asks before replacing that stream's value.

### Expected result

At the end of onboarding, you should have:

- a local owner `flocky.config.json` and protocol secret;
- every selected stream attached with its own Flocky extension and `flocky.config.json`;
- managed Flocky instructions added without removing existing `AGENTS.md` content;
- saved routes for discovered or newly launched Herdr stream panes, or configured Telegram routes;
- newly launched stream Pi sessions ready to receive Flocky tasks.

If a stream Pi session was already open before its repository was attached, restart Pi in that stream repository once so it loads the new extension.

## Day-to-day use

Talk to the owner in normal language. When you name a configured stream, the owner should route the request through Flocky rather than treating that name as a Telegram contact.

| Goal | Example |
|---|---|
| Send a simple message to a stream | `Send "hi" to stream-a` |
| Delegate repository work | `Ask website-stream to update the pricing-page hero and preserve mobile layout.` |
| Request a one-off worker | `Use a transient worker to inspect the migration issue in stream-a.` |
| Request implementation plus review | `Run an implement-review workflow for this bug in website-stream.` |
| Check non-secret protocol state | Ask the owner to inspect Flocky status. |

For a simple quoted message, Flocky dispatches the quoted content itself: `Send "hi" to stream-a` becomes the stream task `hi`, not an instruction for the recipient stream to resend `hi`.

### Durable streams vs transient workers

| Mode | Use it when |
|---|---|
| **Durable stream** | You want ongoing context, back-and-forth, and a long-running owner/stream relationship. This is the default for ordinary repository work. |
| **Transient worker** | You want isolated, one-off execution in a temporary Herdr workspace/check-out. |
| **Transient implement-review** | You want a temporary implementer followed by a separate reviewer/tester. Flocky previews this workflow for user approval before it runs. |

The owner-facing `flocky_delegate` tool selects durable or transient execution. `mode=auto` with a single workflow defaults to durable dispatch.

## Operate streams and routes

Use `/flocky` for in-product help.

### Common actions

| Goal | Command |
|---|---|
| Show Flocky help | `/flocky` or `/flocky help` |
| Show configured streams | `/streams` |
| Add or change a stream | `/streams add` or `/streams edit <id>` |
| Attach a stream added after onboarding | `/attach-stream <id>` |
| Attach several later-added streams | `/attach-streams [id ...]` |
| Show configured routes | `/routes` |
| Find live Herdr stream panes | `/routes discover` |
| Check saved Herdr routes | `/routes verify` |

### Stream commands

```text
/streams help
/streams list
/streams add
/streams edit <stream-id>
/streams remove <stream-id>
/attach-stream <stream-id>
/attach-streams [stream-id ...]
```

`/streams add` registers an existing Git repository and offers attachment immediately. Removing a stream removes only Flocky configuration and routes; it never removes its repository or Herdr workspace.

### Route commands

```text
/routes help
/routes list
/routes discover
/routes verify
/routes remove <stream-id> [herdr|telegram]
```

Herdr discovery scans managed workspaces for Pi panes whose CWD matches a configured stream repository. Route changes are confirmation-gated. Telegram and Herdr routes can coexist, allowing configured delivery fallback.

## Schedules

The owner can create durable recurring task definitions with `flocky_schedule_create`, then install a Windows Task Scheduler trigger on the designated scheduler host. Flocky records occurrence claims in its local SQLite store so duplicate timer runs are skipped safely.

See [docs/scheduling.md](docs/scheduling.md) for the Windows runner, timezone, and missed-run guidance.

## Troubleshooting

| Symptom | What to do |
|---|---|
| A stream path is rejected | Provide the root of an existing Git repository, not a subdirectory inside another repository. |
| A stream was added after onboarding | Attach it with `/attach-stream <id>` or `/attach-streams`, then start or restart Pi in that repository. |
| A Herdr workspace already exists but has no route | Run `/routes discover` from the owner and confirm the matching pane. |
| A stream has a conflicting protocol secret | During onboarding, confirm replacement if appropriate. For later attachment, resolve it deliberately before attaching. |
| A stream does not receive tasks after attachment | Restart its Pi session so it loads the installed extension, then verify its route. |
| An envelope has an invalid signature | Do not act on it. Restart agents after a protocol-secret change and ensure owner and stream `.env` values match. |
| Telegram dispatch is unavailable | Confirm the project selected Telegram and that local `TELEGRAM_API_ID` and `TELEGRAM_API_HASH` are present. |

## Commands and owner tools

Slash commands are operator-facing commands typed into Pi. Flocky tools are used by the owner agent to perform authenticated work.

| Tool | Purpose |
|---|---|
| `flocky_dispatch` | Send one durable task to a configured stream. |
| `flocky_delegate` | Select durable or transient execution for one repository task. |
| `flocky_transient_dispatch` | Start a one-off transient Herdr worker. |
| `flocky_transient_implement_review` | Preview or run a transient implementer/reviewer workflow. |
| `flocky_status` | Show non-secret protocol, task, and outbox diagnostics. |
| `flocky_schedule_create` | Create or update a confirmed recurring task definition. |
| `flocky_schedule_pause` | Disable a saved schedule. |
| `flocky_schedule_install_windows` / `flocky_schedule_uninstall_windows` | Preview or manage that schedule's Windows trigger. |
| `flocky_attach_stream` / `flocky_attach_streams` | Preview or apply stream attachment through the owner agent. |

Stream agents use `flocky_complete` once per delegated task to record a validated structured terminal outcome.

## Local files and security

The following are intentionally local and ignored by Git:

- `.env` — protocol secret and optional Telegram credentials
- `flocky.config.json` — owner/stream IDs, repository paths, routes, and transport settings
- `.pi/flocky/flocky.db` — durable task, outbox, schedule, and transient-run state
- Telegram session files

Never paste a protocol secret, Telegram credential, or raw local configuration into a chat or commit.

## Architecture

Read [project_brief.md](project_brief.md) for the signed-envelope protocol, trust model, SQLite lifecycle, concurrency policy, and architecture rationale.
