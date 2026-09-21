---
status: proposed
stage: drafted
created: 2026-09-21
updated: 2026-09-21
system: owner-experience
---

# Outcome

A project owner can mix durable agents and transient workflows naturally, including requests such as “use transient coding and reviewing agents for this task,” without treating transient execution as a protocol fork.

## In scope

- Add owner-facing selection for execution mode: durable, transient, or auto.
- Distinguish durable agents, transient profiles, and workflow presets in configuration and tool surfaces.
- Let the owner target either a configured durable stream or a transient workflow over a repository or worktree-capable target.
- Support a generic owner-side workflow/tool API that can express one transient worker, implement-review, and future presets.
- For coding work where the owner would choose transient implement-review, first tell the user that Flocky is about to use transient implementation and review agents and ask for approval before dispatch.
- In that approval step, give the user a clear chance to switch the task to a durable stream instead.
- Keep transport/backend capabilities explicit; initial transient backend support is Herdr only.
- Update owner instructions and operator docs so mixed-mode delegation is discoverable and unsurprising.

## Out of scope

- A fully autonomous natural-language planner that never needs clarification.
- Backends other than Herdr for transient execution.
- Replacing the simple durable `flocky_dispatch` primitive.

## Canonical path

`user intent -> owner chooses durable vs transient vs auto -> if transient coding is proposed, preview + user approval with durable alternative -> selected agent/profile/workflow -> execution backend -> signed results -> owner synthesis`

## Side-effect budget

Allowed:

- Add owner-facing tools, commands, and configuration needed to select execution mode and workflow.
- Preserve both durable and transient lifecycle records for operator visibility.

Forbidden:

- Presenting transient execution as just another saved durable route.
- Hiding backend limitations such as `transient currently requires Herdr`.
- Breaking existing durable owner/stream flows to introduce transient support.

## Verification

- An owner can successfully choose a durable stream for one task and a transient workflow for another without reconfiguration.
- A request explicitly asking for transient coding and reviewing agents routes to the implement-review preset.
- When the owner is about to use transient implement-review for a coding task, the user sees a preview/approval message before dispatch and can switch to a durable stream instead.
- Owner-facing output makes clear which execution mode and backend were used.
- Existing durable stream dispatch remains unchanged and tested.

## Definition of done

- Mixed durable/transient delegation is a coherent product surface.
- Transient coding workflows require an explicit user approval step with an easy durable alternative.
- Transient workflows feel native without polluting the durable stream model.
