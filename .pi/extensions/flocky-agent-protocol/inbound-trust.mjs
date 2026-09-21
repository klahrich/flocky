export function classifyInboundEnvelope({ parsed, config, store }) {
  const fields = parsed?.fields ?? {};
  const sender = fields.from;
  const type = fields.type;
  if (!sender || !type) return { trusted: false, reason: "missing sender or type" };

  if (config?.agents?.[sender]) return { trusted: true, kind: "durable", sender };

  if (type !== "result") {
    return { trusted: false, reason: `unknown non-durable sender ${sender}` };
  }

  const run = store?.transientRunForAgentTask?.(sender, fields.task_id);
  if (!run) {
    return { trusted: false, reason: `unknown transient sender ${sender}` };
  }
  return { trusted: true, kind: "transient", sender, run };
}
