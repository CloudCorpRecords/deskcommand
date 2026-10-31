/**
 * deskcommand core: 26 local-machine tools.
 *
 * Filesystem and search are REAL local implementations over
 * node:fs/promises: read/write files (with line-range reads),
 * create/move/list directories, file metadata, surgical edit_block
 * replacements with an expected-count check, and a synchronous
 * recursive pattern search (node_modules/.git/dist skipped,
 * binary-ish files skipped) whose sessions paginate.
 *
 * Terminal/process tools go through the injectable ProcessExecutor.
 * The default executor spawns real shell processes, buffers their
 * output, and tracks sessions; read_process_output returns only
 * output not yet read. list_processes parses `ps`.
 *
 * Config, prompts, recent-call and usage bookkeeping are honest
 * in-memory state for this server process - get_config shows what
 * set_config_value actually set, get_recent_tool_calls lists the
 * calls this core actually served, and get_usage_stats counts
 * them. Feedback is recorded in memory and acknowledged.
 *
 * Simplifications vs the original, stated plainly: write_pdf
 * writes the given content as-is (no PDF layout engine), and
 * search runs synchronously in-process rather than streaming from
 * a ripgrep subprocess (start it, then page the finished session).
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type {
  DirEntry, FileInfo, ProcessExecutor, ProcessInfo, ProcessStartResult,
  SearchMatch, SearchSession, SessionInfo, ToolCallRecord,
} from "./types.js";

export const VERSION = "0.1.0";

/* ---------------- default process executor ---------------- */

interface Session {
  pid: number;
  command: string;
  child: ChildProcess;
  buffer: string;
  cursor: number;
  running: boolean;
}

export class ShellProcessExecutor implements ProcessExecutor {
  private readonly sessions = new Map<number, Session>();

  private collect(session: Session, timeoutMs: number, fresh: boolean): Promise<string> {
    return new Promise((resolve) => {
      const started = session.cursor;
      const deadline = Date.now() + timeoutMs;
      const tick = () => {
        const produced = session.buffer.length > (fresh ? started : session.cursor);
        if (produced || !session.running || Date.now() >= deadline) {
          const from = fresh ? started : session.cursor;
          const out = session.buffer.slice(from);
          session.cursor = session.buffer.length;
          resolve(out);
          return;
        }
        setTimeout(tick, 25);
      };
      tick();
    });
  }

  async start(command: string, opts?: { timeout_ms?: number; shell?: string }): Promise<ProcessStartResult> {
    const child = spawn(opts?.shell ?? "/bin/sh", ["-c", command], { stdio: ["pipe", "pipe", "pipe"] });
    if (child.pid === undefined) throw new Error(`Failed to start process: ${command}`);
    const session: Session = { pid: child.pid, command, child, buffer: "", cursor: 0, running: true };
    child.stdout?.on("data", (d: Buffer) => { session.buffer += d.toString(); });
    child.stderr?.on("data", (d: Buffer) => { session.buffer += d.toString(); });
    child.on("close", () => { session.running = false; });
    this.sessions.set(child.pid, session);
    const output = await this.collect(session, opts?.timeout_ms ?? 1000, true);
    return { pid: child.pid, output };
  }

  private session(pid: number): Session {
    const s = this.sessions.get(pid);
    if (!s) throw new Error(`No terminal session with pid ${pid}`);
    return s;
  }

  async interact(pid: number, input: string, timeout_ms?: number): Promise<string> {
    const s = this.session(pid);
    if (!s.running) throw new Error(`Process ${pid} is no longer running`);
    s.child.stdin?.write(input.endsWith("\n") ? input : input + "\n");
    return this.collect(s, timeout_ms ?? 1000, false);
  }

  async readOutput(pid: number, timeout_ms?: number): Promise<string> {
    const s = this.session(pid);
    return this.collect(s, timeout_ms ?? 1000, false);
  }

  async listSessions(): Promise<SessionInfo[]> {
    return [...this.sessions.values()].map((s) => ({ pid: s.pid, command: s.command, running: s.running }));
  }

  async listProcesses(): Promise<ProcessInfo[]> {
    const out = await new Promise<string>((resolve, reject) => {
      execFile("ps", ["-eo", "pid=,comm="], (err, stdout) => (err ? reject(err) : resolve(stdout)));
    });
    return out.split("\n").filter(Boolean).map((line) => {
      const m = line.trim().match(/^(\d+)\s+(.*)$/);
      return m ? { pid: Number(m[1]), command: m[2] } : { pid: 0, command: line.trim() };
    }).filter((p) => p.pid > 0);
  }

  async kill(pid: number): Promise<void> {
    const s = this.sessions.get(pid);
    if (s) { s.child.kill("SIGTERM"); s.running = false; return; }
    try { process.kill(pid, "SIGTERM"); } catch { throw new Error(`No such process: ${pid}`); }
  }

  async forceTerminate(pid: number): Promise<void> {
    const s = this.sessions.get(pid);
    if (s) { s.child.kill("SIGKILL"); s.running = false; return; }
    try { process.kill(pid, "SIGKILL"); } catch { throw new Error(`No such process: ${pid}`); }
  }
}

/* ---------------- core ---------------- */

const SKIP_DIRS = new Set(["node_modules", ".git", "dist"]);

function globToRegExp(glob: string): RegExp {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${esc}$`);
}

export class DeskCommand {
  private readonly proc: ProcessExecutor;
  private readonly config = new Map<string, string>([
    ["blockedCommands", "[]"],
    ["allowedDirectories", "[]"],
    ["defaultShell", "/bin/sh"],
  ]);
  private readonly searches = new Map<string, SearchSession>();
  private searchSeq = 0;
  private readonly calls: ToolCallRecord[] = [];
  private readonly feedback: string[] = [];

  constructor(proc: ProcessExecutor = new ShellProcessExecutor()) { this.proc = proc; }

  private record(tool: string): void { this.calls.push({ tool, at: new Date().toISOString() }); }

  /* config / bookkeeping */
  async getConfig(): Promise<Record<string, string>> { this.record("get_config"); return Object.fromEntries(this.config); }
  async setConfigValue(key: string, value: string): Promise<Record<string, string>> {
    this.record("set_config_value");
    if (!key) throw new Error("key is required");
    this.config.set(key, value);
    return Object.fromEntries(this.config);
  }
  async getPrompts(promptId?: string): Promise<unknown> {
    this.record("get_prompts");
    const all = [
      { id: "file-review", title: "Review a file", text: "Read the file at {path} and summarise what it does, flagging anything surprising." },
      { id: "search-topic", title: "Search a topic", text: "Search under {path} for {pattern} and group the matches by file." },
    ];
    if (promptId) {
      const found = all.find((p) => p.id === promptId);
      if (!found) throw new Error(`No prompt with id: ${promptId}`);
      return found;
    }
    return all;
  }
  async getRecentToolCalls(): Promise<ToolCallRecord[]> { return [...this.calls].slice(-50); }
  async getUsageStats(): Promise<Record<string, number>> {
    this.record("get_usage_stats");
    const stats: Record<string, number> = { totalToolCalls: this.calls.length, feedbackCount: this.feedback.length, activeSearches: this.searches.size };
    for (const c of this.calls) stats[`calls:${c.tool}`] = (stats[`calls:${c.tool}`] ?? 0) + 1;
    return stats;
  }
  async giveFeedback(message: string): Promise<{ recorded: true }> {
    this.record("give_feedback_to_desktop_commander");
    if (!message) throw new Error("message is required");
    this.feedback.push(message);
    return { recorded: true };
  }

  /* filesystem */
  async createDirectory(path: string): Promise<{ path: string; created: true }> {
    this.record("create_directory");
    await mkdir(path, { recursive: true });
    return { path, created: true };
  }
  async listDirectory(path: string): Promise<DirEntry[]> {
    this.record("list_directory");
    const entries = await readdir(path, { withFileTypes: true });
    return entries.map((e): DirEntry => ({ name: e.name, type: e.isDirectory() ? "directory" : e.isFile() ? "file" : "other" })).sort((a, b) => a.name.localeCompare(b.name));
  }
  async readFile(path: string, offset?: number, length?: number): Promise<string> {
    this.record("read_file");
    const content = await readFile(path, "utf8");
    if (offset === undefined && length === undefined) return content;
    const lines = content.split("\n");
    const start = offset ?? 0;
    return lines.slice(start, length === undefined ? undefined : start + length).join("\n");
  }
  async readMultipleFiles(paths: string[]): Promise<Record<string, string>> {
    this.record("read_multiple_files");
    const out: Record<string, string> = {};
    for (const p of paths) {
      try { out[p] = await readFile(p, "utf8"); }
      catch (err) { out[p] = `Error reading file: ${err instanceof Error ? err.message : String(err)}`; }
    }
    return out;
  }
  async writeFile(path: string, content: string): Promise<{ path: string; bytes: number }> {
    this.record("write_file");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf8");
    return { path, bytes: Buffer.byteLength(content, "utf8") };
  }
  async writePdf(path: string, content: string): Promise<{ path: string; bytes: number }> {
    this.record("write_pdf");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf8");
    return { path, bytes: Buffer.byteLength(content, "utf8") };
  }
  async moveFile(source: string, destination: string): Promise<{ source: string; destination: string }> {
    this.record("move_file");
    await mkdir(dirname(destination), { recursive: true });
    await rename(source, destination);
    return { source, destination };
  }
  async getFileInfo(path: string): Promise<FileInfo> {
    this.record("get_file_info");
    const s = await stat(path);
    return {
      path,
      type: s.isDirectory() ? "directory" : s.isFile() ? "file" : "other",
      size: s.size,
      created: s.birthtime.toISOString(),
      modified: s.mtime.toISOString(),
      permissions: (s.mode & 0o777).toString(8),
    };
  }
  async editBlock(filePath: string, oldString: string, newString: string, expectedReplacements?: number): Promise<{ path: string; replacements: number }> {
    this.record("edit_block");
    if (!oldString) throw new Error("old_string must not be empty");
    const content = await readFile(filePath, "utf8");
    const count = content.split(oldString).length - 1;
    if (count === 0) throw new Error(`old_string not found in ${filePath}`);
    if (expectedReplacements !== undefined && count !== expectedReplacements) {
      throw new Error(`Expected ${expectedReplacements} replacements but found ${count} occurrence(s) in ${filePath}`);
    }
    if (count > 1 && expectedReplacements === undefined) {
      throw new Error(`old_string occurs ${count} times in ${filePath}; pass expected_replacements to replace all of them, or make old_string unique`);
    }
    const updated = content.split(oldString).join(newString);
    await writeFile(filePath, updated, "utf8");
    return { path: filePath, replacements: count };
  }

  /* terminal / processes */
  async startProcess(command: string, opts?: { timeout_ms?: number; shell?: string }): Promise<ProcessStartResult> {
    this.record("start_process");
    if (!command) throw new Error("command is required");
    return this.proc.start(command, opts);
  }
  async interactWithProcess(pid: number, input: string, timeout_ms?: number): Promise<string> {
    this.record("interact_with_process");
    return this.proc.interact(pid, input, timeout_ms);
  }
  async readProcessOutput(pid: number, timeout_ms?: number): Promise<string> {
    this.record("read_process_output");
    return this.proc.readOutput(pid, timeout_ms);
  }
  async listSessions(): Promise<SessionInfo[]> { this.record("list_sessions"); return this.proc.listSessions(); }
  async listProcesses(): Promise<ProcessInfo[]> { this.record("list_processes"); return this.proc.listProcesses(); }
  async killProcess(pid: number): Promise<{ pid: number; killed: true }> {
    this.record("kill_process");
    await this.proc.kill(pid);
    return { pid, killed: true };
  }
  async forceTerminate(pid: number): Promise<{ pid: number; terminated: true }> {
    this.record("force_terminate");
    await this.proc.forceTerminate(pid);
    return { pid, terminated: true };
  }

  /* search */
  async startSearch(path: string, pattern: string, opts?: { searchType?: string; filePattern?: string; ignoreCase?: boolean; maxResults?: number }): Promise<SearchSession & { resultsPage: SearchMatch[] }> {
    this.record("start_search");
    if (!pattern) throw new Error("pattern is required");
    const literal = opts?.searchType === "files" ? false : opts?.searchType === "literal";
    const flags = opts?.ignoreCase ? "i" : "";
    let regex: RegExp;
    if (opts?.searchType === "files") {
      regex = globToRegExp(pattern);
    } else if (literal) {
      regex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);
    } else {
      regex = new RegExp(pattern, flags);
    }
    const fileRe = opts?.filePattern ? globToRegExp(opts.filePattern) : null;
    const max = opts?.maxResults ?? 1000;
    const results: SearchMatch[] = [];
    const walk = async (dir: string): Promise<void> => {
      if (results.length >= max) return;
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const e of entries) {
        if (results.length >= max) return;
        const full = join(dir, e.name);
        if (e.isDirectory()) {
          if (!SKIP_DIRS.has(e.name)) await walk(full);
        } else if (e.isFile()) {
          if (opts?.searchType === "files") {
            if (regex.test(e.name)) results.push({ file: full, line: 0, text: e.name });
            continue;
          }
          if (fileRe && !fileRe.test(e.name)) continue;
          const content = await readFile(full, "utf8").catch(() => null);
          if (content === null || content.includes("\u0000")) continue;
          const lines = content.split("\n");
          lines.forEach((line, i) => {
            if (results.length < max && regex.test(line)) results.push({ file: full, line: i + 1, text: line.trim().slice(0, 300) });
          });
        }
      }
    };
    const rootStat = await stat(path).catch(() => null);
    if (!rootStat) throw new Error(`Search path not found: ${path}`);
    if (rootStat.isFile()) {
      const content = await readFile(path, "utf8");
      content.split("\n").forEach((line, i) => { if (regex.test(line)) results.push({ file: path, line: i + 1, text: line.trim().slice(0, 300) }); });
    } else {
      await walk(path);
    }
    const id = `search-${++this.searchSeq}`;
    const session: SearchSession = { id, pattern, path, totalMatches: results.length, results };
    this.searches.set(id, session);
    return { ...session, resultsPage: results.slice(0, 20) };
  }
  async getMoreSearchResults(sessionId: string, offset = 0, length = 20): Promise<{ sessionId: string; totalMatches: number; results: SearchMatch[] }> {
    this.record("get_more_search_results");
    const s = this.searches.get(sessionId);
    if (!s) throw new Error(`No active search with id: ${sessionId}`);
    return { sessionId, totalMatches: s.totalMatches, results: s.results.slice(offset, offset + length) };
  }
  async listSearches(): Promise<Array<{ id: string; pattern: string; totalMatches: number }>> {
    this.record("list_searches");
    return [...this.searches.values()].map((s) => ({ id: s.id, pattern: s.pattern, totalMatches: s.totalMatches }));
  }
  async stopSearch(searchId: string): Promise<{ searchId: string; stopped: true }> {
    this.record("stop_search");
    if (!this.searches.delete(searchId)) throw new Error(`No active search with id: ${searchId}`);
    return { searchId, stopped: true };
  }
}

export { basename };
