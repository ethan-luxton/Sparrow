# weather
## Purpose
Summarize current and near-term weather for any location.

## When to use
- Quick weather summary for a specific location

## Inputs
- action: summary
- location: string

Example
- action=summary location="Seattle, WA"

## Outputs
- Text summary for the requested location

## Safety and constraints
- Read-only network call

## Common patterns
- Quick “what’s the weather in X” check

## Failure modes
- Weather fetch errors if API is unavailable
