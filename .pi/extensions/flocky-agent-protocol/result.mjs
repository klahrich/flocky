export const NO_TEXT_FINAL_RESPONSE = "Task settled without a textual final response. Review the session transcript for details.";

export function renderCompletion(completion) {
  const list = (items) => items.length ? items.map((item) => `- ${item}`).join("\n") : "- none";
  return `RESULT: ${completion.status.toUpperCase()}\nSummary: ${completion.summary}\nCompleted:\n${list(completion.completed)}\nNot completed:\n${list(completion.notCompleted)}\nValidation:\n${list(completion.validation)}\nReason: ${completion.reason || "none"}\nSafe state: ${completion.safeState}\nNext action: ${completion.nextAction}`;
}

export function hasMeaningfulAssistantAnswer(answer) {
  const text = typeof answer === "string" ? answer.trim() : "";
  return Boolean(text) && text !== NO_TEXT_FINAL_RESPONSE;
}

export function buildResultBody({ agentId, taskId, answer, completion, outcome }) {
  const structured = completion ? renderCompletion(completion) : "";
  const outcomeNote = outcome.declared ? "" : `\n\nFlocky note: ${outcome.reason}`;
  const raw = completion && hasMeaningfulAssistantAnswer(answer) ? `\n\nRaw assistant message:\n${answer.trim()}` : "";
  return `Result from stream \`${agentId}\` for task ${taskId}:\n\n${structured || answer}${outcomeNote}${structured ? raw : ""}`;
}
