---
status: completed
priority: high
created: 2026-09-20
system: protocol-and-reporting
---

# Enforce structured stream completion with `flocky_complete`

## Outcome

A stream task can produce a successful Flocky completion report only through a validated structured `flocky_complete` tool call.

## Problem

The current `RESULT: ...` text contract is instruction-led and parsed after the fact. A stream agent can omit or malform it. Flocky conservatively reports that as partial, but it cannot guarantee a normalized successful completion payload.

## In scope

- Register a stream-facing `flocky_complete` Pi tool with a strict schema:
  - `status`: `success | partial | blocked | failed | refused`
  - `summary`
  - `completed`
  - `notCompleted`
  - `validation`
  - `reason`
  - `safeState`
  - `nextAction`
- Inject task-specific instructions requiring exactly one `flocky_complete` call at the end of a signed delegated task.
- Persist the validated structured completion against the active task.
- Render the signed result body from structured data, independent of incidental assistant prose.
- Treat a stream that settles without `flocky_complete` as an unverified `partial` result.
- Issue at most one narrow corrective follow-up requesting only the missing completion tool call; do not restart broad task work.
- Update stream and owner templates.

## Out of scope

- Guaranteeing that an LLM will call a tool in all circumstances.
- Replacing normal local transcript output.
- Automatically retrying failed implementation work.

## Canonical path

`signed task -> task-specific completion instruction -> flocky_complete schema validation -> durable structured result -> signed normalized result envelope -> owner`

## Side-effect budget

Allowed:

- Persist one structured completion record per task.
- Send one narrowly scoped corrective follow-up when the completion tool was omitted.

Forbidden:

- Reporting `success` from unstructured prose alone.
- Sending more than one automatic corrective follow-up.
- Dropping the original final answer or diagnostics.

## Verification

- Every valid status is accepted and rendered into the normalized signed result body.
- A malformed tool invocation is rejected by schema validation.
- A task with no completion tool call is reported as partial with an explicit protocol reason.
- The corrective follow-up happens once only.
- A successful plain-text `RESULT: SUCCESS` without the tool does not become a protocol success.

## Definition of done

- Successful Flocky completion is gated by a persisted `flocky_complete` tool result.
- Owner agents receive consistently structured outcomes across Telegram and Herdr.
