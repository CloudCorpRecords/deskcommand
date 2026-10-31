#!/usr/bin/env node
/**
 * deskcommand CLI.
 *
 *   deskcommand mcp
 *   deskcommand ls <path>
 *   deskcommand read <path>
 *   deskcommand run <command...>
 *   deskcommand search <path> <pattern>
 *   deskcommand --version
 *
 * Exit codes: 0 success, 1 operation error, 2 usage error.
 * This tool operates on the local machine; the CLI runs the same
 * real implementations as the MCP tools.
 */
import { DeskCommand, VERSION } from "./command.js";

function usage(): never {
  console.error(`Usage:
  deskcommand mcp
  deskcommand ls <path>
  deskcommand read <path>
  deskcommand run <command...>
  deskcommand search <path> <pattern>
  deskcommand --version`);
  process.exit(2);
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "--version" || cmd === "-v") { console.log(VERSION); return; }
  if (cmd === "mcp") { await import("./mcp.js"); return; }
  if (!cmd) usage();
  try {
    const dc = new DeskCommand();
    if (cmd === "ls") {
      const [path] = rest; if (!path) usage();
      for (const e of await dc.listDirectory(path)) console.log(`${e.type === "directory" ? "dir " : "file"} ${e.name}`);
    } else if (cmd === "read") {
      const [path] = rest; if (!path) usage();
      console.log(await dc.readFile(path));
    } else if (cmd === "run") {
      const command = rest.join(" "); if (!command) usage();
      const r = await dc.startProcess(command, { timeout_ms: 3000 });
      console.log(r.output);
      console.error(`pid: ${r.pid}`);
    } else if (cmd === "search") {
      const [path, pattern] = rest; if (!path || !pattern) usage();
      const s = await dc.startSearch(path, pattern);
      for (const m of s.results) console.log(`${m.file}:${m.line}: ${m.text}`);
    } else usage();
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
void main();
