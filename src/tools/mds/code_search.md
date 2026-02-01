# code_search
## Purpose
Search code/text using ripgrep (rg) with safe defaults; falls back to grep if rg is unavailable.

## When to use
- Find references across a repo
- Search for symbols, filenames, or config keys

## Inputs
- query: string (required)
- path: base path (default ".")
- maxResults: 1–200
- caseSensitive: boolean
- glob: file glob filter

Example
- query="OpenAI", path="src", maxResults=50

## Outputs
- Matching lines with file:line:content or "No matches."

## Safety and constraints
- Read-only
- Respects allowed roots

## Common patterns
- Locate a config key in src/
- Find usages of a function name

## Failure modes
- "Search failed" if rg/grep errors or output too large
