# system_info
## Purpose
Return safe OS details plus uptime, load average, memory, and disk usage.

## When to use
- Basic system health snapshot

## Inputs
- none

## Outputs
- { os, uptimeSeconds, loadAvg, memory, disk }

## Safety and constraints
- Read-only

## Common patterns
- Quick system status check

## Failure modes
- Disk info may be "unavailable" if df fails
