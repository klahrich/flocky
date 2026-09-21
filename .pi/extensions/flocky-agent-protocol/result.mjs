import { COMPACT_RESULT_BODY_CHAR_LIMIT, clipList, clipText, extractArtifactRefs, unique } from "./message.mjs";

export const NO_TEXT_FINAL_RESPONSE = "Task settled without a textual final response. Review the session transcript for details.";
const COMPACT_OVERFLOW_NOTE = "\n\nDetail moved to repo artifacts or commit history.";

export function renderCompletion(completion) {
  const list = (items) => items.length ? items.map((item) => `- ${item}`).join("\n") : "- none";
  const artifacts = completion.artifacts?.length ? `\nArtifacts:\n${list(completion.artifacts)}` : "";
  return `RESULT: ${completion.status.toUpperCase()}\nSummary: ${completion.summary}\nCompleted:\n${list(completion.completed)}\nNot completed:\n${list(completion.notCompleted)}\nValidation:\n${list(completion.validation)}${artifacts}\nReason: ${completion.reason || "none"}\nSafe state: ${completion.safeState}\nNext action: ${completion.nextAction}`;
}

export function hasMeaningfulAssistantAnswer(answer) {
  const text = typeof answer === "string" ? answer.trim() : "";
  return Boolean(text) && text !== NO_TEXT_FINAL_RESPONSE;
}

export function buildResultBody({ agentId, taskId, answer, completion, outcome }) {
  const lines = [`Result from stream \`${agentId}\` for task ${taskId}:`, ""];

  if (completion) lines.push(renderCompactCompletion(completion));
  else lines.push(`Result: ${String(outcome.status ?? "partial").toUpperCase()}\nSummary: ${clipText(answer, 700) || "No textual final response recorded."}`);

  if (!outcome.declared) lines.push(`Flocky note: ${clipText(outcome.reason, 180)}`);

  return fitCompactLimit(lines.join("\n"));
}

function renderCompactCompletion(completion) {
  const sections = [
    `Result: ${String(completion.status ?? "partial").toUpperCase()}`,
    `Summary: ${clipText(completion.summary, 260) || "none"}`,
  ];

  const completed = clipList(completion.completed, { maxItems: 3, maxItemChars: 140 });
  if (completed.length) sections.push(`Completed:\n${completed.map((item) => `- ${item}`).join("\n")}`);

  const remaining = clipList(completion.notCompleted, { maxItems: 2, maxItemChars: 140 });
  if (remaining.length) sections.push(`Remaining:\n${remaining.map((item) => `- ${item}`).join("\n")}`);

  const validation = clipList(completion.validation, { maxItems: 3, maxItemChars: 140 });
  if (validation.length) sections.push(`Validation:\n${validation.map((item) => `- ${item}`).join("\n")}`);

  const artifacts = compactArtifacts(completion);
  if (artifacts.length) sections.push(`Artifacts:\n${artifacts.map((item) => `- ${item}`).join("\n")}`);

  if (completion.reason && completion.reason !== "none") sections.push(`Reason: ${clipText(completion.reason, 180)}`);
  sections.push(`Safe state: ${clipText(completion.safeState, 180) || "none recorded"}`);
  sections.push(`Next action: ${clipText(completion.nextAction, 180) || "none"}`);
  return sections.join("\n");
}

function compactArtifacts(completion) {
  const explicit = clipList(completion.artifacts ?? [], { maxItems: 3, maxItemChars: 120 });
  if (explicit.length) return unique(explicit);
  const inferred = extractArtifactRefs([
    completion.summary,
    ...(completion.completed ?? []),
    ...(completion.notCompleted ?? []),
    ...(completion.validation ?? []),
    completion.reason,
    completion.safeState,
    completion.nextAction,
  ]);
  return clipList(inferred, { maxItems: 3, maxItemChars: 120 });
}

function fitCompactLimit(text) {
  if (text.length <= COMPACT_RESULT_BODY_CHAR_LIMIT) return text;
  return `${text.slice(0, COMPACT_RESULT_BODY_CHAR_LIMIT - COMPACT_OVERFLOW_NOTE.length).trimEnd()}${COMPACT_OVERFLOW_NOTE}`;
}
