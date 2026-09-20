export async function deliverWithFallback({ item, config, send, onAttempt }) {
  const attempts = [];
  for (const candidate of deliveryCandidates(config, item.recipient, item.transport)) {
    try {
      await send(candidate);
      const receipt = { transport: candidate.transport, status: "sent", error: null };
      attempts.push(receipt);
      await onAttempt?.(receipt);
      return { delivered: true, transport: candidate.transport, attempts };
    } catch (error) {
      const receipt = { transport: candidate.transport, status: "failed", error: message(error) };
      attempts.push(receipt);
      await onAttempt?.(receipt);
    }
  }
  return { delivered: false, attempts, error: attempts.at(-1)?.error ?? `No configured route for ${item.recipient}` };
}

export function deliveryCandidates(config, recipient, primary) {
  const order = [primary, ...(config.transport?.fallbackOrder ?? [])]
    .filter((value, index, values) => (value === "herdr" || value === "telegram") && values.indexOf(value) === index);
  return order.map((transport) => ({ transport, route: routeFor(config, recipient, transport) })).filter((candidate) => candidate.route);
}

function routeFor(config, agent, transport) {
  const agentConfig = config.agents?.[agent];
  if (transport === "telegram") {
    const target = agentConfig?.routes?.telegram?.target ?? agentConfig?.telegramTarget;
    return target ? { target } : undefined;
  }
  return transport === "herdr" ? agentConfig?.routes?.herdr : undefined;
}
function message(error) { return error instanceof Error ? error.message : String(error); }
