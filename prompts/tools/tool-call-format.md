# Tool Call Format

This project uses a parser-friendly action envelope for local models.

## Canonical Structure

```xml
<action>
  <tool>tool_name</tool>
  <arguments>{"key":"value"}</arguments>
</action>
```

## Rules

- Exactly one action block per step.
- Arguments must be valid JSON object.
- Tool name must match catalog exactly.
- Paths should be workspace-relative when possible.
- If no tool is needed, return plain completion text.

## Example: Read File

```xml
<action>
  <tool>read_file</tool>
  <arguments>{"path":"README.md","start_line":1,"end_line":120}</arguments>
</action>
```

## Example: Create File

```xml
<action>
  <tool>create_file</tool>
  <arguments>{"path":"notes/todo.md","content":"# Todo\n","overwrite":false}</arguments>
</action>
```

## Parser Failure Recovery

If parsing fails:

1. retry with a corrected single action block,
2. avoid prose around the action,
3. keep arguments small and valid JSON.
