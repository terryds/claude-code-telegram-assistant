import { describe, expect, test } from 'bun:test';
import { normalizeMarkdownForTelegram } from './telegram';

describe('normalizeMarkdownForTelegram', () => {
  test('inserts a blank line between a paragraph and a table', () => {
    const input = ['**Hotels (Sat 21 → Wed 25)**', '| | A | B |', '|---|---|---|', '| Hotels | 1 | 2 |', 'So B wins.'].join('\n');
    expect(normalizeMarkdownForTelegram(input)).toBe(
      ['**Hotels (Sat 21 → Wed 25)**', '', '| | A | B |', '|---|---|---|', '| Hotels | 1 | 2 |', '', 'So B wins.'].join('\n')
    );
  });

  test('leaves already well-formed tables untouched', () => {
    const input = ['Intro', '', '| a | b |', '|---|---|', '| 1 | 2 |', '', 'Outro'].join('\n');
    expect(normalizeMarkdownForTelegram(input)).toBe(input);
  });

  test('handles a table at the very start and end', () => {
    const input = ['| a | b |', '|---|---|', '| 1 | 2 |'].join('\n');
    expect(normalizeMarkdownForTelegram(input)).toBe(input);
  });

  test('ignores pipes inside fenced code blocks', () => {
    const input = ['text', '```', 'x | y', '---|---', 'a | b', '```', 'after'].join('\n');
    expect(normalizeMarkdownForTelegram(input)).toBe(input);
  });

  test('does not treat a horizontal rule as a table delimiter', () => {
    const input = ['a | b', '---', 'c'].join('\n');
    expect(normalizeMarkdownForTelegram(input)).toBe(input);
  });

  test('handles back-to-back tables separated by a heading', () => {
    const input = ['**One**', '| a |', '|---|', '| 1 |', '**Two**', '| b |', '|---|', '| 2 |'].join('\n');
    expect(normalizeMarkdownForTelegram(input)).toBe(
      ['**One**', '', '| a |', '|---|', '| 1 |', '', '**Two**', '', '| b |', '|---|', '| 2 |'].join('\n')
    );
  });
});
