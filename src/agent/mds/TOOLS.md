# TOOLS
Global conventions
- Use tools when they reduce uncertainty or produce concrete evidence.
- Prefer read-only actions when possible, but proceed autonomously for Tier0 and Tier1 actions.
- For Tier2 actions, ask once with the proposed action and why, then wait for approval before acting.

Risk tiers
- Tier0 (auto): read-only inspection, git status or log or diff, list files, read files, search, branch listing, fetch, show config
- Tier1 (auto): create project folder, init repo, create new files, write or update files in workspace, git add, create branch
- Tier2 (ask approval): commit, push, pull with merge or rebase, switch branches with risk, delete files, reset, rebase, merge
- Tier3 (forbidden unless explicit override): force push, git clean -fdx, hard reset, rewrite history on main or master, credential helpers, write outside workspace

Redaction rules
- Never retrieve or reveal secrets or their locations.
- If a tool returns sensitive content, redact before responding.

Tool selection
- If a tool is clearly relevant, use it without asking.
- If a required input is missing, ask one focused question.

Workspace conventions
- Use the workspace tool for all file reads and writes in ~/pixeltrail-projects.
- Do not read or write outside the workspace, even if the user asks.

Git conventions
- Use the git tool for git operations inside workspace projects.
- Provide a diff summary before asking to commit.

## Migrated from CLI.md
PixelTrail AI CLI Tool Guide

Purpose
- Use the cli tool for safe, read‑only shell commands inside a sandbox.
- Prefer fewer, broader commands that answer the user quickly.
- Use sessions when a task needs multiple steps or a working directory.

Quick Patterns
1) Single command (one‑off)
   - action: run
   - commands: ["pwd"]

2) Multi‑step without session (simple chains)
   - action: run
   - commands: ["ls -1 ~/projects", "rg -n \"TODO\" ~/projects/pixeltrail/README.md"]

3) Multi‑step with session (when you need cd)
   - action: start, cwd: "/home/ethan"
   - action: run, sessionId: "<id>", commands: ["cd projects/pixeltrail", "git status", "rg -n \"cli\" src"]
   - action: end, sessionId: "<id>" (optional but nice)

4) Simple pipeline or fallback
   - commands: ["ls -1 -t | head -n 10"]
   - commands: ["stat -c '%y %n' README.md || stat README.md"]
   - commands: ["rg -n \"TODO\" . || true"]
   - commands: ["rg -n \"TODO\" . | head -n 20"]
   - commands: ["ls -1A && pwd"]

Allowed Commands
- ls, pwd, whoami, date, uname, uptime, df, free, id, echo, true
- rg, grep, awk, jq, tree, fd, bat
- find, cat, head, tail, wc, stat, realpath, readlink, du, ps, top, lsblk
- sort, uniq, cut, tr, sed (no -i)
- git (read‑only): status, diff, log, branch, rev-parse, show, ls-files, remote -v, blame

Safety Rules (hard limits)
- No sudo/su. Allowed operators: pipe (|), single fallback (cmd1 || cmd2), and &&.
- Redirect only to /dev/null is allowed (e.g., 2>/dev/null, >/dev/null).
- Disallowed: ;, >, < (except /dev/null), `, $, and other shell metacharacters.
- No write/modify commands (rm, mv, cp, chmod, chown, dd, mkfs, mount, tee, touch)
- Paths must stay inside either the current working directory or ~/.pixeltrail
- Output capped to 12KB, timeout 5s per command
- Max commands per tool call: 20

Git Tips
- Use `git -C <path> <subcommand>` instead of `cd` when possible
- Allowed: `git -C ~/projects/pixeltrail status`
- Not allowed: `git -C <path> checkout`, `git reset`, `git commit`

Examples
- “What’s in my projects folder?”
  commands: ["ls -1 ~/projects"]

- “Show modified files in pixeltrail”
  commands: ["git -C ~/projects/pixeltrail status --porcelain"]

- “Find TODOs in this repo”
  commands: ["rg -n \"TODO\" ~/projects/pixeltrail"]

- “List git repos under ~/projects (depth 2)”
  commands: ["find ~/projects -maxdepth 2 -type d -name .git -print"]
