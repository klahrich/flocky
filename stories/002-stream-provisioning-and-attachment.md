---
status: proposed
stage: planned
created: 2026-09-20
updated: 2026-09-20
system: stream-lifecycle
---

# Outcome

A registered stream can be safely attached to Flocky whether its repository already exists or is newly created for the project.

## In scope

- Add a project-owner command/tool to provision or attach a stream by stream ID.
- Validate the configured repository path and report whether it is an existing Git repository, an empty directory, or missing.
- For an existing repository, attach Flocky without overwriting product files or existing agent instructions without confirmation.
- Install/update the Flocky protocol extension, stream-local `flocky.config.json`, and stream-specific `AGENTS.md` instructions.
- Configure `runtime.agentId` to exactly the stream ID and include the project owner as a known peer/route recipient.
- Support an explicit create-new-repository path only when the user asks for it.
- Record attachment state and installed Flocky schema version for idempotent re-runs/upgrades.

## Out of scope

- Creating or rotating Telegram credentials automatically.
- Migrating arbitrary existing agent frameworks without user confirmation.
- Modifying application source code.

## Canonical path

`registered stream -> inspect repository state -> user confirmation for attachment changes -> generate local Flocky artifacts -> validate stream config -> durable attachment receipt`

## Side-effect budget

Allowed:

- Create/update Flocky-owned files in a confirmed stream repo.
- Create a new repository only after an explicit create request.

Forbidden:

- Replacing an existing `AGENTS.md`, `.pi/extensions`, or local config without a preview and confirmation.
- Editing product code, commits, remotes, branches, or credentials.

## Verification

- Attach an existing fixture Git repository while preserving a pre-existing application file and AGENTS content.
- Re-run attachment and confirm it is idempotent.
- Verify a newly attached stream accepts a signed task and can resolve the owner route.
- Verify a missing repository requires explicit create confirmation.

## Definition of done

- Existing repositories can join a project safely.
- A newly attached stream has all files needed for protocol participation.
- Attachment receipts identify changed files and any user-confirmed overwrite.
