# dependency_map
## Purpose
Summarize dependencies from a package.json file.

## When to use
- Inspect dependencies/devDependencies/scripts quickly
- Get a package overview

## Inputs
- path: file or directory containing package.json

Example
- path="."

## Outputs
- { package, version, dependencies, devDependencies, scripts }

## Safety and constraints
- Read-only; respects allowed roots

## Common patterns
- Quick dependency audit
- Identify available npm scripts

## Failure modes
- "No package.json found" if not present
