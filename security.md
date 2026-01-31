Sparrow Security Notes

CLI Tool Access (cli)
- Purpose: Provide a sandboxed, read-only shell for inspection and safe queries.
- Supported features: multiple commands per call, cd, and a lightweight session with working directory state.
- Allowed commands: ls, pwd, whoami, date, uname, uptime, df, free, id, echo, rg, find, cat, head, tail, wc, stat, sort, uniq, cut, tr, sed (no -i), grep.
- Git (read-only): status, diff, log, branch, rev-parse, show, ls-files, remote -v. Supports `git -C <path>` within allowed roots.
- Disallowed: sudo/root escalation, write/modification commands, shell operators (e.g., &&, |, ;, >), and destructive utilities.
- Paths: Any path-like argument must resolve within either the current working directory or ~/.sparrow.
- Execution: Runs via execFile (no shell). Timeouts after 5 seconds. Output capped to 12 KB.

File Access (filesystem)
- Scope: Restricted to ~/.sparrow by default.
- Actions: read, write, list, read_pdf_text, read_docx_text, write_pdf.

Network Access
- Outbound calls are limited to the OpenAI API and approved function tools.
