---
status: backlog
priority: low
created: 2026-09-20
system: release-engineering
---

# Release polish and continuous verification

## Outcome

Flocky has a repeatable release-quality baseline for contributors and future template users.

## In scope

- Add CI that runs `npm test` on supported Node versions.
- Document onboarding prerequisites, local environment variables, and safe secret handling.
- Publish concise release notes/changelog for the first usable Herdr release.
- Document fixture-repository retention/cleanup policy.
- Add a template-user setup checklist.

## Out of scope

- Publishing an npm package.
- Automated Telegram credential provisioning.

## Verification

- CI succeeds on a clean clone without real Herdr or Telegram credentials.
- Documentation leads a new user from template creation to a successful local onboarding.

## Definition of done

- The template can be adopted and validated predictably by another developer.
