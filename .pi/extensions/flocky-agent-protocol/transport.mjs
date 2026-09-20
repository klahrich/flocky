import { spawn } from "node:child_process";
import { resolve } from "node:path";

export function sendAsTelegramUser({ cwd, config, target, text, signal }) {
  const script = resolve(cwd, config.transport?.sendAsUserScript ?? ".agents/skills/telegram/scripts/send_as_user.py");
  const command = config.transport?.command ?? "uv";
  const commandArgs = config.transport?.commandArgs ?? ["run"];
  const args = [...commandArgs, script, "--to", target, "--text", text];

  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, env: process.env, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) return resolvePromise({ stdout: stdout.trim() });
      reject(new Error(`${command} transport exited ${code}: ${(stderr || stdout).trim()}`));
    });
    signal?.addEventListener("abort", () => child.kill(), { once: true });
  });
}
