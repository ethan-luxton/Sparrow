# todoist
Interact with Todoist tasks: list/filter/get tasks, create/update/delete tasks. Write actions require `confirm=true`.

## Actions
- `list_tasks` list active tasks (optional filters by project/section/label/ids).
- `filter_tasks` list tasks using a Todoist filter query.
- `get_task` fetch a task by id.
- `create_task` create a new task (requires `content`).
- `update_task` update a task by id.
- `delete_task` delete a task by id.

## Required setup
- Set `todoist.token` via `pt config set todoist.token` or set `TODOIST_API_TOKEN`.
- Optional: set `todoist.baseUrl` or `TODOIST_BASE_URL` if you use a proxy.

## Examples
- List tasks for a project:
  - `action: list_tasks`, `projectId: 123456789`
- Filter tasks:
  - `action: filter_tasks`, `filter: "today & !@waiting"`
- Create a task (requires confirm):
  - `action: create_task`, `content: "Send invoice"`, `priority: 4`, `confirm: true`
- Update a task (requires confirm):
  - `action: update_task`, `taskId: 987654321`, `content: "Send invoice (updated)"`, `confirm: true`
- Delete a task (requires confirm):
  - `action: delete_task`, `taskId: 987654321`, `confirm: true`
