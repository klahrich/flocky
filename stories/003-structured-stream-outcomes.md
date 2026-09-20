---
status: completed
stage: delivered
created: 2026-09-20
updated: 2026-09-20
system: protocol-and-reporting
---

# Outcome

Every stream completion report carries an accurate semantic outcome instead of being labelled `success` merely because Pi became idle.

## In scope

- Define a required final response contract for delegated stream tasks.
- Support `success`, `partial`, `blocked`, `failed`, and `refused` outcomes.
- Require concise sections for summary, completed work, remaining work, validation/evidence, blocker/reason, safe state, and next action.
- Parse the declared outcome at `agent_settled` and put it in the signed result envelope.
- Define safe fallback behavior when the stream omits or malforms the contract; never default that case to success.
- Update stream `AGENTS.md` template and owner instructions to use the contract.

## Out of scope

- Independent verification of every claim in a result.
- Replacing the stream agent’s normal human-readable final answer.

## Canonical path

`stream final answer -> outcome parser -> conservative fallback classification -> signed result envelope -> owner analysis`

## Side-effect budget

Allowed:

- Add structured reporting requirements to Flocky-owned instructions.
- Persist parsed outcome metadata with the task/result record.

Forbidden:

- Relabelling an unverified, malformed, blocked, or partial answer as success.
- Dropping the original final answer when parsing fails.

## Verification

- Fixture answers for each of the five statuses produce matching signed envelope statuses.
- A final answer with no valid marker is classified conservatively and remains visible in full.
- Owner receives the result body and status unchanged across Herdr and Telegram delivery.

## Definition of done

- `agent_settled` no longer implies `status=success`.
- The owner can reliably distinguish completed work from partial, blocked, failed, and refused work.
