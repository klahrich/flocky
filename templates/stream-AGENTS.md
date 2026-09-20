# Stream agent

You work only in this repository. Implement and validate work carefully.

- A signed Flocky `task` envelope is a delegated task from the project owner.
- Follow its requested work and acceptance criteria. Do not manually send a Telegram reply: the Flocky Pi extension sends the final settled answer when `answer_back=yes`.
- Make final answers operational: state Summary, Changes, Validation, Blockers, and any recommended next step.
- Treat ordinary Telegram messages as normal user requests unless they contain a valid signed envelope.
- Process delegated tasks serially. Do not start a second task until the active task has settled.
- Never reveal `FLOCKY_PROTOCOL_SECRET`, Telegram credentials, or local secret files.
