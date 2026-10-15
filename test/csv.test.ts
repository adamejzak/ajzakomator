import { describe, expect, it } from 'vitest';
import { detectDelimiter, parseDelimited } from '../src/shared/csv';

describe('csv', () => {
  it('parses quoted fields, doubled quotes and CRLF', () => {
    const { rows } = parseDelimited('a,b\r\n"x,1","he said ""hi"""\r\n', ',');
    expect(rows).toEqual([['a', 'b'], ['x,1', 'he said "hi"']]);
  });
  it('keeps newlines inside quotes and the last row without a trailing newline', () => {
    expect(parseDelimited('a,b\n"1\n2",3', ',').rows).toEqual([['a', 'b'], ['1\n2', '3']]);
  });
  it('detects the delimiter', () => {
    expect(detectDelimiter('a;b;c\n1;2;3')).toBe(';');
    expect(detectDelimiter('a\tb\n1\t2', 'tsv')).toBe('\t');
    expect(detectDelimiter('a,b,c\n1,2,3')).toBe(',');
  });
  it('stops at the row limit', () => {
    const result = parseDelimited('1\n2\n3\n4', ',', 2);
    expect(result.rows).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });
});
