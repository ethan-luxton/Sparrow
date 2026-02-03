# filesystem
## Purpose
Safe local file access restricted to ~/.pixeltrail only.

## When to use
- Read or list files under ~/.pixeltrail
- Write files under ~/.pixeltrail when explicitly requested

## Inputs
- action: read | write | list | read_pdf_text | read_docx_text | write_pdf | write_binary
- path: path under ~/.pixeltrail
- content: required for write/write_pdf/write_binary
- encoding: base64 (required for write_binary)

Example
- action=read, path="notes.txt"
- action=write, path="report.txt", content="...", confirm=true
- action=write_binary, path="audio.ogg", content="<base64>", encoding="base64", confirm=true

## Outputs
- read: file text
- list: directory entries
- write: "written"

## Safety and constraints
- Restricted to ~/.pixeltrail base directory
- Write actions require confirm=true

## Common patterns
- Read a cached report
- Save a generated summary

## Failure modes
- "Path ... is outside of" if invalid
- "content is required" for writes
