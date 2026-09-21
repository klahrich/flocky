const MODES = new Set(["auto", "durable", "transient"]);
const WORKFLOWS = new Set(["single", "implement-review"]);

export function resolveDelegationPlan({ mode = "auto", workflow } = {}) {
  const selectedMode = mode ?? "auto";
  const selectedWorkflow = workflow ?? "single";
  if (!MODES.has(selectedMode)) throw new Error("mode must be auto, durable, or transient");
  if (!WORKFLOWS.has(selectedWorkflow)) throw new Error("workflow must be single or implement-review");

  if (selectedMode === "durable") {
    if (selectedWorkflow !== "single") throw new Error("Durable mode supports only the single workflow");
    return { mode: "durable", workflow: "single", tool: "flocky_dispatch", requiresApproval: false };
  }

  if (selectedMode === "transient") {
    return {
      mode: "transient",
      workflow: selectedWorkflow,
      tool: selectedWorkflow === "implement-review" ? "flocky_transient_implement_review" : "flocky_transient_dispatch",
      requiresApproval: selectedWorkflow === "implement-review",
    };
  }

  if (selectedWorkflow === "implement-review") {
    return { mode: "transient", workflow: "implement-review", tool: "flocky_transient_implement_review", requiresApproval: true };
  }

  return { mode: "durable", workflow: "single", tool: "flocky_dispatch", requiresApproval: false };
}
