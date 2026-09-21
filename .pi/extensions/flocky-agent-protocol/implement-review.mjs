const REVIEWABLE_STATUSES = new Set(["success", "partial"]);
const TERMINAL_NONREVIEWABLE_STATUSES = new Set(["blocked", "failed", "refused"]);

export function buildImplementReviewApprovalPrompt({ streamId }) {
  return `Use transient implement+review agents for this coding task on ${streamId}? Or switch to the durable ${streamId} agent.`;
}

export function shouldRunImplementReview(implementerStatus) {
  return REVIEWABLE_STATUSES.has(String(implementerStatus));
}

export function buildReviewerTask({ originalTask, implementerTaskId, implementerStatus, implementerReport }) {
  return [
    "Review and test the current checkout produced by the implementer for the original task below.",
    "Do not assume the implementer was correct. Independently inspect the code, run appropriate validation, and report any gaps, failures, or blockers.",
    "If the work is incomplete, say so clearly and cite evidence.",
    "",
    "Original task:",
    originalTask.trim(),
    "",
    `Implementer task ID: ${implementerTaskId}`,
    `Implementer reported status: ${implementerStatus}`,
    "Implementer report:",
    implementerReport?.trim() || "(no report captured)",
  ].join("\n");
}

export function finalImplementReviewStatus({ implementerStatus, reviewerStatus, reviewerLaunchError }) {
  const implementer = String(implementerStatus || "partial");
  const reviewer = reviewerStatus ? String(reviewerStatus) : undefined;
  if (!reviewer && TERMINAL_NONREVIEWABLE_STATUSES.has(implementer)) return implementer;
  if (reviewerLaunchError) return implementer === "success" ? "partial" : implementer;
  if (!reviewer) return implementer;
  if (["blocked", "failed", "refused"].includes(reviewer)) return reviewer;
  if (implementer === "success" && reviewer === "success") return "success";
  return "partial";
}

export function renderImplementReviewSummary({ workflowId, streamId, implementer, reviewer, reviewerLaunchError }) {
  const finalStatus = finalImplementReviewStatus({
    implementerStatus: implementer?.result_status,
    reviewerStatus: reviewer?.result_status,
    reviewerLaunchError,
  });
  const parts = [
    `Transient implement-review workflow ${workflowId} for stream \`${streamId}\`.`,
    `Workflow status: ${String(finalStatus).toUpperCase()}`,
    "",
    "Implementer stage:",
    `- run_id: ${implementer?.run_id ?? "unknown"}`,
    `- task_id: ${implementer?.task_id ?? "unknown"}`,
    `- status: ${implementer?.result_status ?? implementer?.status ?? "unknown"}`,
    "- report:",
    indent(implementer?.result_body || "(no implementer report captured)"),
  ];

  if (reviewer) {
    parts.push(
      "",
      "Reviewer stage:",
      `- run_id: ${reviewer.run_id}`,
      `- task_id: ${reviewer.task_id}`,
      `- status: ${reviewer.result_status ?? reviewer.status ?? "unknown"}`,
      "- report:",
      indent(reviewer.result_body || "(no reviewer report captured)"),
    );
  } else {
    parts.push("", "Reviewer stage:", "- not started");
  }

  if (reviewerLaunchError) {
    parts.push("", `Reviewer launch failure: ${reviewerLaunchError}`);
  }

  return parts.join("\n");
}

function indent(text) {
  return String(text).split(/\r?\n/).map((line) => `  ${line}`).join("\n");
}
