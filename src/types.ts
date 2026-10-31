/**
 * deskcommand types.
 *
 * Filesystem and search operations are implemented directly in
 * the core (command.ts) over node:fs. Terminal/process operations
 * go through the ProcessExecutor interface so they are testable
 * with a fake; the default executor spawns real shell processes
 * and tracks their sessions and output buffers.
 */

export interface ProcessStartResult { pid: number; output: string }
export interface SessionInfo { pid: number; command: string; running: boolean }
export interface ProcessInfo { pid: number; command: string }

export interface ProcessExecutor {
  start(command: string, opts?: { timeout_ms?: number; shell?: string }): Promise<ProcessStartResult>;
  interact(pid: number, input: string, timeout_ms?: number): Promise<string>;
  readOutput(pid: number, timeout_ms?: number): Promise<string>;
  listSessions(): Promise<SessionInfo[]>;
  listProcesses(): Promise<ProcessInfo[]>;
  kill(pid: number): Promise<void>;
  forceTerminate(pid: number): Promise<void>;
}

export interface FileInfo {
  path: string;
  type: "file" | "directory" | "other";
  size: number;
  created: string;
  modified: string;
  permissions: string;
}

export interface DirEntry { name: string; type: "file" | "directory" | "other" }

export interface SearchMatch { file: string; line: number; text: string }
export interface SearchSession {
  id: string;
  pattern: string;
  path: string;
  totalMatches: number;
  results: SearchMatch[];
}

export interface ToolCallRecord { tool: string; at: string }
