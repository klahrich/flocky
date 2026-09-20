---
status: completed
stage: delivered
created: 2026-09-20
updated: 2026-09-20
system: protocol-and-dispatch
---

# Outcome

The project-owner Pi agent can dispatch one signed, durable task to a configured stream through a single `flocky_dispatch` tool call.

## In scope

- Register a Pi tool named `flocky_dispatch`.
- Accept stream ID, task body, `answerBack`, and optional transport preference.
- Validate project configuration, stream identity, secret availability, and route availability.
- Generate a unique task ID, build/sign the task envelope, persist the outgoing dispatch before delivery, and deliver it through the selected transport.
- Return a compact receipt containing task ID, recipient, selected transport, and delivery state.
- Preserve duplicate-safe behavior when a delivery is retried.

## Out of scope

- Stream provisioning.
- Cross-stream task fan-out from one tool call.
- Automatic task decomposition by the owner model.

## Canonical path

`owner tool call -> config/route validation -> task ID + HMAC envelope -> durable dispatch/outbox record -> transport adapter -> receipt`

## Side-effect budget

Allowed:

- Create durable task/outbox records.
- Send one signed message to one confirmed configured route.

Forbidden:

- Sending to an unknown stream, unverified Herdr pane, or unconfigured Telegram target.
- Exposing the protocol secret in tool output, logs, or the LLM context.

## Verification

- A mock Telegram transport receives a signed task envelope with a unique task ID.
- A mock Herdr transport receives the same envelope shape.
- Invalid stream IDs, missing secrets, and missing routes fail before any send attempt.
- Retrying the same dispatch does not create conflicting durable records.

## Definition of done

- The owner can dispatch a task without manually composing an envelope.
- The dispatch receipt is traceable to a durable record.
- Automated tests cover both transports and validation failures.
