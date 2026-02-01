# file_snippet
## Purpose
Read a small line-range snippet from a file within allowed roots.

## When to use
- Inspect a specific section of a file
- Avoid loading full large files

## Inputs
- path: file path
- startLine/endLine: line range
- maxLines/maxBytes: limits

Example
- path="src/index.ts", startLine=1, endLine=80

## Outputs
- Numbered lines of the requested range

## Safety and constraints
- Read-only; path must be within allowed roots
- Truncates to maxBytes and maxLines

## Common patterns
- Read a config block
- Inspect a function

## Failure modes
- "Path outside allowed roots" or read errors
