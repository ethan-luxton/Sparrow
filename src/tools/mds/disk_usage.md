# disk_usage
## Purpose
Show disk usage (df -h) and optionally du -sh for a path.

## When to use
- Check disk space
- Inspect size of a directory

## Inputs
- path: optional path to inspect
- includeDirs: boolean (if true, du -sh path/*)

Example
- path="/home/ethan/projects", includeDirs=true

## Outputs
- Text output of df -h and optional du -sh

## Safety and constraints
- Read-only
- Respects allowed roots for path

## Common patterns
- Quick disk health check
- Identify large directories

## Failure modes
- Errors if path outside allowed roots
