# Bug: Tool Call JSON Fragmented Across Streaming Chunks

**Severity**: MEDIUM
**Status**: OPEN (partially addressed by StreamingToolParser buffer)
**Source**: `output-bugs/tool call xml/chunk_stream.txt`, `old/06.md`

---

## Problem

SSE chunks from Qwen arrive with tool call JSON split mid-token, mid-key, and mid-value. The `StreamingToolParser` must buffer and reassemble across chunk boundaries.

## Evidence

### chunk_stream.txt (XML fragmentation)
```
<tool_calls>
<
tool> <
tool_name
>bash</tool
_name> <
command>cd /
home/youssefv
del/Projects/q
wen-gate &&
```

### old/06.md (JSON fragmentation)
```
#7 tool {"name":"read
#8 text ","arguments":{"filePath
#9 text ":"
#10 text /home/yousse
#11 text fvdel/Projects
#12 text /qwen-gate
#13 text /src/routes/chat.ts
#14 text ","offset":5
#15 text 00,"limit
#16 text ":
#17 text 20}}
```

### stream-debug-01.log (JSON fragmentation)
```
{"name":
 "bash", "
arguments": {"command
": "echo \"
kernel: $(uname
 -
r)\"", "
description": "Get
 kernel version"}}
```

## Current Mitigation

`StreamingToolParser.feed()` maintains a buffer and uses `findJsonEnd()` (balanced brace matcher) to detect complete JSON objects across chunks. This works for Format 1 (JSON) but NOT for Format 2 (XML).

## Remaining Issues

1. **XML format not buffered** — `<tool_calls>` XML arrives in fragments but the parser doesn't look for XML start tags
2. **Partial key corruption** — chunk boundary splits `"arguments"` into `"argumen"` + `"ts"`, which the JSON parser may reject
3. **String value splits** — `"/home/yousse"` + `"fvdel/Projects"` — if the JSON parser sees incomplete strings, it may fail silently
4. **Multi-call interleaving** — multiple tool calls in one response arrive as interleaved fragments

## Affected Code

| File | Role |
|------|------|
| `src/tools/parser.ts` | `feed()` method — buffers and reassembles JSON |
| `src/tools/parserHelpers.ts` | `findJsonEnd()` — balanced brace matcher |
| `src/tools/parserHelpers.ts` | `normalizeJsonNewlines()` — handles newlines in strings |

## Fix Options

1. **Add XML buffering** — detect `<tool_calls>` start, buffer until `</tool_calls>`
2. **Increase chunk timeout** — wait longer before flushing partial buffers
3. **Pre-validate JSON** — check if buffer contains valid JSON before attempting parse
4. **Use streaming JSON parser** — e.g., `jsonstream` or `stream-json` for incremental parsing
