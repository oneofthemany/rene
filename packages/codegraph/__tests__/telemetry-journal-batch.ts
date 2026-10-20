/**
 * Reads a telemetry request as the journal receives it: `{ records: [...] }`,
 * one flat record per event, each carrying the same machine/version envelope.
 * Asserts that shape, then returns the envelope with its events, so tests can
 * check what was sent without restating the wire format.
 */
import { expect } from 'vitest';

const ENVELOPE = ['machine_id', 'codegraph_version', 'os', 'arch', 'node_major', 'ci', 'schema_version'] as const;

export function fromJournalBatch(raw: string): Record<string, unknown> & { events: Record<string, unknown>[] } {
  const body = JSON.parse(raw) as Record<string, unknown>;
  expect(Object.keys(body)).toEqual(['records']);
  const records = body.records as Record<string, unknown>[];
  expect(records.length).toBeGreaterThan(0);
  const envelope = Object.fromEntries(ENVELOPE.map((key) => [key, records[0]![key]]));
  const events = records.map((record) => {
    const event: Record<string, unknown> = { ...record };
    for (const key of ENVELOPE) {
      expect(record[key], key).toEqual(envelope[key]);
      delete event[key];
    }
    return event;
  });
  return { ...envelope, events };
}
