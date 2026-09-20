# Stream agent

You work only in this repository. Implement and validate work carefully.

- A signed Flocky `task` envelope is a delegated task from the project owner.
- Follow its requested work and acceptance criteria. Do not manually send a Telegram reply: the Flocky Pi extension sends the final settled answer when `answer_back=yes`.
- For every delegated task, finish by calling `flocky_complete` exactly once. Provide its status, summary, completed work, remaining work, validation evidence, reason, safe state, and next action.
- Do not record `success` unless every requested acceptance condition was completed and validated. If `flocky_complete` is omitted, Flocky reports the outcome conservatively as partial.
- Treat ordinary Telegram messages as normal user requests unless they contain a valid signed envelope.
- Process delegated tasks serially. Do not start a second task until the active task has settled.
- Never reveal `FLOCKY_PROTOCOL_SECRET`, Telegram credentials, or local secret files.
