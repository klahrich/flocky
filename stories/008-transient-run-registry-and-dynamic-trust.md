---
status: proposed
stage: drafted
created: 2026-09-21
updated: 2026-09-21
system: transient-execution
---

# Outcome

Flocky can safely trust, track, and expire transient worker identities created by the owner at runtime without promoting them to permanent configured agents.

## In scope

- Add durable local records for active transient runs, including run ID, transient agent ID, parent task or workflow ID, repository path, pane/workspace identity, backend, status, and cleanup state.
- Allow signed envelopes from a transient agent only when that agent ID belongs to an active locally created run.
- Preserve current trust rules for configured durable agents.
- Record parent-child task lineage so owner summaries can attribute which transient run produced which result.
- Mark runs complete, failed, expired, or cleaned up as lifecycle events occur.
- Expose enough status for debugging transient execution without revealing secrets.

## Out of scope

- Federating transient trust across multiple machines.
- Permanent configuration for every transient agent ID.
- Fan-out aggregation across arbitrary external worker systems.

## Canonical path

`owner provisions transient run -> registry records trusted transient identity -> worker sends signed result -> owner validates against active registry -> run settles -> trust expires or is cleaned up`

## Side-effect budget

Allowed:

- Persist transient-run metadata in local SQLite state.
- Accept signed messages from dynamically registered transient agent IDs.

Forbidden:

- Trusting unknown transient senders merely because their envelope is well-formed.
- Leaving completed or failed runs indefinitely active without an expiry or cleanup state.
- Mixing transient worker identity into static stream configuration by default.

## Verification

- A transient worker result is accepted only while its run is active in the registry.
- A forged or unknown transient sender is rejected even with a valid-looking envelope shape.
- Completed and cleaned-up runs no longer remain trusted for new messages.
- Owner diagnostics can show transient lineage and final state for a completed run.

## Definition of done

- Dynamic transient workers are first-class runtime participants without polluting static agent configuration.
- Envelope trust remains explicit and auditable.
