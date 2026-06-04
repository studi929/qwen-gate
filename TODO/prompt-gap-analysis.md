# System Prompt Gap Analysis — Current vs Research

## Scoring (out of possible best practices)

| Practice | Source | Have? | Score |
|----------|--------|-------|-------|
| XML-tagged sections | Anthropic, Qwen | ✅ | 10/10 |
| Role/Identity anchoring | Anthropic (primacy) | ⚠️ Weak name | 5/10 |
| Objective/Goal | OpenAI Four-Block | ✅ | 8/10 |
| Structured tool protocol | EMNLP 2025 (templates > CoT) | ✅ | 8/10 |
| Output format pinned in system | OpenAI strict, Community consensus | ✅ | 10/10 |
| Response format (no preamble) | Claude Code, Cursor | ✅ | 8/10 |
| Anti-hallucination rules | Qwen community fix | ⚠️ Too long + wrong position | 5/10 |
| Loop prevention | Community consensus | ✅ | 8/10 |
| Stop conditions | Anthropic pattern | ✅ | 8/10 |
| Memory/context handling | Qwen bug #3 (argument collapse) | ❌ Inaccurate | 3/10 |
| **Default-to-Action** | Anthropic | ❌ MISSING | 0/10 |
| **Agentic Persistence** (decompose sub-requests) | OpenAI | ❌ MISSING | 0/10 |
| **Anti-Rationalization** (don't skip calls) | Claude Code | ❌ MISSING | 0/10 |
| **Tool leak prevention** (don't name tools to user) | Cursor, Windsurf | ❌ MISSING | 0/10 |
| **Negative constraints at end** | Google DeepMind | ❌ Wrong position | 0/10 |
| **Final recap of load-bearing rule** | DeepMind, Community | ❌ MISSING | 0/10 |
| **Examples / few-shot** | OpenAI, Anthropic | ❌ MISSING | 0/10 |
| **Tool use examples in descriptions** | Anthropic (2025) | ❌ MISSING | 0/10 |
| **Evidence handling** (trusted vs untrusted) | Claude Code | ❌ MISSING | 0/10 |
| **"Read entire result" emphasis** | Research | ⚠️ Implied, not explicit | 4/10 |
| **"Lead with the answer"** | Claude Code | ❌ MISSING | 0/10 |
| **End-of-prompt hard boundary** | Community consensus | ❌ MISSING | 0/10 |
| **Agent identity name** | Cline, Cascade, Devin | ❌ Just "a tool-calling AI agent" | 2/10 |

**Overall: ~50/230 = 22% of research best practices covered. Significant gaps.**

## Key Gaps to Fix (ordered by impact)

1. **Negative constraints at end** (DeepMind) — anti_hallucination block must move to end
2. **Final recap** (DeepMind) — restate load-bearing rule at the very end
3. **Default-to-Action** (Anthropic) — shift from passive "call when needed" to proactive "default to action"
4. **Agentic Persistence** (OpenAI) — decompose sub-requests, keep going until done
5. **Anti-Rationalization** (Claude Code) — don't skip tool calls, don't promise future actions
6. **Tool leak prevention** (Cursor/Windsurf) — don't name tools to user
7. **Read entire result** — explicit instruction
8. **Condense anti-hallucination** — top 6 most critical only (research: models tune out after 5-6)
9. **Hard boundary at end** — "Return ONLY the JSON. No prose."
10. **Fix memory section** — accurate about conversation history retention
