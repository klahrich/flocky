---
status: backlog
priority: medium
created: 2026-09-20
system: herdr-operations
---

# Launch a stream agent after onboarding

## Outcome

An operator can launch an attached stream’s Pi agent in a dedicated Herdr workspace after onboarding through one confirmed command.

## In scope

- Add `/routes launch <stream-id>`.
- Validate that the stream is attached, has an existing Git repository, and has no valid active Herdr route.
- Create a dedicated Herdr workspace named for the stream, never a pane in the owner workspace.
- Start normal interactive `pi`, wait for an idle detected Pi agent, verify its CWD, and save the route atomically.
- Report actionable failure state without guessing a replacement route.

## Verification

- Launch succeeds for an attached fixture stream.
- The created agent has a distinct workspace and matching CWD.
- Existing valid routes are not replaced without confirmation.
- Launch failure leaves no incorrect saved route.

## Definition of done

- Operators do not need to manually create a Herdr workspace to bring an attached stream online.
