Sparrow Security Notes

CLI Tool Access (cli)
- Purpose: Provide a sandboxed, read-only shell for inspection and safe queries.
- Supported features: multiple commands per call, cd, and a lightweight session with working directory state.
- Allowed commands: ls, pwd, whoami, date, uname, uptime, df, free, id, echo, true, rg, grep, awk, jq, tree, fd, bat, find, cat, head, tail, wc, stat, realpath, readlink, du, ps, top, lsblk, sort, uniq, cut, tr, sed (no -i).
- Git (read-only): status, diff, log, branch, rev-parse, show, ls-files, remote -v, blame. Supports `git -C <path>` within allowed roots.
- Disallowed: sudo/root escalation, write/modification commands, destructive utilities, and shell operators except pipe (|), single fallback (cmd1 || cmd2), and &&. Redirects are only allowed to /dev/null.
- Paths: Any path-like argument must resolve within either the current working directory or ~/.sparrow.
- Execution: Runs via execFile (no shell). Timeouts after 5 seconds. Output capped to 12 KB.

Code Search (code_search)
- Purpose: fast text search using rg (or grep fallback).
- Scope: path must be within allowed roots (cwd or ~/.sparrow).

File Snippet (file_snippet)
- Purpose: read small line ranges from files.
- Limits: max 200KB read per request; line ranges enforced.

File Diff (file_diff)
- Purpose: unified diffs between two files within allowed roots.

Process List (process_list)
- Purpose: read-only top processes via ps.

Disk Usage (disk_usage)
- Purpose: read-only df/du summaries within allowed roots.

Service Status (service_status)
- Purpose: read-only systemd status/logs (systemctl/journalctl).

Dependency Map (dependency_map)
- Purpose: parse package.json dependencies within allowed roots.

Project Summary (project_summary)
- Purpose: list project folders and git summaries under a root.

Doc Index (doc_index)
- Purpose: index/search local docs by filename (md/txt/pdf/docx).
- Storage: index saved in ~/.sparrow/doc_index.json.

Task Runner (task_runner)
- Purpose: run allowlisted tasks only; requires confirm=true.
- Config: tasks.allowlist entries (id, command, args, cwd).

Snapshot (snapshot)
- Purpose: quick OS + project snapshot using project_summary.

File Access (filesystem)
- Scope: Restricted to ~/.sparrow by default.
- Actions: read, write, list, read_pdf_text, read_docx_text, write_pdf.

Network Access
- Outbound calls are limited to the OpenAI API and approved function tools.
