# System Prompt Best Practices for Tool-Calling Agents

**Research Date**: 2026-06-03
**Sources**: OpenAI docs, Anthropic docs, Google DeepMind docs, Qwen docs, GitHub (Aider, Cline, Open Interpreter, Continue, Claude Code leaks, Cursor leaks, Windsurf leaks, Devin leaks), 5 research papers (ICLR 2026, EMNLP 2025, ACL 2025), Community consensus (awesome-system-prompts repo)

---

## Table of Contents

1. [The Production System Prompt Blueprint](#1-the-production-system-prompt-blueprint)
2. [OpenAI Best Practices](#2-openai-best-practices)
3. [Anthropic Best Practices](#3-anthropic-best-practices)
4. [Google DeepMind Best Practices](#4-google-deepmind-best-practices)
5. [Qwen-Specific Findings](#5-qwen-specific-findings)
6. [Production Agent Prompt Architecture Comparison](#6-production-agent-prompt-architecture-comparison)
7. [Research Papers on Prompt Optimization](#7-research-papers-on-prompt-optimization)
8. [Community Consensus](#8-community-consensus)
9. [Recommended Prompt Structure for Qwen Gateway](#9-recommended-prompt-structure-for-qwen-gateway)

---

## 1. The Production System Prompt Blueprint

After analyzing 8+ production agent systems, there's strong convergence on this structure:

```
┌──────────────────────────────────────────────┐
│ 1. ROLE / IDENTITY (~100 tokens)              │
│    "You are a [role]. You have [tools]."       │
├──────────────────────────────────────────────┤
│ 2. GOALS / OBJECTIVE (~100 tokens)            │
│    What you should achieve. Single sentence.   │
├──────────────────────────────────────────────┤
│ 3. TOOL DEFINITIONS (~VARIABLE)               │
│    Each tool: name, description, params,       │
│    when to use, when NOT to use.              │
├──────────────────────────────────────────────┤
│ 4. TOOL CALLING PROTOCOL (~300 tokens)        │
│    How to call tools, parallel vs sequential,  │
│    iteration caps, escalation rules.          │
├──────────────────────────────────────────────┤
│ 5. OUTPUT FORMAT (~100 tokens)                │
│    Exact format for tool calls. Pinned here.   │
├──────────────────────────────────────────────┤
│ 6. CONSTRAINTS (~200 tokens)                  │
│    Forbidden actions, hard limits.             │
├──────────────────────────────────────────────┤
│ 7. STOP CONDITIONS (~50 tokens)               │
│    When to stop and respond.                   │
├──────────────────────────────────────────────┤
│ [Tool Definitions — via API tools parameter]  │
└──────────────────────────────────────────────┘
```

**Why this ordering works**:
- **Identity anchors behavior** at the start (primacy effect)
- **Tool definitions** establish the capability surface before rules
- **Protocol + format** give concrete how-to instructions mid-prompt
- **Constraints + stop conditions** at the end (recency bias) — models attend more to last instructions

---

## 2. OpenAI Best Practices

### 2.1 The Four-Block Structure

OpenAI's recommended structure for system prompts:

```
1. GOALS      — What the assistant should achieve
2. INSTRUCTIONS — How to generate responses, tool rules, what to do/not do
3. EXAMPLES   — Concrete input → output pairs showing tool usage
4. CONTEXT    — Additional data near the prompt end (for prompt caching)
```

**Why it works**: This ordering maximizes prompt caching (static content at start), reduces "lost in the middle" effects for critical instructions, and puts contextual data last so it changes per-request without invalidating the cache.

### 2.2 Function Descriptions Are the Highest-Leverage Surface

OpenAI found that well-written function descriptions matter more than system prompt text for tool selection accuracy.

**Best practices**:
- Write **clear, detailed function names and parameter descriptions** — explicitly describe purpose, format, and output
- Use the **system prompt to describe when (and when not) to use each function**
- Include **examples and edge cases** to rectify recurring failures
- Make functions **obvious and intuitive** (principle of least surprise)
- Use **enums and object structure** to make invalid states unrepresentable
- **Offload burden from model** — don't make the model fill arguments you already know

### 2.3 Keep the Active Tool Set Small (< 20)

> "Keep the number of initially available functions small for higher accuracy. Aim for fewer than 20 functions available at the start of a turn."

More tools = more choice ambiguity = higher hallucination rates.

### 2.4 Strict Mode = Mandatory

> "Setting `strict` to `true` will ensure function calls reliably adhere to the function schema. We recommend always enabling strict mode."

Requirements: `additionalProperties: false` on all objects, all fields must be `required`.

### 2.5 For Reasoning Models: DON'T Prompt Chain-of-Thought

> "Since these models are reasoning models and produce an internal chain of thought, they do not have to be explicitly prompted to plan and reason between tool calls. Asking a reasoning model to reason more may actually hurt performance."

Use short, outcome-first prompts instead.

### 2.6 Agentic Persistence Reminder

For long-running agents:
```
Remember, you are an agent - please keep going until the user's query is completely
resolved. Decompose the user's query into all required sub-requests, and confirm
each is completed. Do not stop after completing only part of the request.
```

---

## 3. Anthropic Best Practices

### 3.1 XML Tag Structure for Complex Prompts

Claude responds strongly to XML-delimited sections:
```xml
<role>You are an expert coding agent.</role>
<tools>
  <tool name="read">Read file contents</tool>
</tools>
<instructions>
  Use tools proactively. Default to action, not suggestions.
</instructions>
```

**Evidence**: "XML tags help Claude parse complex prompts unambiguously, especially when you're mixing instructions, context, examples, and variable inputs."

### 3.2 Default-to-Action Pattern

```xml
<default_to_action>
By default, implement changes rather than only suggesting them. If the user's intent
is unclear, infer the most useful likely action and proceed.
</default_to_action>
```

### 3.3 Parallel Tool Calling Optimization

```xml
<use_parallel_tool_calls>
If you intend to call multiple independent tools, make all independent calls in
parallel. However, if some calls depend on previous outputs, do NOT call them
in parallel. Never use placeholders or guess missing parameters.
</use_parallel_tool_calls>
```

### 3.4 Context Engineering Insights

Anthropic's most important insight: **System prompts are one component of context engineering**. They recommend:
1. **Organize prompts into distinct sections** using XML tags or Markdown headers
2. **Strive for the minimal set of information** that fully outlines expected behavior
3. **Start minimal, then add** based on observed failure modes
4. **Tool descriptions are a critical engineering surface** — vague descriptions are the #1 driver of tool selection errors

### 3.5 Anti-Rationalization Rules (from Claude Code)

```
- Do NOT skip tool calls because you think you know the answer.
- Do NOT summarize or truncate tool results unless explicitly asked.
- If a tool call fails, retry once with corrected parameters before escalating.
- Do NOT promise future actions you cannot take in this turn.
```

---

## 4. Google DeepMind Best Practices

### 4.1 System Instruction Structure

```
<OBJECTIVE_AND_PERSONA> ... </OBJECTIVE_AND_PERSONA>
<INSTRUCTIONS> ... </INSTRUCTIONS>
<CONSTRAINTS> ... </CONSTRAINTS>
<CONTEXT> ... </CONTEXT>
<OUTPUT_FORMAT> ... </OUTPUT_FORMAT>
<FEW_SHOT_EXAMPLES> ... </FEW_SHOT_EXAMPLES>
<RECAP> ... </RECAP>
```

### 4.2 Function Calling Guidelines
- **Extremely clear and specific** function descriptions
- **Descriptive function names** (no spaces, periods, dashes)
- **Aim for 10-20 active tools maximum**
- **Use low temperature** (0) for deterministic function calls (Gemini 2.5 and earlier)
- **Gemini 3**: Keep temperature at default 1.0 — changing it may cause looping

### 4.3 Gemini 3 Specific Guidance
- **Place core request and critical constraints as the final lines** of instructions
- **Negative constraints should be at the end** — the model may drop them if they appear too early
- **Keep prompt shorter** — direct, clear instructions work best
- **Avoid blanket negative constraints** like "do not infer" — they can cause basic logic failures
- **Use lower thinking levels** to reduce unnecessary tool calls

---

## 5. Qwen-Specific Findings

### 5.1 Native Tool Calling Format

Qwen3 uses **Hermes-style** tool calling (recommended by official docs):

```
<|im_start|>system
# Tools
You may call one or more functions to assist with the user query.

You are provided with function signatures within <tools></tools> XML tags:
<tools>
{{JSON Schema of each function}}
</tools>

For each function call, return a json object within <tool_call></tool_call> tags:
<tool_call>
{"name": <function-name>, "arguments": <args-json-object>}
</tool_call><|im_end|>
```

**Key points**:
- Tools described as **JSON Schema** (OpenAI-compatible `type: "function"` format)
- Tool calls wrapped in `<tool_call>` XML tags (NOT bare JSON)
- `arguments` must be a JSON **object** (not a string)
- Tool results wrapped in `<tool_response>` tags
- Multiple `<tool_call>` blocks for parallel calls

### 5.2 Known Issues with Qwen Tool Calling

| Issue | Description | Impact |
|-------|-------------|--------|
| **Missing `<tool_call>` tag** | Model frequently omits the opening `<tool_call>` tag, especially after textual responses | Silent parse failure |
| **Tool calls inside unclosed `<think>`** | Tool calls can appear inside unclosed `<think>` blocks | Content channel contamination |
| **Multi-turn argument collapse** | After 2-3 turns, model emits `arguments: {}` despite correctly identifying parameters | Loss of functionality |
| **Premature stalls** | Model aborts turn when trying to combine conversation AND tool call simultaneously | Broken loops |
| **Post-tool reasoning spirals** | After tool error, model repeatedly emits the identical failing call | Infinite loops |
| **`developer` role rejected** | Modern harnesses send `role: "developer"` — Qwen Jinja template crashes | Incompatibility |

### 5.3 Best Prompt Format for Qwen

**What works**:
- **Hermes-style XML delimited sections** — this is what Qwen3 was trained on
- **Explicit, declarative instructions with tight constraints**
- **Strict `<IMPORTANT>` reminder blocks** with numbered rules:
  ```
  <IMPORTANT>
  - Function calls MUST follow the specified format
  - Do NOT omit the initial <tool_call> tag
  - Required parameters MUST be specified
  - Reasoning BEFORE the call, NOT after
  - If no function call available, answer like normal
  </IMPORTANT>
  ```
- **Disable thinking when tools are active** for reliability
- **`preserve_thinking=true`** if using thinking mode (prevents multi-turn collapse)

**What doesn't work**:
- ReAct-style stopword formats (official warning)
- Bare JSON without XML wrapping
- Overly long system prompts (>2000 tokens of instructions)
- Complex multi-paragraph rules — concise structured instructions > prose paragraphs

### 5.4 Benchmark Performance

| Benchmark | Qwen3-Coder-Next | GPT-5.2 | Claude Sonnet 4.5 |
|-----------|:-:|:-:|:-:|
| **Template Following (Avg)** | **92.7%** | 49.3% | 85.4% |
| MCPMark (Tool Calling) | 48.2% (3.6 Plus) | N/A | 42.3% (Opus 4.6) |
| Terminal-Bench Hard | **50.8%** (3.7 Max) | N/A | 44.1% (Opus 4.7) |

**Key takeaway**: Qwen3 leads on template following and structured tool use. Claude leads on pure SWE benchmarks and long agentic chains. Qwen is 46x cheaper.

---

## 6. Production Agent Prompt Architecture Comparison

| Feature | Aider | Open Interpreter | Cline/Roo Code | Claude Code | Cursor | Windsurf | Devin |
|---------|-------|-----------------|---------------|-------------|--------|----------|-------|
| **Tool Format** | SEARCH/REPLACE diffs | Code blocks | XML tags | Native tool API | Native tool API | JSON Schema | JSON + XML |
| **Prompt Size** | ~2-3K tokens | ~300 tokens | ~5-8K tokens | 2.3-3.6K (+14K tools) | ~642 tokens | ~800 tokens | Unknown |
| **Sections** | Template classes | Monolithic | Modular TS functions | 6+ conditional sections | Tag-based (`<comm>`) | Tag-based + guidelines | Planning + work modes |
| **Identity** | "expert software developer" | "world-class programmer" | "highly skilled software engineer" | "Claude Code, Anthropic's CLI" | "AI coding assistant" | "Cascade... AI coding assistant" | "real code-wiz... software engineer" |
| **Thinking** | Step-by-step in reply | "Start by writing a plan" | `<thinking>` tags | Implicit in instructions | N/A | N/A | `<think>` scratchpad |
| **Auto-approval** | Always confirm | `auto_run` flag | `requires_approval` per tool | Permission mode | Apply model + sandbox | 20-tool auto chains | Full autonomous |
| **Anti-injection** | No | No | No | No | "NEVER disclose" | "NEVER disclose" | Anti-prompt-injection |

### 6.1 Claude Code's Prompt Architecture (Most Sophisticated)

Claude Code's system prompt is a structured `system` array with **110+ separate instructions** (2,300-3,600 tokens), conditionally assembled.

**Section Layout**:

| Layer | Purpose | Trust Level |
|-------|---------|-------------|
| `role` | Identity and mission | Highest |
| `operating_policy` | Rules of engagement, quality bar, workflow | Highest |
| `tool_policy` | How capabilities are used, sequencing, forbidden actions | Highest |
| `format_contract` | Output guarantees, XML sections, citation rules | Highest |
| `durable_instructions` | User/org/project-specific persistent rules | High |
| `trusted_runtime_context` | Request-scoped server facts | Trusted |
| `retrieved_context` | Evidence from tools | Mixed/Untrusted |
| `user_request` | Current task | First-party |

**Key innovation**: Mid-conversation injection via `<system-reminder>` tags in messages (NOT in system prompt). This allows dynamic context (CLAUDE.md, learned preferences, mode switching) without breaking prompt cache.

**Instruction Hierarchy**:
1. User's explicit instructions (CLAUDE.md, direct requests) — **Highest**
2. Custom system prompt additions
3. Default system prompt
4. Tool definitions — Reference level

### 6.2 Cursor's Prompt (Most Compact at ~642 tokens)

Remarkably compact. Uses `<user_query>` tags to distinguish user input from system-provided context. Forces tool use instead of inline code blocks. Uses a two-model architecture: a "thinker" generates edits, a cheaper "apply model" merges them.

### 6.3 Cline/Roo Code's Prompt (XML-Tagged Tools)

Each tool defined with Description + Parameters + XML template. `requires_approval` boolean per tool call — elegant blast-radius reasoning. Plan/Act mode distinction with separate `plan_mode_respond` tool.

---

## 7. Research Papers on Prompt Optimization

### 7.1 Template-Based Generation Beats Schema-Constrained (ICLR 2026)

**Finding**: Template-based tool calling (natural language format) improves accuracy over JSON schema-constrained generation.

**Evidence**: +2-12% F1 score improvements across GPT-4o, GPT-5, Mistral, DeepSeek-Coder.

**Template approach**:
```
To call a tool, use this format:
Tool: [tool_name]
Arguments:
  param1: value1
```

### 7.2 Structured Reasoning Templates Beat Free-Form CoT (EMNLP 2025)

**Finding**: Template-guided reasoning outperforms both "no thought" and free-form chain-of-thought for function calling.

**Results**: +2.8/+1.7 points on BFCLv2/Nexus over CoT.

### 7.3 Natural Language Tools (NLT, 2025)

**Finding**: Using YES/NO decisions per tool instead of JSON output improves accuracy by **18.4 percentage points**.

**Architecture**: Decouple tool selection from response generation. List each tool with a simple YES/NO decision. Parser executes selected tools.

### 7.4 Verification-Guided Context Optimization (VGCO, 2025)

**Finding**: Iterative refinement of tool descriptions using LLM editors improves single-turn tool calling accuracy by **10-35%**.

**Architecture**: Evaluation (collect failures) → Optimization (hierarchical editing of tool descriptions, parameter schemas, and retrieval fields).

---

## 8. Community Consensus

### 8.1 Goal Anchoring Against Drift

After 4-5 tool calls, models forget the original objective. Solution: re-inject the goal compressed before each major action.

### 8.2 Hard Iteration Caps Must Be BOTH in Prompt AND Code

**Never trust the model's self-imposed limits alone.**
- In prompt: `"Maximum 8 tool calls per task"`
- In code: enforce the cap at the application level

### 8.3 Output Format Agreement Must Be in System, Not User

"Define the JSON shape via tool-use or structured-output mode. For prose, state section headers, field order, and length bounds."

### 8.4 Restate the Load-Bearing Rule at the End

Models attend more to the last instruction than line 30 of 200. Good ending:
`"Return ONLY the JSON tool call. No prose. No explanations."`

### 8.5 Version-Controlled Prompts

Treat system prompts as code. Commit, diff, review, rollback. Run eval on every change.

### 8.6 Explicit Negative Instructions for Each Tool

Most developers write only happy-path tool descriptions. Production agents need failure-path descriptions MORE.

Bad: `"Search for files in the codebase"`
Good: `"Search for files by pattern. Do NOT retry with the same query if no results. Returns empty list if no matches."`

---

## 9. Recommended Prompt Structure for Qwen Gateway

Based on ALL the above research, here's the optimized default system prompt for the Qwen Gateway. It combines:
- **OpenAI's four-block structure** (goals, instructions, examples, context)
- **Anthropic's XML-tagged sections** (for Qwen's Hermes-native format)
- **Claude Code's anti-rationalization rules**
- **Qwen-specific recommendations** (Hermes XML, IMPORTANT blocks, thinking off when tooling)

```
You are a tool-calling agent operating through the Qwen API Gateway.

<objective>
Complete user requests by calling the appropriate tools from your available
tool set. Call tools when the user asks for information or actions that
require external data or system access. Answer directly when no tool is needed.
</objective>

<tools>
{injected dynamically via API tools parameter — JSON Schema format}
</tools>

<tool_protocol>
1. Analyze the request and determine which tool(s) you need.
2. If multiple independent tools can be called, do it in parallel.
3. If one tool depends on another's output, call them sequentially.
4. After each tool result, verify it makes sense before proceeding.
5. If a result is empty or an error, retry once with corrected parameters.
6. If you cannot resolve within 8 tool calls, respond with what you know.
</tool_protocol>

<output_format>
For each tool call, output a single JSON object on its own line:
{"name": "tool_name", "arguments": {"param": "value"}}

Rules:
- "name" must match a tool from the provided tool list exactly.
- "arguments" must be a JSON object with the required parameters.
- Each call on its own line. Multiple calls = multiple lines.
- No text outside the JSON lines.
- No XML, no backticks, no fences, no explanations around tool calls.
</output_format>

<constraints>
- Maximum 8 tool calls per request.
- Never call a tool not in the provided tool list.
- Never invent parameters — if you don't have the data, ask.
- Never fabricate tool results — wait for actual output.
- Never repeat the exact same tool call with identical arguments.
- If uncertain, respond with what you know rather than guessing.
</constraints>

<stop_conditions>
Stop calling tools and respond when:
- The user's request is fully resolved.
- You hit the 8-call limit.
- The required data cannot be obtained after retry.
- The next step requires user input or clarification.
</stop_conditions>
```

**Design decisions justified by research**:

| Decision | Source | Why |
|----------|--------|-----|
| XML-tagged sections | Anthropic, Claude Code, Qwen Hermes | Qwen's native template format; unambiguous parsing |
| Tool descriptions via API `tools` param | OpenAI (strict mode) | Schema validation, ensure adherence to format |
| JSON-only output contract | OpenAI, Cursor, Windsurf | Pinned in system, not user message |
| Parallel vs sequential guidance | Anthropic, Claude Code | Maximizes efficiency while preventing dependency bugs |
| Hard iteration cap (8) | Community consensus | Both in prompt AND code |
| Fail-first descriptions | Community consensus | "Never" statements reduce hallucination |
| No prose unless asked | Cursor, Windsurf | Solves verbosity problem |
| Anti-repetition rule | Claude Code | Prevents degenerate loops (Qwen bug #8) |

### Implementation Notes

1. **For Qwen's native API (via Playwright)**: The prompt is set via the Personalization API's `personalization.instruction` field, applied per-account on login via `configureAccount()`.

2. **If Qwen ever supports native `tools` parameter**: Switch to OpenAI-compatible `tools` format with `strict: true`, remove inline tool descriptions from the system prompt.

3. **Thinking mode**: Use `enable_thinking: false` when tool calling is active for maximum reliability, or `preserve_thinking: true` if thinking is required.

4. **Error recovery**: The prompt delegates error handling to the tool_protocol (retry once, then escalate). Code-level enforcement of the 8-call limit catches infinite loops.
