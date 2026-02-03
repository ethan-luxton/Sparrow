# doc_index
## Purpose
Index and search local docs by filename (md/txt/pdf/docx).

## When to use
- Build a lightweight doc index
- Search for docs by filename

## Inputs
- action: index | search | status
- path: root to index (index only)
- query: search string (search only)

Example
- action=index, path="."
- action=search, query="policy"

## Outputs
- status: { indexPath, count }
- index: { indexed, indexPath }
- search: array of matching paths

## Safety and constraints
- Read-only; index stored under ~/.pixeltrail
- Limits to 2000 files

## Common patterns
- Index repo docs and search by keyword

## Failure modes
- "query is required" if missing
