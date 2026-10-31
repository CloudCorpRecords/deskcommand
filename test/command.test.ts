import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile as fsRead } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeskCommand } from "../src/command.js";
import type { ProcessExecutor } from "../src/types.js";

class FakeProc implements ProcessExecutor {
  started: string[] = [];
  killed: number[] = [];
  async start(command: string) { this.started.push(command); return { pid: 4242, output: `started: ${command}` }; }
  async interact(pid: number, input: string) { return `pid ${pid} got: ${input}`; }
  async readOutput(pid: number) { return `output of ${pid}`; }
  async listSessions() { return [{ pid: 4242, command: "sleep 60", running: true }]; }
  async listProcesses() { return [{ pid: 1, command: "init" }, { pid: 4242, command: "sleep" }]; }
  async kill(pid: number) { this.killed.push(pid); }
  async forceTerminate(pid: number) { this.killed.push(-pid); }
}

let dir: string;
before(async () => { dir = await mkdtemp(join(tmpdir(), "deskcommand-")); });
after(async () => { await rm(dir, { recursive: true, force: true }); });

describe("deskcommand filesystem (real, temp dir)", () => {
  it("write, read, list and info round-trip", async () => {
    const dc = new DeskCommand(new FakeProc());
    const file = join(dir, "sub", "a.txt");
    const w = await dc.writeFile(file, "alpha\nbeta\ngamma");
    assert.equal(w.bytes, 16);
    assert.equal(await dc.readFile(file), "alpha\nbeta\ngamma");
    const entries = await dc.listDirectory(join(dir, "sub"));
    assert.deepEqual(entries.map((e) => e.name), ["a.txt"]);
    const info = await dc.getFileInfo(file);
    assert.equal(info.type, "file"); assert.equal(info.size, 16);
  });
  it("readFile honours line offset and length", async () => {
    const dc = new DeskCommand(new FakeProc());
    const file = join(dir, "lines.txt");
    await dc.writeFile(file, "l0\nl1\nl2\nl3");
    assert.equal(await dc.readFile(file, 1, 2), "l1\nl2");
    assert.equal(await dc.readFile(file, 3), "l3");
  });
  it("readMultipleFiles reports per-file errors inline, never throws", async () => {
    const dc = new DeskCommand(new FakeProc());
    const ok = join(dir, "ok.txt");
    await dc.writeFile(ok, "fine");
    const out = await dc.readMultipleFiles([ok, join(dir, "missing.txt")]);
    assert.equal(out[ok], "fine");
    assert.match(out[join(dir, "missing.txt")], /Error reading file/);
  });
  it("createDirectory is recursive and moveFile renames", async () => {
    const dc = new DeskCommand(new FakeProc());
    await dc.createDirectory(join(dir, "x/y/z"));
    const from = join(dir, "x/y/z/f.txt");
    await dc.writeFile(from, "data");
    const to = join(dir, "moved.txt");
    await dc.moveFile(from, to);
    assert.equal(await fsRead(to, "utf8"), "data");
  });
  it("editBlock replaces a unique block and enforces the count rules", async () => {
    const dc = new DeskCommand(new FakeProc());
    const file = join(dir, "edit.txt");
    await dc.writeFile(file, "hello world\nhello moon");
    const r = await dc.editBlock(file, "world", "there");
    assert.equal(r.replacements, 1);
    assert.equal(await dc.readFile(file), "hello there\nhello moon");
    await assert.rejects(() => dc.editBlock(file, "hello", "hi"), /occurs 2 times/);
    const r2 = await dc.editBlock(file, "hello", "hi", 2);
    assert.equal(r2.replacements, 2);
    await assert.rejects(() => dc.editBlock(file, "absent", "x"), /not found/);
    await assert.rejects(() => dc.editBlock(file, "", "x"), /must not be empty/);
  });
  it("writePdf writes the content as given (documented simplification)", async () => {
    const dc = new DeskCommand(new FakeProc());
    const file = join(dir, "doc.pdf");
    const r = await dc.writePdf(file, "%PDF-placeholder-content");
    assert.equal(r.bytes, 24);
    assert.equal(await fsRead(file, "utf8"), "%PDF-placeholder-content");
  });
});

describe("deskcommand search (real, temp dir)", () => {
  it("startSearch finds content matches and paginates its session", async () => {
    const dc = new DeskCommand(new FakeProc());
    await dc.writeFile(join(dir, "s1.txt"), "needle one\nplain\nneedle two");
    await dc.writeFile(join(dir, "s2.md"), "another needle");
    const s = await dc.startSearch(dir, "needle", { filePattern: "*.txt" });
    assert.equal(s.totalMatches, 2);
    const all = await dc.startSearch(dir, "needle");
    assert.equal(all.totalMatches, 3);
    const page = await dc.getMoreSearchResults(all.id, 2, 1);
    assert.equal(page.results.length, 1);
    assert.deepEqual((await dc.listSearches()).map((x) => x.id).sort(), [all.id, s.id].sort());
    await dc.stopSearch(all.id);
    await assert.rejects(() => dc.getMoreSearchResults(all.id), /No active search/);
  });
  it("literal and case-insensitive searches, and files-mode by name", async () => {
    const dc = new DeskCommand(new FakeProc());
    await dc.writeFile(join(dir, "lit.txt"), "a+b and A+B");
    const lit = await dc.startSearch(dir, "a+b", { searchType: "literal" });
    assert.ok(lit.totalMatches >= 1);
    const ci = await dc.startSearch(dir, "NEEDLE", { ignoreCase: true });
    assert.ok(ci.totalMatches >= 1);
    const byName = await dc.startSearch(dir, "lit*", { searchType: "files" });
    assert.ok(byName.results.some((m) => m.text === "lit.txt"));
  });
  it("startSearch rejects a missing path and an empty pattern", async () => {
    const dc = new DeskCommand(new FakeProc());
    await assert.rejects(() => dc.startSearch(join(dir, "nope"), "x"), /not found/);
    await assert.rejects(() => dc.startSearch(dir, ""), /pattern is required/);
  });
});

describe("deskcommand processes (fake executor)", () => {
  it("process tools delegate to the executor", async () => {
    const fake = new FakeProc(); const dc = new DeskCommand(fake);
    const started = await dc.startProcess("sleep 60");
    assert.equal(started.pid, 4242); assert.match(started.output, /started: sleep 60/);
    assert.equal(await dc.interactWithProcess(4242, "hello"), "pid 4242 got: hello");
    assert.equal(await dc.readProcessOutput(4242), "output of 4242");
    assert.deepEqual(await dc.listSessions(), [{ pid: 4242, command: "sleep 60", running: true }]);
    assert.equal((await dc.listProcesses()).length, 2);
    await dc.killProcess(4242); await dc.forceTerminate(4242);
    assert.deepEqual(fake.killed, [4242, -4242]);
    await assert.rejects(() => dc.startProcess(""), /command is required/);
  });
});

describe("deskcommand config and bookkeeping", () => {
  it("config round-trips, prompts resolve, stats count real calls", async () => {
    const dc = new DeskCommand(new FakeProc());
    const cfg = await dc.setConfigValue("defaultShell", "/bin/bash");
    assert.equal(cfg.defaultShell, "/bin/bash");
    assert.equal((await dc.getConfig()).defaultShell, "/bin/bash");
    const prompts = await dc.getPrompts() as Array<{ id: string }>;
    assert.ok(prompts.length >= 2);
    const one = await dc.getPrompts("file-review") as { id: string };
    assert.equal(one.id, "file-review");
    await assert.rejects(() => dc.getPrompts("nope"), /No prompt with id/);
    assert.deepEqual(await dc.giveFeedback("useful"), { recorded: true });
    const stats = await dc.getUsageStats();
    assert.ok(stats.totalToolCalls >= 5);
    assert.equal(stats.feedbackCount, 1);
    const recent = await dc.getRecentToolCalls();
    assert.ok(recent.some((c) => c.tool === "set_config_value"));
  });
});
