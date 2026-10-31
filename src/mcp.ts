/**
 * deskcommand MCP server. The 26 published tools: create_directory,
 * edit_block, force_terminate, get_config, get_file_info,
 * get_more_search_results, get_prompts, get_recent_tool_calls,
 * get_usage_stats, give_feedback_to_desktop_commander,
 * interact_with_process, kill_process, list_directory,
 * list_processes, list_searches, list_sessions, move_file,
 * read_file, read_multiple_files, read_process_output,
 * set_config_value, start_process, start_search, stop_search,
 * write_file, write_pdf.
 *
 * Why the low-level Server instead of McpServer: the high-level
 * helper converts zod schemas to JSON Schema and injects two keys
 * that are not in this toolset's public spec ("$schema" and
 * "additionalProperties"), which breaks exact tool-list/schema
 * parity with the spec. This file therefore serves tools/list with
 * the spec's exact input schemas, while zod still validates every
 * tools/call argument set.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { DeskCommand, VERSION } from "./command.js";

const S = z.string();
const PathArgs = z.object({ path: S });
const PidArgs = z.object({ pid: z.number() });
const EditArgs = z.object({ file_path: S, old_string: S, new_string: S, expected_replacements: z.number().optional() });
const MoreSearchArgs = z.object({ sessionId: S, offset: z.number().optional(), length: z.number().optional() });
const PromptsArgs = z.object({ promptId: S.optional() });
const FeedbackArgs = z.object({ message: S });
const InteractArgs = z.object({ pid: z.number(), input: S, timeout_ms: z.number().optional() });
const ReadOutputArgs = z.object({ pid: z.number(), timeout_ms: z.number().optional() });
const MoveArgs = z.object({ source: S, destination: S });
const ReadFileArgs = z.object({ path: S, offset: z.number().optional(), length: z.number().optional() });
const ReadMultiArgs = z.object({ paths: z.array(S) });
const SetConfigArgs = z.object({ key: S, value: S });
const StartProcessArgs = z.object({ command: S, timeout_ms: z.number().optional(), shell: S.optional() });
const StartSearchArgs = z.object({ path: S, pattern: S, searchType: S.optional(), filePattern: S.optional(), ignoreCase: z.boolean().optional(), maxResults: z.number().optional() });
const StopSearchArgs = z.object({ searchId: S });
const WriteArgs = z.object({ path: S, content: S });
const EmptyArgs = z.object({});

const str = { type: "string" as const };
const num = { type: "number" as const };
const bool = { type: "boolean" as const };
const TOOLS = [
  { name: "create_directory", description: "Create a new directory or ensure a directory exists, including nested paths", inputSchema: { type: "object" as const, properties: { path: { type: "string", description: "The directory path to create or ensure exists" } }, required: ["path"] } },
  { name: "edit_block", description: "Apply a surgical text replacement in a file: replace old_string with new_string", inputSchema: { type: "object" as const, properties: { expected_replacements: { type: "number", description: "Optional expected number of replacements; the edit fails if the actual count differs" }, file_path: { type: "string", description: "The path of the file to edit" }, new_string: { type: "string", description: "The text to replace old_string with" }, old_string: { type: "string", description: "The exact text in the file to replace" } }, required: ["file_path", "old_string", "new_string"] } },
  { name: "force_terminate", description: "Force terminate a running terminal process session", inputSchema: { type: "object" as const, properties: { pid: { type: "number", description: "The PID of the terminal process session to force terminate" } }, required: ["pid"] } },
  { name: "get_config", description: "Get the current server configuration", inputSchema: { type: "object" as const, properties: {}, required: [] } },
  { name: "get_file_info", description: "Retrieve detailed metadata about a file or directory", inputSchema: { type: "object" as const, properties: { path: { type: "string", description: "The path of the file or directory to describe" } }, required: ["path"] } },
  { name: "get_more_search_results", description: "Get more results from an active search session", inputSchema: { type: "object" as const, properties: { length: { type: "number", description: "Optional number of results to return" }, offset: { type: "number", description: "Optional result offset to page from" }, sessionId: { type: "string", description: "The search session id returned by start_search" } }, required: ["sessionId"] } },
  { name: "get_prompts", description: "Get available prompts, or one prompt by id", inputSchema: { type: "object" as const, properties: { promptId: { type: "string", description: "Optional prompt id to fetch a single prompt; all available prompts are returned when omitted" } }, required: [] } },
  { name: "get_recent_tool_calls", description: "Get the recent tool calls recorded by this server", inputSchema: { type: "object" as const, properties: {}, required: [] } },
  { name: "get_usage_stats", description: "Get usage statistics for this server", inputSchema: { type: "object" as const, properties: {}, required: [] } },
  { name: "give_feedback_to_desktop_commander", description: "Record feedback about this tool for later review", inputSchema: { type: "object" as const, properties: { message: { type: "string", description: "The feedback message to record" } }, required: ["message"] } },
  { name: "interact_with_process", description: "Send input to a running process and wait for its response", inputSchema: { type: "object" as const, properties: { input: { type: "string", description: "The input text to send to the process" }, pid: { type: "number", description: "The PID of the running process to interact with" }, timeout_ms: { type: "number", description: "Optional milliseconds to wait for the process response" } }, required: ["pid", "input"] } },
  { name: "kill_process", description: "Terminate a process by its PID", inputSchema: { type: "object" as const, properties: { pid: { type: "number", description: "The PID of the process to terminate" } }, required: ["pid"] } },
  { name: "list_directory", description: "Get a detailed listing of all files and directories at a path", inputSchema: { type: "object" as const, properties: { path: { type: "string", description: "The directory path to list" } }, required: ["path"] } },
  { name: "list_processes", description: "List all running processes with their PID, command and status", inputSchema: { type: "object" as const, properties: {}, required: [] } },
  { name: "list_searches", description: "List all active search sessions", inputSchema: { type: "object" as const, properties: {}, required: [] } },
  { name: "list_sessions", description: "List all active terminal sessions", inputSchema: { type: "object" as const, properties: {}, required: [] } },
  { name: "move_file", description: "Move or rename a file or directory", inputSchema: { type: "object" as const, properties: { destination: { type: "string", description: "The new path for the file or directory" }, source: { type: "string", description: "The current path of the file or directory to move" } }, required: ["source", "destination"] } },
  { name: "read_file", description: "Read the complete contents of a file, optionally a line range", inputSchema: { type: "object" as const, properties: { length: { type: "number", description: "Optional number of lines to read" }, offset: { type: "number", description: "Optional starting line offset to read from" }, path: { type: "string", description: "The path of the file to read" } }, required: ["path"] } },
  { name: "read_multiple_files", description: "Read the contents of multiple files simultaneously", inputSchema: { type: "object" as const, properties: { paths: { type: "array", items: { type: "string" }, description: "The paths of the files to read" } }, required: ["paths"] } },
  { name: "read_process_output", description: "Read output from a running process, waiting up to a timeout for new output", inputSchema: { type: "object" as const, properties: { pid: { type: "number", description: "The PID of the process whose output to read" }, timeout_ms: { type: "number", description: "Optional milliseconds to wait for new output" } }, required: ["pid"] } },
  { name: "set_config_value", description: "Set a configuration value by key", inputSchema: { type: "object" as const, properties: { key: { type: "string", description: "The configuration key to set" }, value: { type: "string", description: "The value to set for the configuration key" } }, required: ["key", "value"] } },
  { name: "start_process", description: "Start a new terminal process in a shell and return its initial output", inputSchema: { type: "object" as const, properties: { command: { type: "string", description: "The command line to start in the shell" }, shell: { type: "string", description: "Optional shell to run the command with" }, timeout_ms: { type: "number", description: "Optional milliseconds to wait for the process's initial output" } }, required: ["command"] } },
  { name: "start_search", description: "Start a search for a pattern in files under a path and return a session id", inputSchema: { type: "object" as const, properties: { filePattern: { type: "string", description: "Optional glob pattern limiting which files are searched" }, ignoreCase: { type: "boolean", description: "Whether the search ignores case" }, maxResults: { type: "number", description: "Optional maximum number of results to return" }, path: { type: "string", description: "The directory path to search under" }, pattern: { type: "string", description: "The pattern to search for" }, searchType: { type: "string", description: "Optional search type: 'files' searches file names, 'literal' matches the pattern literally, otherwise the pattern is treated as a regular expression over file contents" } }, required: ["path", "pattern"] } },
  { name: "stop_search", description: "Stop an active search by its session id", inputSchema: { type: "object" as const, properties: { searchId: { type: "string", description: "The search session id returned by start_search" } }, required: ["searchId"] } },
  { name: "write_file", description: "Create a new file or completely overwrite an existing file with new content", inputSchema: { type: "object" as const, properties: { content: { type: "string", description: "The full content to write to the file" }, path: { type: "string", description: "The path of the file to create or overwrite" } }, required: ["path", "content"] } },
  { name: "write_pdf", description: "Write text content to a file at a path (PDF-oriented in the original; this rebuild writes the content as given)", inputSchema: { type: "object" as const, properties: { content: { type: "string", description: "The content to write to the file" }, path: { type: "string", description: "The path of the file to write" } }, required: ["path", "content"] } },
];

function textResult(value: unknown) {
  return { content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] };
}
function errorResult(err: unknown) {
  return { content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }], isError: true };
}

const dc = new DeskCommand();
const server = new Server({ name: "deskcommand", version: VERSION }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    switch (name) {
      case "create_directory": return textResult(await dc.createDirectory(PathArgs.parse(args ?? {}).path));
      case "edit_block": { const p = EditArgs.parse(args ?? {}); return textResult(await dc.editBlock(p.file_path, p.old_string, p.new_string, p.expected_replacements)); }
      case "force_terminate": return textResult(await dc.forceTerminate(PidArgs.parse(args ?? {}).pid));
      case "get_config": EmptyArgs.parse(args ?? {}); return textResult(await dc.getConfig());
      case "get_file_info": return textResult(await dc.getFileInfo(PathArgs.parse(args ?? {}).path));
      case "get_more_search_results": { const p = MoreSearchArgs.parse(args ?? {}); return textResult(await dc.getMoreSearchResults(p.sessionId, p.offset, p.length)); }
      case "get_prompts": return textResult(await dc.getPrompts(PromptsArgs.parse(args ?? {}).promptId));
      case "get_recent_tool_calls": EmptyArgs.parse(args ?? {}); return textResult(await dc.getRecentToolCalls());
      case "get_usage_stats": EmptyArgs.parse(args ?? {}); return textResult(await dc.getUsageStats());
      case "give_feedback_to_desktop_commander": return textResult(await dc.giveFeedback(FeedbackArgs.parse(args ?? {}).message));
      case "interact_with_process": { const p = InteractArgs.parse(args ?? {}); return textResult(await dc.interactWithProcess(p.pid, p.input, p.timeout_ms)); }
      case "kill_process": return textResult(await dc.killProcess(PidArgs.parse(args ?? {}).pid));
      case "list_directory": return textResult(await dc.listDirectory(PathArgs.parse(args ?? {}).path));
      case "list_processes": EmptyArgs.parse(args ?? {}); return textResult(await dc.listProcesses());
      case "list_searches": EmptyArgs.parse(args ?? {}); return textResult(await dc.listSearches());
      case "list_sessions": EmptyArgs.parse(args ?? {}); return textResult(await dc.listSessions());
      case "move_file": { const p = MoveArgs.parse(args ?? {}); return textResult(await dc.moveFile(p.source, p.destination)); }
      case "read_file": { const p = ReadFileArgs.parse(args ?? {}); return textResult(await dc.readFile(p.path, p.offset, p.length)); }
      case "read_multiple_files": return textResult(await dc.readMultipleFiles(ReadMultiArgs.parse(args ?? {}).paths));
      case "read_process_output": { const p = ReadOutputArgs.parse(args ?? {}); return textResult(await dc.readProcessOutput(p.pid, p.timeout_ms)); }
      case "set_config_value": { const p = SetConfigArgs.parse(args ?? {}); return textResult(await dc.setConfigValue(p.key, p.value)); }
      case "start_process": { const p = StartProcessArgs.parse(args ?? {}); return textResult(await dc.startProcess(p.command, p)); }
      case "start_search": { const p = StartSearchArgs.parse(args ?? {}); return textResult(await dc.startSearch(p.path, p.pattern, p)); }
      case "stop_search": return textResult(await dc.stopSearch(StopSearchArgs.parse(args ?? {}).searchId));
      case "write_file": { const p = WriteArgs.parse(args ?? {}); return textResult(await dc.writeFile(p.path, p.content)); }
      case "write_pdf": { const p = WriteArgs.parse(args ?? {}); return textResult(await dc.writePdf(p.path, p.content)); }
    }
  } catch (err) { return errorResult(err); }
  throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
});

async function main(): Promise<void> { await server.connect(new StdioServerTransport()); }
void main();
