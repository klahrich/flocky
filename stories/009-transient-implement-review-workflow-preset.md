---
status: proposed
stage: drafted
created: 2026-09-21
updated: 2026-09-21
system: transient-workflows
---

# Outcome

An owner can invoke one generic transient workflow preset that spawns an implementer worker, then a reviewer/tester worker, and receives a combined report.

## In scope

- Define a reusable workflow preset for `implement -> review/test` using transient workers.
- Spawn a writable implementer worker for the initial coding task.
- Carry forward the implementer’s resulting code state to a separate reviewer/tester worker without collapsing both roles into one session.
- Require both workers to return structured Flocky results.
- Aggregate implementer and reviewer outcomes into one owner-facing summary while preserving both underlying task IDs and reports.
- Surface reviewer findings clearly, including validation evidence, failures, and any disagreement with the implementer’s declared success.

## Out of scope

- Autonomous fix loops that repeatedly send reviewer feedback back to the implementer.
- Multiple parallel reviewers.
- Non-Herdr backends.

## Canonical path

`owner workflow request -> transient implementer run -> code + validation result -> transient reviewer/tester run -> combined owner synthesis`

## Side-effect budget

Allowed:

- Create separate transient workspaces or worktrees for implementer and reviewer roles.
- Persist workflow lineage linking the reviewer to the implementer run.

Forbidden:

- Running review/test in the same transient session that authored the code.
- Reporting workflow success when review/test failed or produced unresolved blockers.
- Dropping either worker’s raw structured report from the durable record.

## Verification

- A fixture workflow produces two distinct transient runs with separate identities.
- The reviewer can inspect and test the implementer’s output and return an independent result.
- The owner receives a combined summary that includes both statuses and validation evidence.
- A reviewer failure or blocker is reflected in the final workflow outcome.

## Definition of done

- `implement-review` becomes a first-class transient workflow preset rather than ad hoc owner prompting.
- The owner can delegate coding plus independent review/testing in one command or tool flow.
