---
status: proposed
stage: planned
created: 2026-09-20
updated: 2026-09-20
system: operational-validation
---

# Outcome

A human-approved, harmless real Herdr run in repositories created from the private `flocky2` GitHub template proves that Flocky can discover, route to, and receive a result from an actual stream Pi agent.

## In scope

- Create and clone a private `test-flocky2` owner repository from the `flocky2` GitHub template.
- Use a separate disposable existing Git stream repository created from the same template; do not attach the production/original `flocky2` checkout as a test stream.
- Run the owner Pi and stream Pi under Herdr.
- Confirm route discovery and route persistence.
- Dispatch a read-only task with a clear expected result, such as reporting repository name and Git status.
- Confirm the stream result reaches the owner through Herdr and is correlated to the task ID.
- Verify that the stream runs in its own dedicated workspace and that no owner-workspace pane is reused.
- Record privacy-safe evidence and clean up only workspaces created by the test.

## Out of scope

- Product-code mutations.
- Telegram validation.
- Closing or modifying pre-existing user workspaces, panes, or agents.

## Canonical path

`template-derived owner and fixture stream clones -> dedicated workspace -> route discovery -> signed read-only task -> stream response -> owner receipt -> evidence review -> cleanup`

## Side-effect budget

Allowed:

- Create dedicated test workspaces and Pi agents only in confirmed template-derived fixture repositories.
- Create local Flocky config/state for the fixtures.

Forbidden:

- Editing application code.
- Reusing an unrelated existing pane as the stream agent.
- Closing any workspace not created by the smoke test.

## Verification

- Herdr reports a distinct workspace for the fixture stream.
- Route verification confirms Pi agent and expected CWD before dispatch.
- Owner receives a signed result with the original task ID and an accurate status.
- Test-created workspace cleanup is confirmed without touching unrelated workspaces.

## Definition of done

- One controlled real Herdr lifecycle succeeds end to end.
- Any operational mismatch becomes a documented bug/story before product work is routed through Flocky.
