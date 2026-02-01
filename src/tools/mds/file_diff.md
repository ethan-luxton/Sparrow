# file_diff
## Purpose
Show a unified diff between two files within allowed roots.

## When to use
- Compare two versions of a file
- Inspect changes across copies

## Inputs
- pathA: first file path
- pathB: second file path
- context: number of context lines (0–20)

Example
- pathA="src/a.ts", pathB="src/b.ts", context=3

## Outputs
- Unified diff text or "No differences."

## Safety and constraints
- Read-only; paths must be within allowed roots

## Common patterns
- Compare generated vs. original files

## Failure modes
- "Diff failed" if diff command errors
