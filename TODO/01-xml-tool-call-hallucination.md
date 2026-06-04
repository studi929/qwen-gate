# Bug: Qwen Model Hallucinates Tool Calls as XML

**Severity**: CRITICAL
**Status**: OPEN
**Discovered**: 2026-06-03
**Source**: `output-bugs/tool call xml/`

---

## Problem

The Qwen model outputs **fabricated tool calls** in XML format directly in its text response. It does NOT use Qwen's native tool calling API. Instead, it writes XML that *looks like* tool invocations, then writes XML that *looks like* tool results — all of it is the model's own text generation.

## Evidence

### raw_output.txt (lines 3-24)
```xml
<tool_calls>
<tool>
<tool_name>bash</tool_name>
<parameter name="command">cd /home/youssefvdel/Projects/qwen-gate && rtk git diff .gitignore