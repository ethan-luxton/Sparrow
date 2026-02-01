# n8n
## Purpose
Access local n8n: list/get workflows, list executions, and create workflows (confirm=true for create).

## When to use
- Inspect existing workflows
- List recent executions
- Create a workflow when explicitly requested

## Inputs
- action: list_workflows | get_workflow | list_executions | create_workflow | workflow_schema
- workflowId, limit, offset, name, nodes, connections, settings
- confirm: required for create_workflow

Example
- action=list_workflows, limit=20
- action=get_workflow, workflowId=123

## Outputs
- JSON objects from n8n API
- workflow_schema returns an example template

## Safety and constraints
- create_workflow requires confirm=true
- n8n baseUrl and credentials must be configured

## Common patterns
- List workflows then fetch one

## Failure modes
- "n8n baseUrl not configured"
- API errors with status codes
