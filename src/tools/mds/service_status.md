# service_status
## Purpose
Check systemd service status or recent logs (read-only).

## When to use
- Inspect a service health status
- View recent service logs

## Inputs
- action: status | logs
- name: systemd service name
- lines: number of log lines (1–200)

Example
- action=status, name="nginx"
- action=logs, name="ssh", lines=50

## Outputs
- Text status or logs

## Safety and constraints
- Read-only; relies on systemctl/journalctl

## Common patterns
- Quick health check

## Failure modes
- "systemctl/journalctl not available" on non-systemd systems
