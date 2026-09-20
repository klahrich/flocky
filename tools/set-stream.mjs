#!/usr/bin/env node
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const value = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const has = (name) => args.includes(name);
const configFile = resolve(value("--config") ?? "flocky.config.json");
const id = value("--id");

if (!id || !/^[a-z0-9][a-z0-9-]*$/.test(id)) die("--id must be a lowercase logical agent ID");
const config = existsSync(configFile) ? JSON.parse(readFileSync(configFile, "utf8")) : { project: {}, agents: {}, protocol: { secretEnv: "FLOCKY_PROTOCOL_SECRET" } };
config.agents ??= {};

if (has("--remove")) {
  if (!config.agents[id]) die(`Unknown stream: ${id}`);
  delete config.agents[id];
} else {
  const path = value("--path");
  const telegramTarget = value("--telegram-target");
  if (!path || !telegramTarget) die("--path and --telegram-target are required when adding or editing a stream");
  config.agents[id] = { ...config.agents[id], path, telegramTarget };
}
writeAtomic(configFile, `${JSON.stringify(config, null, 2)}\n`);
console.log(JSON.stringify({ ok: true, config: configFile, action: has("--remove") ? "removed" : "upserted", id }));

function writeAtomic(file, content) { const temp = `${file}.${process.pid}.tmp`; writeFileSync(temp, content, "utf8"); renameSync(temp, file); }
function die(error) { console.error(JSON.stringify({ ok: false, error })); process.exit(1); }
