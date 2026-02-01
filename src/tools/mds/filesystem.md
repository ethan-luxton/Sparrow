# filesystem
## Purpose
Safe local file access restricted to ~/.sparrow only.

## When to use
- Read or list files under ~/.sparrow
- Write files under ~/.sparrow when explicitly requested

## Inputs
- action: read | write | list | read_pdf_text | read_docx_text | write_pdf | write_binary
- path: path under ~/.sparrow
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
- Restricted to ~/.sparrow base directory
- Write actions require confirm=true

## Common patterns
- Read a cached report
- Save a generated summary

## Failure modes
- "Path ... is outside of" if invalid
- "content is required" for writes
