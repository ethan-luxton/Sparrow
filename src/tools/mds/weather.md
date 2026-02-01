# weather
## Purpose
Summarize current and near-term weather for Seattle/Bellevue/Bothell metro area.

## When to use
- Quick weather summary for the metro area

## Inputs
- action: metro_summary

Example
- action=metro_summary

## Outputs
- Text summary lines for Seattle, Bellevue, Bothell

## Safety and constraints
- Read-only network call

## Common patterns
- Quick “what’s the weather” check

## Failure modes
- Weather fetch errors if API is unavailable
