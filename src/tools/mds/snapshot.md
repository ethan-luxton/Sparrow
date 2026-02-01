# snapshot
## Purpose
Quick system + projects snapshot (OS info + git summaries).

## When to use
- One-shot overview of system and project repos

## Inputs
- root: project root (default ~/projects)
- maxDepth: 1–6

Example
- root="~/projects", maxDepth=2

## Outputs
- { os, memory, loadAvg, uptimeSeconds, projects }

## Safety and constraints
- Read-only

## Common patterns
- Quick environment check before work

## Failure modes
- Missing project directories
