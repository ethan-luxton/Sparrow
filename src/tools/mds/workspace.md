# workspace
## Purpose
Operate on files inside the local workspace root at ~/sparrow-projects with strict sandboxing.

## When to use
- Create or open a project folder
- Read or write project files
- List files or search within a project
- Apply a unified diff to project files

## Inputs
- action: ensure_workspace | list_projects | ensure_project | read_file | write_file | apply_patch | list_files | search
- project: project name under ~/sparrow-projects
- path: relative file path inside the project
- content: file content for write_file
- diff: unified diff string for apply_patch
- glob: optional glob for list_files
- maxDepth: optional max depth for list_files
- query: search query for search
- maxResults: optional search cap

Example
- action=ensure_project, project="sparrow-telegram"
- action=write_file, project="sparrow-telegram", path="src/index.ts", content="..."
- action=search, project="sparrow-telegram", query="TODO", maxResults=50

## Outputs
- ensure_workspace: { root }
- list_projects: { root, projects[] }
- ensure_project: { project, path }
- read_file: string (redacted)
- write_file: { written, path }
- apply_patch: { applied }
- list_files: { files[] }
- search: string (redacted)

## Safety and constraints
- Only paths under ~/sparrow-projects are allowed
- Path traversal and symlink escape are blocked
- Files have size limits for read and write
- Output is redacted for common secret patterns

## Common patterns
- Ensure workspace, then ensure project, then read or write files
- List files before editing to confirm structure
- Apply a unified diff and then run git status

## Failure modes
- "Path outside workspace root" for traversal
- "Symlink escapes are not allowed" for symlinked paths
- "File too large" for oversized reads or writes
