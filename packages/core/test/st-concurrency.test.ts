/**
 * ST-CONC-02 — concurrent session routing does not cross-contaminate turns.
 *
 * The mock echoes each prompt after a delay. Three sessions share one engine
 * process, so the assertions inspect agent-side transcript chunks rather than
 * only the caller's already-known prompt text.
 */
import { describe, expect, it } from 'vitest';
import type { TranscriptEvent } from '../src/transcript/event.js';
import { collect, countSpawns, makeHub, tmp } from './testkit.js';

function agentText(events: TranscriptEvent[]): string[] {
  return events
    .filter((event) => event.update.sessionUpdate === 'agent_message_chunk')
    .flatMap((event) => {
      const content = 'content' in event.update ? event.update.content : undefined;
      return content?.type === 'text' ? [content.text] : [];
    });
}

describe('ST-CONC-02 — concurrent prompts keep session transcripts isolated (AC-3.3)', () => {
  it('routes each interleaved response only to the session that requested it', async () => {
    const codewords = ['ROUTING-ALPHA', 'ROUTING-BRAVO', 'ROUTING-CHARLIE'] as const;
    const trace = `${tmp('runskein-conc-trace-')}/spawns.log`;
    const hub = makeHub({
      MOCK_ECHO_PROMPT: '1',
      MOCK_PROMPT_DELAY_MS: '80',
      MOCK_TRACE_FILE: trace,
    });
    const sessions = [];
    for (const codeword of codewords) {
      sessions.push(
        await hub.session({ engine: 'mock', cwd: tmp(`runskein-conc-${codeword.toLowerCase()}-`) }),
      );
    }
    expect(countSpawns(trace)).toBe(1);

    await Promise.all(sessions.map((session, index) => session.prompt(codewords[index]!)));

    for (const [index, session] of sessions.entries()) {
      const replies = agentText(await collect(session.transcript()));
      expect(replies).toEqual([codewords[index]]);
      for (const foreign of codewords.filter((_, foreignIndex) => foreignIndex !== index)) {
        expect(replies.join('')).not.toContain(foreign);
      }
    }

    await Promise.all(sessions.map((session) => session.close()));
  });
});
