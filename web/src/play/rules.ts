// Rules for the casual "just play" mode: dealing a game in the browser and
// deciding what a tap on a card should do. Moves themselves are applied with
// the shared replay logic in ../game (applyMove), so completion and flipping
// behave exactly as in the solver's player.

import type { Card, Column, GameState, Move } from '../game';
import { COLS } from '../game';

// ---- Deal (a port of crates/core rng.rs + Board::deal) ----
//
// Same xorshift64* and Fisher–Yates as the engine, so a (suits, seed) pair gives
// the identical deal the solver API would produce — handy for handing a game to
// the solver later.

const MASK = (1n << 64n) - 1n;

class Rng {
  private s: bigint;
  constructor(seed: number) {
    this.s = (BigInt(seed) ^ 0x9e3779b97f4a7c15n) & MASK;
  }
  next(): bigint {
    let x = this.s;
    x ^= x >> 12n;
    x = (x ^ (x << 25n)) & MASK;
    x ^= x >> 27n;
    this.s = x;
    return (x * 0x2545f4914f6cdd1dn) & MASK;
  }
  below(n: number): number {
    return Number(this.next() % BigInt(n));
  }
  shuffle<T>(a: T[]) {
    for (let i = a.length - 1; i >= 1; i--) {
      const j = this.below(i + 1);
      [a[i], a[j]] = [a[j], a[i]];
    }
  }
}

/** Deal a fresh game, exactly as `Board::deal(suits, seed)` does. */
export function dealGame(suits: number, seed: number): GameState {
  const copies = 8 / suits; // 1 → 8, 2 → 4, 4 → 2 (always 104 cards)
  const deck: Card[] = [];
  for (let s = 0; s < suits; s++) {
    for (let k = 0; k < copies; k++) for (let r = 1; r <= 13; r++) deck.push({ rank: r, suit: s });
  }
  new Rng(seed).shuffle(deck);
  deck.forEach((c, i) => (c.id = i));

  let idx = 0;
  const columns: Column[] = [];
  for (let c = 0; c < COLS; c++) {
    const n = c < 4 ? 6 : 5;
    columns.push({ cards: deck.slice(idx, idx + n), faceDown: n - 1 });
    idx += n;
  }
  // The remaining 50; a deal pops 10 from the back, as in the engine.
  return { columns, stock: deck.slice(idx), completed: 0, completedSuits: [] };
}

export const randomSeed = () => Math.floor(Math.random() * 1_000_000_000);

// ---- Legality ----

/** Index of the lowest card of the same-suit descending run on top of `col`. */
export function runStart(col: Column): number {
  const cards = col.cards;
  let i = cards.length - 1;
  if (i < 0) return 0;
  while (i > col.faceDown) {
    const lower = cards[i - 1];
    if (lower.suit === cards[i].suit && lower.rank === cards[i].rank + 1) i--;
    else break;
  }
  return i;
}

/** Can the card at `index` (and everything on top of it) be picked up? */
export const canPickUp = (col: Column, index: number) =>
  index >= col.faceDown && index < col.cards.length && index >= runStart(col);

/** Length of the same-suit descending run on top of `col`. */
const suitedRunLen = (col: Column) => (col.cards.length ? col.cards.length - runStart(col) : 0);

/**
 * Can the stack from `from[index]` land on column `to`? Onto a card one rank
 * higher (any suit), or onto an empty column — except moving a whole face-up
 * column into an empty one, which changes nothing.
 */
export function canDrop(state: GameState, from: number, index: number, to: number): boolean {
  if (to === from) return false;
  const src = state.columns[from];
  if (!canPickUp(src, index)) return false;
  const dest = state.columns[to].cards;
  if (dest.length === 0) return index > 0;
  return dest[dest.length - 1].rank === src.cards[index].rank + 1;
}

/**
 * Where a single tap sends the stack from `from[index]`, or null if nowhere:
 *   1. a column whose top card is the same suit — preferring the one that ends
 *      with the longest same-suit run;
 *   2. a column whose top card is a different suit;
 *   3. an empty column.
 * Ties go to the leftmost column.
 */
export function autoTarget(state: GameState, from: number, index: number): number | null {
  const src = state.columns[from];
  if (!canPickUp(src, index)) return null;
  const card = src.cards[index];
  const count = src.cards.length - index;

  let bestSame: number | null = null;
  let bestLen = -1;
  let firstOther: number | null = null;
  let firstEmpty: number | null = null;
  for (let to = 0; to < COLS; to++) {
    if (!canDrop(state, from, index, to)) continue;
    const dest = state.columns[to];
    if (dest.cards.length === 0) {
      if (firstEmpty === null) firstEmpty = to;
    } else if (dest.cards[dest.cards.length - 1].suit === card.suit) {
      const len = count + suitedRunLen(dest);
      if (len > bestLen) {
        bestLen = len;
        bestSame = to;
      }
    } else if (firstOther === null) {
      firstOther = to;
    }
  }
  return bestSame ?? firstOther ?? firstEmpty;
}

/** Standard rule: dealing needs stock and no empty column. */
export const canDeal = (state: GameState) =>
  state.stock.length > 0 && state.columns.every((c) => c.cards.length > 0);

export const tableauMove = (state: GameState, from: number, index: number, to: number): Move => ({
  type: 'tableau',
  from,
  to,
  count: state.columns[from].cards.length - index,
});
