# git
## Purpose
Run allowlisted git commands within a workspace project directory.

## When to use
- Check status, diff, or log
- Initialize a repo or create a branch
- Stage changes
- Commit or push after user approval

## Inputs
- action: status | log | diff | show | branch_list | branch_create | checkout | switch | fetch | pull | push | add | commit | stash | restore | reset | merge | rebase | tag | init | config_list
- project: project name under ~/pixeltrail-projects
- message: commit message for commit
- paths: optional file paths for add or restore
- staged: boolean for diff
- maxCount: number for log
- ref: ref for show, merge, rebase, reset
- branch: branch for switch, pull, push
- remote: remote for fetch, pull, push
- tag: tag name
- confirm: required for Tier2 actions

Example
- action=init, project="pixeltrail-telegram" (defaults to main)
- action=status, project="pixeltrail-telegram"
- action=add, project="pixeltrail-telegram", paths=["src/index.ts"]
- action=commit, project="pixeltrail-telegram", message="Initial scaffold", confirm=true

## Outputs
- { exitCode, summary, stdout, stderr }

## Safety and constraints
- Runs only inside ~/pixeltrail-projects/<project>
- Force, hard reset, and destructive flags are blocked
- Tier2 actions require approval

## Common patterns
- status then diff, then add, then ask to commit
- branch_list then branch_create before changes
- log with maxCount to summarize history

## Failure modes
- "Unsupported git action" if action not allowed
- Errors from git in stderr with nonzero exitCode
