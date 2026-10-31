# deskcommand

Work on the local machine from the command line or as a stdio MCP
server: start and drive terminal processes, read and write files,
make surgical text edits, move files, inspect metadata, and search
file contents — with configuration, usage and recent-call tools
alongside.

Filesystem and search are real local implementations. Search runs
as a session: `start_search` walks the tree (skipping
node_modules, .git and dist) and returns a session id whose
results paginate with `get_more_search_results`. `edit_block`
replaces an exact text block and refuses ambiguous edits — a block
that occurs more than once needs an explicit expected count.
Terminal processes run behind an injectable executor; the default
spawns real shell processes and buffers their output, so
`read_process_output` returns only output you have not seen yet.

Two honest simplifications against the toolset this is modelled
on: `write_pdf` writes the given content as-is (no PDF layout
engine), and search executes synchronously in-process rather than
streaming from a ripgrep subprocess.

## Install

```bash
npx -y @reneturcios/deskcommand mcp
```

## CLI

```bash
deskcommand mcp
deskcommand ls <path>
deskcommand read <path>
deskcommand run <command...>
deskcommand search <path> <pattern>
deskcommand --version
```

Exit codes: 0 success, 1 operation error, 2 usage error.

## MCP tools

26 tools: `create_directory`, `edit_block`, `force_terminate`,
`get_config`, `get_file_info`, `get_more_search_results`,
`get_prompts`, `get_recent_tool_calls`, `get_usage_stats`,
`give_feedback_to_desktop_commander`, `interact_with_process`,
`kill_process`, `list_directory`, `list_processes`,
`list_searches`, `list_sessions`, `move_file`, `read_file`,
`read_multiple_files`, `read_process_output`, `set_config_value`,
`start_process`, `start_search`, `stop_search`, `write_file`,
`write_pdf`.

MCP client config:

```json
{
  "mcpServers": {
    "deskcommand": {
      "command": "npx",
      "args": ["-y", "@reneturcios/deskcommand", "mcp"]
    }
  }
}
```

## Docker

```bash
docker run -i ghcr.io/cloudcorprecords/deskcommand          # MCP server
docker run --rm ghcr.io/cloudcorprecords/deskcommand --version
```

## Development

```bash
npm install
npm run build
npm test
```

MIT license.
