Sparrow CLI Tool Guide

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
   - commands: ["ls -1 ~/projects", "rg -n \"TODO\" ~/projects/sparrow/README.md"]

3) Multi‑step with session (when you need cd)
   - action: start, cwd: "/home/ethan"
   - action: run, sessionId: "<id>", commands: ["cd projects/sparrow", "git status", "rg -n \"cli\" src"]
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
- Paths must stay inside either the current working directory or ~/.sparrow
- Output capped to 12KB, timeout 5s per command
- Max commands per tool call: 20

Git Tips
- Use `git -C <path> <subcommand>` instead of `cd` when possible
- Allowed: `git -C ~/projects/sparrow status`
- Not allowed: `git -C <path> checkout`, `git reset`, `git commit`

Examples
- “What’s in my projects folder?”
  commands: ["ls -1 ~/projects"]

- “Show modified files in sparrow”
  commands: ["git -C ~/projects/sparrow status --porcelain"]

- “Find TODOs in this repo”
  commands: ["rg -n \"TODO\" ~/projects/sparrow"]

- “List git repos under ~/projects (depth 2)”
  commands: ["find ~/projects -maxdepth 2 -type d -name .git -print"]
