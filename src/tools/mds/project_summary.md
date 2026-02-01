# project_summary
## Purpose
Summarize projects under a folder and detect git repos (branch, last commit, changed files).

## When to use
- List projects under ~/projects
- Get quick repo status across directories

## Inputs
- root: base folder (default ~/projects)
- maxDepth: 1–6
- includeGit: boolean

Example
- root="~/projects", maxDepth=2, includeGit=true

## Outputs
- { root, entries, repos }

## Safety and constraints
- Read-only

## Common patterns
- Quick overview of local repos

## Failure modes
- Missing or inaccessible directories
