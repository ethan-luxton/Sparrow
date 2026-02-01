# gmail
## Purpose
Search/read Gmail, list threads, inspect/save attachments, and compose/send email (send requires confirm=true).

## When to use
- Find messages by query
- Read a specific email
- Extract attachment text (PDF/DOCX)
- Draft or send an email (explicit request)

## Inputs
- action: search_messages | read_message | list_threads | attachment_metadata | save_attachment | attachment_text | compose_message | send_raw
- query, messageId, threadId, attachmentId
- savePath (for save_attachment, allowlisted)
- to/cc/bcc/subject/body (compose)
- raw (send_raw)
- confirm: required to send

Example
- action=search_messages, query="invoice"
- action=read_message, messageId="..."
- action=compose_message, to=["a@b.com"], subject="Hi", body="..."

## Outputs
- Arrays of message/thread IDs or message data
- Attachment metadata or text
- Compose returns preview + raw unless confirm=true

## Safety and constraints
- send requires confirm=true
- save_attachment writes to allowlisted paths only

## Common patterns
- Search then read message
- Extract text from PDF/DOCX attachments

## Failure modes
- "Missing required fields" for IDs
- Gmail API errors
