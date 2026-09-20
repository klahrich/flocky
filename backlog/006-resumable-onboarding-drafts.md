---
status: backlog
priority: medium
created: 2026-09-20
system: onboarding
---

# Resumable onboarding drafts and config import

## Outcome

Flocky onboarding persists incremental progress and can resume or import a reviewed onboarding configuration without re-entering every project and stream field.

## In scope

- Persist a local ignored onboarding draft after each completed wizard step.
- Offer resume/discard when a prior incomplete draft exists.
- Provide an explicit import path for a reviewed local onboarding JSON file.
- Validate imported project IDs, existing Git stream paths, transport routes, and secret-environment references before activation.
- Preserve the current final `flocky.config.json` as the canonical completed configuration.

## Verification

- Cancel onboarding after stream entry, restart Pi, and resume from the saved draft.
- Import an invalid/missing-repository configuration and verify no final config is written.
- Import a valid configuration and activate it without repeating prompts.

## Definition of done

- A long onboarding flow is recoverable after interruption without manual config editing.
