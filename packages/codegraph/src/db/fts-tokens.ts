/**
 * Search tokens, exactly as SQLite FTS5's `unicode61` tokenizer made them for
 * the index CodeGraph searched before DuckDB (packages/codegraph-store/
 * DESIGN.md). FTS5 decides token characters and folds from its own Unicode
 * 6.1 tables, not the runtime's, so those tables are derived from FTS5
 * itself (scripts/generate-fts-unicode.mjs) and used here. A token is a run
 * of token characters; each character folds independently (lower case,
 * diacritics removed, a lone diacritic dropped). Checked against FTS5 over
 * real text and hard cases by scripts/fts-token-parity.mjs.
 */

import { FOLDS, TOKEN_RANGES } from './fts-unicode.generated';

const folds = new Map<number, string>();
for (let i = 0; i < FOLDS.length; i += 2) folds.set(FOLDS[i] as number, FOLDS[i + 1] as string);

/** Whether FTS5 treats code point `cp` as part of a token. */
function isTokenChar(cp: number): boolean {
  // Binary search over the flattened [start, end] ranges.
  let low = 0;
  let high = TOKEN_RANGES.length / 2 - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (cp < TOKEN_RANGES[mid * 2]!) high = mid - 1;
    else if (cp > TOKEN_RANGES[mid * 2 + 1]!) low = mid + 1;
    else return true;
  }
  return false;
}

/** One field's tokens, in order. */
export function ftsTokens(text: string | null | undefined): string[] {
  if (!text) return [];
  const tokens: string[] = [];
  let current = '';
  let inToken = false;
  for (const char of text) {
    const cp = char.codePointAt(0)!;
    if (isTokenChar(cp)) {
      current += folds.get(cp) ?? char;
      inToken = true;
    } else if (inToken) {
      if (current) tokens.push(current);
      current = '';
      inToken = false;
    }
  }
  if (inToken && current) tokens.push(current);
  return tokens;
}
