# task_runner
## Purpose
Run predefined allowlisted tasks (opt-in). Returns a preview unless confirm=true.

## When to use
- Execute a preapproved task from config

## Inputs
- taskId: task identifier
- confirm: boolean (required to execute)

Example
- taskId="build", confirm=true

## Outputs
- If confirm=false: { wouldRun, note }
- If confirm=true: { stdout, stderr }

## Safety and constraints
- Only allowlisted tasks
- confirm=true required to run

## Common patterns
- Run a known script safely

## Failure modes
- "Unknown task" or task not configured
