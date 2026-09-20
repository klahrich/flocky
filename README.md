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

Set `FLOCKY_PROTOCOL_SECRET` locally. Telegram projects also require `TELEGRAM_API_ID` and `TELEGRAM_API_HASH`.

The Pi extension auto-loads from `.pi/extensions/flocky-agent-protocol/` after the project is trusted. It persists local task/outbox state in `.pi/flocky/flocky.db`, which is ignored by Git.

Add or update a stream later:

```bash
node tools/set-stream.mjs --id landing --path ../landing --telegram-target @landing_bot
node tools/set-stream.mjs --id landing --remove
```

When Herdr is selected, onboarding scans only the owner’s current workspace for existing matching Pi panes. Each stream chosen for launch is created in its **own dedicated Herdr workspace**, never the owner workspace.

## Manage configured streams and routes

```text
/streams list
/streams add
/streams edit <stream-id>
/streams remove <stream-id>

/routes list
/routes discover
/routes verify
/routes remove <stream-id> [herdr|telegram]
```

`/routes discover` inspects only the current Herdr workspace and always asks before saving a route. `/routes verify` checks saved Herdr pane routes without changing configuration.

Copy the relevant template from `templates/` to the owner workspace and each stream repository. Stream repositories also need the protocol extension and a local `flocky.config.json` whose `runtime.agentId` matches that stream.
