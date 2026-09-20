import { spawn } from "node:child_process";
import { resolve } from "node:path";

export async function sendViaHerdr({ cwd, route, text, signal }) {
  if (process.env.HERDR_ENV !== "1") throw new Error("Herdr transport is unavailable outside a Herdr-managed pane");
  if (!route?.paneId || !route?.expectedCwd) throw new Error("Herdr route is incomplete");
  const inspected = await herdr(["pane", "get", route.paneId], signal);
  const pane = inspected?.result?.pane;
  if (pane?.agent !== "pi") throw new Error(`Herdr route ${route.paneId} is no longer a Pi agent`);
  if (resolve(pane.cwd).toLowerCase() !== resolve(cwd, route.expectedCwd).toLowerCase() && resolve(pane.cwd).toLowerCase() !== resolve(route.expectedCwd).toLowerCase()) {
    throw new Error(`Herdr route ${route.paneId} no longer matches its expected repository`);
  }
  await herdr(["pane", "run", route.paneId, text], signal);
  return { paneId: route.paneId };
}

function herdr(args, signal) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("herdr", args, { windowsHide: true });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(stderr.trim() || `herdr ${args.join(" ")} exited ${code}`));
      try { resolvePromise(JSON.parse(stdout)); } catch (error) { reject(error); }
    });
    signal?.addEventListener("abort", () => child.kill(), { once: true });
  });
}
