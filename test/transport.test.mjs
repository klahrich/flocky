import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sendAsTelegramUser } from "../.pi/extensions/flocky-agent-protocol/transport.mjs";
import { sendViaHerdr } from "../.pi/extensions/flocky-agent-protocol/herdr.mjs";
import { INLINE_PAYLOAD_CHAR_LIMIT } from "../.pi/extensions/flocky-agent-protocol/message.mjs";

test("Telegram adapter invokes the configured sender with target and payload", async () => {
  const dir = mkdtempSync(join(tmpdir(), "flocky-transport-"));
  try {
    const fakeSender = join(dir, "fake-sender.mjs");
    writeFileSync(fakeSender, "console.log(JSON.stringify(process.argv.slice(2)))\n", "utf8");
    const result = await sendAsTelegramUser({
      cwd: dir,
      config: { transport: { command: process.execPath, commandArgs: [fakeSender], sendAsUserScript: "ignored.py" } },
      target: "@stream_bot",
      text: "signed payload",
    });
    assert.match(result.stdout, /@stream_bot/);
    assert.match(result.stdout, /signed payload/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("Telegram adapter rejects oversized compact payloads before spawning the sender", () => {
  assert.throws(
    () => sendAsTelegramUser({
      cwd: process.cwd(),
      config: { transport: { command: process.execPath, commandArgs: ["-e", "process.exit(0)"], sendAsUserScript: "ignored.py" } },
      target: "@stream_bot",
      text: "x".repeat(INLINE_PAYLOAD_CHAR_LIMIT + 1),
    }),
    /telegram payload exceeded the compact inline limit/,
  );
});

test("Herdr adapter validates a Pi pane then sends the payload", async () => {
  const dir = mkdtempSync(join(tmpdir(), "flocky-herdr-"));
  const oldPath = process.env.PATH;
  const oldHerdr = process.env.HERDR_ENV;
  const oldCommand = process.env.FLOCKY_HERDR_COMMAND;
  try {
    const fixture = join(dir, "fake-herdr.mjs");
    const pane = { agent: "pi", cwd: process.cwd(), pane_id: "w1:p9" };
    writeFileSync(fixture, `console.log(${JSON.stringify(JSON.stringify({ result: { pane } }))})\n`, "utf8");
    writeFileSync(join(dir, "herdr.cmd"), `@echo off\r\n"${process.execPath}" "${fixture}" %*\r\n`, "utf8");
    process.env.PATH = `${dir};${oldPath}`;
    process.env.FLOCKY_HERDR_COMMAND = join(dir, "herdr.cmd");
    process.env.HERDR_ENV = "1";
    const result = await sendViaHerdr({ cwd: process.cwd(), route: { paneId: "w1:p9", expectedCwd: process.cwd() }, text: "signed payload" });
    assert.equal(result.paneId, "w1:p9");
  } finally {
    process.env.PATH = oldPath;
    if (oldHerdr === undefined) delete process.env.HERDR_ENV;
    else process.env.HERDR_ENV = oldHerdr;
    if (oldCommand === undefined) delete process.env.FLOCKY_HERDR_COMMAND;
    else process.env.FLOCKY_HERDR_COMMAND = oldCommand;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Herdr adapter refuses to send outside a Herdr-managed session", async () => {
  const original = process.env.HERDR_ENV;
  delete process.env.HERDR_ENV;
  try {
    await assert.rejects(
      sendViaHerdr({ cwd: process.cwd(), route: { paneId: "w1:p1", expectedCwd: process.cwd() }, text: "payload" }),
      /unavailable outside a Herdr-managed pane/,
    );
  } finally {
    if (original === undefined) delete process.env.HERDR_ENV;
    else process.env.HERDR_ENV = original;
  }
});
