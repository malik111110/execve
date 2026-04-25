# Language Parsing Strategy

This guide defines how the agent should extract structure before proposing edits.

## Parsing Priorities

1. Symbol-level understanding (functions, classes, methods).
2. Import/dependency awareness.
3. Call-site discovery for impacted symbols.
4. Fallback to regex only when structural parsing is unavailable.

## Recommended Pipeline

1. list files in target area
2. search symbol names
3. read targeted blocks
4. map references and side effects
5. edit only impacted files

## Local-Model Adaptation

- Keep parsing scope narrow to reduce token load.
- Use short excerpts and focused queries.
- Re-check latest content before patch generation.

## Output Expectations

Before editing, summarize:

- target symbol(s)
- dependent files
- proposed edit boundaries
- validation commands
