import { describe, expect, it } from 'vitest';
import { fuzzyFilter, fuzzyScore } from '../src/shared/fuzzy';

describe('fuzzy', () => {
  it('ranks word-start matches higher', () => {
    expect(fuzzyScore('bd', 'bot-discord')!).toBeGreaterThan(fuzzyScore('bd', 'abcd')!);
  });

  it('returns null when not a subsequence', () => {
    expect(fuzzyScore('xyz', 'bot-discord')).toBeNull();
  });

  it('filter keeps order by score and returns all for empty query', () => {
    const items = ['opl-raport', 'bot-discord', 'MULTICODING'];
    expect(fuzzyFilter(items, '', (x) => x)).toEqual(items);
    expect(fuzzyFilter(items, 'mc', (x) => x)[0]).toBe('MULTICODING');
    expect(fuzzyFilter(items, 'bot', (x) => x)).toEqual(['bot-discord']);
  });
});
