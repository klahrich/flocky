# Flocky

A reusable project-owner workspace for coordinating long-running Pi stream agents over Telegram.

See [project_brief.md](project_brief.md) for the architecture and protocol.

## Quick start

```bash
git clone <this-repository> my-project-orchestrator
cd my-project-orchestrator
npm test
pi
```

On its first TUI start, Flocky offers an onboarding wizard for the project description, streams, and default transport. It writes the ignored `flocky.config.json` and `projects/<project-id>/PROJECT.md` only after confirmation.

Copy `.env.example` to `.env` and set `FLOCKY_PROTOCOL_SECRET` locally. `TELEGRAM_API_ID` and `TELEGRAM_API_HASH` are optional; set them only for Telegram transport projects.

The Pi extension auto-loads from `.pi/extensions/flocky-agent-protocol/` after the project is trusted. It persists local task/outbox state in `.pi/flocky/flocky.db`, which is ignored by Git.

Add or update a stream later:

```bash
node tools/set-stream.mjs --id landing --path ../landing --telegram-target @landing_bot
node tools/set-stream.mjs --id landing --remove
```

When Herdr is selected, onboarding scans managed Herdr workspaces for existing matching Pi panes and asks before saving any match. Each stream chosen for launch is created in its **own dedicated Herdr workspace**, never the owner workspace.

## Delegate work: durable and transient

Flocky now supports both:

- **durable stream agents** for ongoing back-and-forth in a repository
- **transient Herdr workers** for one-off execution

The owner-facing mixed-mode tool is `flocky_delegate`.

Typical behavior:

- `mode=auto`, `workflow=single` → durable stream dispatch
- `mode=transient`, `workflow=single` → one transient worker
- `workflow=implement-review` → transient implementer + reviewer/tester workflow

For transient coding with `workflow=implement-review`, Flocky previews a short approval message first so the user can switch to the durable stream instead before any transient workers are launched.

The lower-level tools still exist when you want explicit control:

- `flocky_dispatch`
- `flocky_transient_dispatch`
- `flocky_transient_implement_review`

## Manage configured streams and routes

```text
/flocky                         # overview (same as /flocky help)
/flocky streams                 # stream-management help
/flocky routes                  # route-management help

/streams help
/streams list
/streams add
/streams edit <stream-id>
/streams remove <stream-id>
/attach-stream <stream-id>

/routes help
/routes list
/routes discover
/routes verify
/routes remove <stream-id> [herdr|telegram]
```

`/streams add` offers to attach the existing Git repository immediately. `/attach-stream <stream-id>` lets you preview and attach a previously registered stream. Attachment copies only Flocky-owned extension/skill files, generates stream-local configuration, and adds or updates a marked block in `AGENTS.md` without deleting existing project instructions.

`/routes discover` scans managed Herdr workspaces for Pi panes whose repository CWD matches a configured stream, and always asks before saving a route. `/routes verify` checks saved Herdr pane routes without changing configuration.

Copy the relevant template from `templates/` to the owner workspace and each stream repository. Stream repositories also need the protocol extension and a local `flocky.config.json` whose `runtime.agentId` matches that stream.
