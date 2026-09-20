const STATUSES = new Set(["success", "partial", "blocked", "failed", "refused"]);

export function parseOutcome(answer) {
  const text = typeof answer === "string" ? answer.trim() : "";
  const marker = text.match(/^RESULT:\s*(SUCCESS|PARTIAL|BLOCKED|FAILED|REFUSED)\s*$/im);
  if (!marker) {
    return {
      status: "partial",
      declared: false,
      reason: "The stream settled without a valid RESULT marker; outcome is unverified.",
      sections: {},
    };
  }
  const status = marker[1].toLowerCase();
  const sections = parseSections(text);
  const reason = section(sections, "blocker") || section(sections, "reason") || (status === "success" ? "" : "No reason supplied.");
  return { status: STATUSES.has(status) ? status : "partial", declared: true, reason, sections };
}

function parseSections(text) {
  const sections = {};
  const pattern = /^(Summary|Completed|Not completed|Validation|Evidence|Blocker|Reason|Safe state|Next action):\s*(.*)$/gim;
  let match;
  while ((match = pattern.exec(text))) sections[match[1].toLowerCase()] = match[2].trim();
  return sections;
}

function section(sections, name) { return sections[name] ?? ""; }
