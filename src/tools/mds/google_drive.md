# google_drive
## Purpose
Interact with Google Drive: list/search files, fetch metadata, export docs, extract text, upload/create files/folders.

## When to use
- Search or list Drive files
- Export Google Docs as text/PDF/DOCX
- Upload or create files when user asks

## Inputs
- action: list | search | metadata | export_doc | export_pdf | export_docx | extract_text | create_pdf | upload | upload_convert | create_folder | create_doc | download_file | delete_file
- query, fileId, name, parentId, localPath, content
- confirm: required for write actions (upload/create/download/delete)

Example
- action=search, query="proposal"
- action=export_doc, fileId="..."
- action=upload, localPath="~/...", confirm=true

## Outputs
- Lists/metadata objects from Drive
- Exports: text or base64 content
- Writes: { id, name, mimeType } or { deleted: true }

## Safety and constraints
- Write actions require confirm=true
- localPath restricted to ~/.pixeltrail base dir

## Common patterns
- Find files and export to text
- Create a folder and upload a file

## Failure modes
- "fileId required" or "name required"
- Drive API errors on invalid queries or permissions
