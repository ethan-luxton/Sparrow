# cli
## Purpose
Run safe, read-only shell commands within allowed roots for inspection and diagnostics.

## When to use
- List files or inspect directories
- Run read-only commands (rg, ls, cat, git status, etc.)
- Gather system details not covered by other tools

## Inputs
- action: "start" | "run" | "end" | "pwd"
- commands: string[] (for action=run)
- command/args: alternative single command form
- cwd: starting directory
- sessionId: reuse a session

Example
- action=run, commands=["ls -1", "rg -n \"TODO\" src"]

## Outputs
- Combined stdout/stderr for each command
- Errors if command not allowed or invalid

## Safety and constraints
- Read-only allowlist; blocks writes, sudo, rm, mv, chmod, etc.
- Only |, &&, and one fallback (cmd1 || cmd2) are allowed
- Redirects only to /dev/null

## Common patterns
- Inspect repo: ls -1, git status, rg -n "pattern" src
- Find files: find . -maxdepth 2 -type f -name "*.md"
- Quick system info: uname, df -h, uptime

## Failure modes
- "Command not allowed" if outside allowlist
- "Shell operators are not allowed" if using ; or redirects
- "Path outside allowed roots" if path escapes
