# deskcommand — Build Report

MCP Rebuild 100, Wave 1 Batch 5 (final Tier A batch). Clean-room
rebuild of the "desktop-commander" target from its published tool
documentation. Local build only — nothing pushed or published.

Identity: repo `deskcommand`, npm `@reneturcios/deskcommand`,
MCP name `io.github.CloudCorpRecords/deskcommand`, version `0.1.0`.

## Files created (19/19 per TEMPLATE.md checklist)

- `package.json` — bin `deskcommand: dist/cli.js`, `mcpName` set
- `server.json` — description = **91 chars** (≤100 ✓, verified
  programmatically); npm entry carries `version: 0.1.0`; OCI entry
  `ghcr.io/cloudcorprecords/deskcommand:0.1.0` carries **no**
  `version` field (verified programmatically)
- `Dockerfile` — node:20-alpine two-stage, label
  `io.modelcontextprotocol.server.name="io.github.CloudCorpRecords/deskcommand"`
- `tsconfig.json`, `.gitignore`, `LICENSE` (MIT), `README.md`,
  `CHANGELOG.md` (single 0.1.0 entry, 2026-10-26)
- `src/index.ts`, `src/cli.ts`, `src/mcp.ts`, `src/types.ts`,
  `src/command.ts` (core: real filesystem/search + process executor)
- `test/command.test.ts`
- `.github/workflows/{ci,publish,publish-container,registry-publish}.yml`

## Implementation notes

- Twenty-six MCP tools: create_directory, edit_block,
  force_terminate, get_config, get_file_info,
  get_more_search_results, get_prompts, get_recent_tool_calls,
  get_usage_stats, give_feedback_to_desktop_commander,
  interact_with_process, kill_process, list_directory,
  list_processes, list_searches, list_sessions, move_file,
  read_file, read_multiple_files, read_process_output,
  set_config_value, start_process, start_search, stop_search,
  write_file, write_pdf.
- **Low-level Server API** with explicit inputSchema literals (not
  McpServer+zod — standing rule). Zod validates `tools/call` args.
- **Unlike the browser builds, the filesystem and search tools are
  real local implementations** (`node:fs`): line-range `read_file`,
  `edit_block` with unique-match / expected-count rules, and a
  recursive search that skips `node_modules`/`.git`/`dist`, skips
  binary files, and paginates through search sessions. Processes
  sit behind a `ProcessExecutor`; the default
  `ShellProcessExecutor` spawns real shell processes with buffered
  output and a session registry, and `list_processes` parses `ps`.
  Config, prompts, recent-calls and usage stats are honest
  in-memory server state.
- Simplifications, stated plainly: `write_pdf` writes the content
  as given (no PDF layout engine), and search runs synchronously
  in-process rather than as a streaming ripgrep session.

## Verification (exact outputs)

- Build: `tsc` exit 0 (one real TS2322 in `listDirectory` was
  caught and fixed during the batch); canonical `dist/` present
  with `.d.ts` / `.js.map`. (Mid-batch the VM write guard truncated
  an earlier dist; stock `tsc` was re-run after the guard lifted
  and parity + tests re-verified against the canonical dist.)
- Tests: `tsx --test` → tests 11, pass 11, fail 0. Note: the first
  run during the write-guard episode showed 3 pass / 8 fail with
  every failure `EPERM: operation not permitted, write` from the
  tests' temp-dir writes — environmental, not assertion failures;
  the clean re-run after the guard lifted passes 11/11.
- CLI smoke (live): `node dist/cli.js --version` → `0.1.0`;
  `node dist/cli.js ls src` listed the real source files.
- Parity: verdict **PASS**, parity_pct **100.0**, identical_tools
  **26/26**, schema_diffs {} (`parity-out/parity.json`, re-run
  2026-10-26T17:03:15Z against canonical dist). Original side:
  tools-file fixture
  `harness/fixtures/desktop-commander-tools-original.json`
  (docs-derived, labelled in its `_source`).

## Lockfile status

`package-lock.json` copied from pdfport with identity fields edited
(top-level `name`, root package `name`, bin key). Clean lockfile
regeneration is REQUIRED before publish — Blocker 3 in
SCOREBOARD.md. `node_modules` is a local `cp -a` copy; gitignored.

## Blockers / honest gaps

- `write_pdf` and synchronous-search simplifications, described
  above; config/prompts/usage are per-process in-memory state, not
  persisted like the original's on-disk config.
- Ground truth is docs-derived, not hand-probed; parity proves
  match to the documented tool spec. The filesystem/search/process
  behaviour itself IS exercised for real by the unit tests and the
  CLI smoke (this build has no unavailable-executor carve-out).
- Container build not exercised locally; the publish-container
  workflow smoke-tests initialize/usage at publish time.
- mcpaudit / mcpvet / shipcheck pre-publish gate not run — publish
  wave scope, not claimed here.
