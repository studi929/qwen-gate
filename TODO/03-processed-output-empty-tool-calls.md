# Bug: Processed Output Has Empty `<tool_calls>` Tags

**Severity**: MEDIUM
**Status**: OPEN
**Discovered**: 2026-06-03
**Source**: `output-bugs/tool call xml/processed_output.txt`

---

## Problem

After the content filter processes the raw output, the `<tool_calls>` XML blocks are stripped of their content but the **wrapper tags remain**, resulting in empty `<tool_calls></tool_calls>` in the visible output.

## Evidence

### raw_output.txt (full tool call)
```xml
<tool_calls>
<tool>
<tool_name>bash</tool_name>
<parameter name="command">cd /home/youssefvdel/Projects/qwen-gate && rtk git diff .gitignore