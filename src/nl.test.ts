import { describe, it, expect } from 'vitest';
import { buildSentPayload, type SentPayload } from './nl';

// F2 transparency: the disclosure is rendered from the SAME object the request
// is serialized from. These tests pin that invariant (the flat fields the UI
// shows are the identical values embedded in `body`) and the per-provider shape.
// buildSentPayload is pure — no network, no DOM — so it runs directly here.

const SCHEMA = '{\n  id: number\n  tasks: array(3) of { status: string }\n}';
const QUESTION = 'how many tasks failed?';

describe('buildSentPayload', () => {
  it('routes sk-ant- keys to Anthropic with system + user message', () => {
    const s = buildSentPayload('sk-ant-abc123', SCHEMA, QUESTION);
    expect(s.provider).toBe('anthropic');
    expect(s.endpoint).toBe('https://api.anthropic.com/v1/messages');
    expect(s.model).toBe(s.body.model);
    const body = s.body as { model: string; system: string; max_tokens: number; messages: { role: string; content: string }[] };
    expect(body.system).toBe(s.system); // same string reference, not a copy
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]).toEqual({ role: 'user', content: QUESTION });
    expect(body.messages[0].content).toBe(s.question);
  });

  it('routes non-anthropic keys to OpenRouter with system + user roles', () => {
    const s = buildSentPayload('sk-or-v1-xyz', SCHEMA, QUESTION);
    expect(s.provider).toBe('openrouter');
    expect(s.endpoint).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(s.model).toBe(s.body.model);
    const body = s.body as { model: string; messages: { role: string; content: string }[] };
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[0].content).toBe(s.system); // disclosure reads the sent system
    expect(body.messages[1]).toEqual({ role: 'user', content: QUESTION });
    expect(body.messages[1].content).toBe(s.question);
  });

  it('embeds the schema (and only names/types) into the system prompt', () => {
    const s = buildSentPayload('sk-or-1', SCHEMA, QUESTION);
    expect(s.schema).toBe(SCHEMA);
    expect(s.system).toContain(SCHEMA);
    expect(s.system).toContain('shape only'); // the privacy framing is in the prompt
  });

  it('never mutates its inputs and is stable across calls', () => {
    const a = buildSentPayload('sk-ant-k', SCHEMA, QUESTION);
    const b = buildSentPayload('sk-ant-k', SCHEMA, QUESTION);
    expect(a).toEqual(b);
    // The exposed flat fields are exactly the question/schema passed in.
    const check: SentPayload = a;
    expect(check.question).toBe(QUESTION);
    expect(check.schema).toBe(SCHEMA);
  });
});
