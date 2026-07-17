import { describe, expect, it } from 'vitest';
import { createDeterministicDemoPeople } from './index.js';
describe('deterministic demo fixtures', () => {
  it('replays identically for the same seed', () => {
    expect(createDeterministicDemoPeople(42, 3)).toEqual(
      createDeterministicDemoPeople(42, 3),
    );
  });
  it('rejects unbounded fixture counts', () => {
    expect(() => createDeterministicDemoPeople(42, 10_001)).toThrow();
  });
});
