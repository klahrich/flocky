---
status: proposed
stage: drafted
created: 2026-09-21
updated: 2026-09-21
system: transient-execution
---

# Outcome

The project-owner Pi agent can execute one signed delegated coding task through a freshly spawned transient Pi worker in Herdr without pre-registering a durable stream pane.

## In scope

- Add a transient execution path distinct from durable stream routing.
- Support one transient backend initially: Herdr.
- Provision an isolated temporary workspace or worktree for the target repository.
- Launch a fresh Pi agent in that workspace and wait until it is ready to accept a task.
- Assign a transient logical agent ID for the run and deliver a signed Flocky task to it.
- Capture the transient worker’s signed result and correlate it to the originating owner task.
- Support explicit cleanup policy for the transient workspace/pane: preserve, cleanup-on-success, or always-cleanup.
- Keep the current durable Herdr route model unchanged for long-running streams.

## Out of scope

- Multi-step workflows such as implement-then-review.
- Telegram-backed transient workers.
- Automatic retries that silently create replacement workers after partial execution.

## Canonical path

`owner transient dispatch -> provision isolated Herdr workspace/worktree -> launch pi -> register transient run -> signed task delivery -> structured result -> optional cleanup`

## Side-effect budget

Allowed:

- Create temporary worktrees, Herdr workspaces, panes, and local transient-run records.
- Write Flocky-owned state needed to route and correlate the transient task.

Forbidden:

- Reusing the owner pane as a transient worker.
- Mutating a shared repository checkout used by another active worker.
- Replacing durable stream routes as part of transient execution.

## Verification

- A fixture repository can receive a transient task, produce a signed structured result, and return it to the owner.
- A transient run uses an isolated checkout/worktree rather than the owner workspace.
- Cleanup policy is honored for both success and failure cases.
- A failed spawn or readiness wait leaves no falsely trusted route behind.

## Definition of done

- Flocky can execute one task through a spawned Herdr worker without requiring a pre-saved pane route.
- Durable streams continue to work unchanged.
