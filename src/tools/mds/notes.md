# notes
## Purpose
Store or retrieve short notes for this chat, kept locally in SQLite.

## When to use
- Save a quick user preference or reminder
- List recent notes

## Inputs
- action: add | list
- title, content (for add)
- limit (for list)

Example
- action=add, title="Preference", content="Likes concise responses"
- action=list, limit=10

## Outputs
- add: "Note stored locally."
- list: formatted notes or "No notes yet."

## Safety and constraints
- Stored locally

## Common patterns
- Save a summary of decisions

## Failure modes
- "title and content required" for add
