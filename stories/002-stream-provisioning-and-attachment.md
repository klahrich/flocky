---
status: proposed
stage: planned
created: 2026-09-20
updated: 2026-09-20
system: stream-lifecycle
---

# Outcome

An existing stream repository can be safely attached to Flocky.

## In scope

- Add a project-owner command/tool to provision or attach a stream by stream ID.
- Require the configured repository path to already exist and be a Git repository; surface a clear error otherwise.
- For an existing repository, attach Flocky without overwriting product files or existing agent instructions without confirmation.
- Install/update the Flocky protocol extension, stream-local `flocky.config.json`, and stream-specific `AGENTS.md` instructions.
- Configure `runtime.agentId` to exactly the stream ID and include the project owner as a known peer/route recipient.
- Record attachment state and installed Flocky schema version for idempotent re-runs/upgrades.

## Out of scope

- Creating or rotating Telegram credentials automatically.
- Migrating arbitrary existing agent frameworks without user confirmation.
- Modifying application source code.

## Canonical path

`registered stream -> inspect repository state -> user confirmation for attachment changes -> generate local Flocky artifacts -> validate stream config -> durable attachment receipt`

## Side-effect budget

Allowed:

- Create/update Flocky-owned files in a confirmed existing stream repository.

Forbidden:

- Replacing an existing `AGENTS.md`, `.pi/extensions`, or local config without a preview and confirmation.
- Editing product code, commits, remotes, branches, or credentials.

## Verification

- Attach an existing fixture Git repository while preserving a pre-existing application file and AGENTS content.
- Re-run attachment and confirm it is idempotent.
- Verify an attached stream accepts a signed task and can resolve the owner route.
- Verify a missing directory or non-Git directory is rejected before Flocky-owned files are written.

## Definition of done

- Existing repositories can join a project safely.
- An attached stream has all files needed for protocol participation.
- Attachment receipts identify changed files and any user-confirmed overwrite.
