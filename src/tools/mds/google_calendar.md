# google_calendar
## Purpose
Read and manage Google Calendar events and calendars.

## When to use
- List calendars or events
- Create/update/delete events when user explicitly asks
- Quick-add an event from natural text

## Inputs
- action: list_calendars | list_events | create_event | update_event | delete_event | quick_add
- calendarId: calendar ID (default "primary")
- timeMin/timeMax: RFC3339 with timezone for list_events
- summary/description/start/end: event fields
- recurrence: RRULE string or array of RRULE strings
- confirm: required for create/update/delete/quick_add

Example
- action=list_events, calendarId="primary", timeMin="2026-03-01T00:00:00-08:00", timeMax="2026-03-31T23:59:59-07:00"
- action=create_event, summary="Workout", start="2026-03-03T18:00:00-08:00", end="2026-03-03T18:45:00-08:00", recurrence=["RRULE:FREQ=WEEKLY;BYDAY=TU,TH,SA;COUNT=36"], confirm=true

## Outputs
- list_calendars: array of { id, summary, primary }
- list_events: array of { id, summary, start, end, status }
- create/update/delete: success object with id/link

## Safety and constraints
- Write actions require confirm=true
- Use RFC3339 dates with offsets

## Common patterns
- Upcoming events for a month
- Add a recurring series with RRULE
- Update description or time for an event

## Failure modes
- "timeMin must be RFC3339" validation errors
- "Set confirm=true" for write actions
- "eventId required" for update/delete
