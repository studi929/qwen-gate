import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildPromptAndSystem } from './chatHelpers.ts';

test('tool prompt forbids Qwen native tool calls and requires gateway JSON only', () => {
  const { systemPrompt } = buildPromptAndSystem(
    [{ role: 'user', content: 'Weather in Paris?' }],
    {
      model: 'qwen3.7-max-no-thinking',
      tools: [
        {
          type: 'function',
          function: {
            name: 'get_weather',
            description: 'Get weather',
            parameters: {
              type: 'object',
              properties: { city: { type: 'string' } },
              required: ['city'],
            },
          },
        },
      ],
    },
    4096,
    true,
  );

  assert.match(systemPrompt, /Do NOT use Qwen native tools/i);
  assert.match(systemPrompt, /plain JSON object/i);
  assert.match(systemPrompt, /\{"name":"get_weather","arguments":\{"city":"Paris"\}\}/);
});
