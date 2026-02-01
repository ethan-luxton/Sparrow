# process_list
## Purpose
List top processes by CPU usage.

## When to use
- Quick check on CPU-heavy processes

## Inputs
- limit: 1–50

Example
- limit=10

## Outputs
- Text table from ps

## Safety and constraints
- Read-only

## Common patterns
- Identify spikes in CPU usage

## Failure modes
- ps command errors
