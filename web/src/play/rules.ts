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

// ---- Hints ----

export type Hint = { type: 'move'; from: number; index: number; to: number } | { type: 'deal' };

/**
 * How useful moving `from[index]` onto `to` is (0 = legal but pointless):
 * turning up a face-down card or emptying a column matters most, then building
 * same-suit runs. Taking a card off a parent it's already in sequence with only
 * counts if it trades an off-suit parent for a same-suit one.
 */
function moveValue(state: GameState, from: number, index: number, to: number): number {
  const col = state.columns[from];
  const card = col.cards[index];
  const dest = state.columns[to];
  const destTop = dest.cards[dest.cards.length - 1];
  const destSame = destTop !== undefined && destTop.suit === card.suit;
  const parent = index > col.faceDown ? col.cards[index - 1] : undefined;
  if (parent && parent.rank === card.rank + 1) {
    if (parent.suit === card.suit || !destSame) return 0; // a shuffle, not progress
  }
  let v = 0;
  if (index === col.faceDown && col.faceDown > 0) v += 100; // turns a card up
  if (index === 0) v += 60; // empties a column
  if (parent) v += 20; // uncovers a playable card it wasn't in sequence with
  if (destSame) v += 30 + (col.cards.length - index) + suitedRunLen(dest);
  if (!destTop) v -= 40; // spends an empty column
  return Math.max(0, v);
}

/**
 * Legal moves, best first: useful moves by value, then a deal (if allowed),
 * then any remaining legal-but-pointless moves. Empty columns are
 * interchangeable, so only the first is offered as a target.
 */
export function hints(state: GameState): Hint[] {
  const firstEmpty = state.columns.findIndex((c) => c.cards.length === 0);
  const useful: { h: Hint; v: number }[] = [];
  const pointless: Hint[] = [];
  for (let from = 0; from < COLS; from++) {
    const col = state.columns[from];
    for (let index = runStart(col); index < col.cards.length; index++) {
      for (let to = 0; to < COLS; to++) {
        if (state.columns[to].cards.length === 0 && to !== firstEmpty) continue;
        if (!canDrop(state, from, index, to)) continue;
        const h: Hint = { type: 'move', from, index, to };
        const v = moveValue(state, from, index, to);
        if (v > 0) useful.push({ h, v });
        else pointless.push(h);
      }
    }
  }
  useful.sort((a, b) => b.v - a.v);
  return [...useful.map((u) => u.h), ...(canDeal(state) ? [{ type: 'deal' } as Hint] : []), ...pointless];
}

export const sameMove = (a: Move, b: Move) =>
  a.type === 'deal'
    ? b.type === 'deal'
    : b.type === 'tableau' && a.from === b.from && a.to === b.to && a.count === b.count;

export const tableauMove = (state: GameState, from: number, index: number, to: number): Move => ({
  type: 'tableau',
  from,
  to,
  count: state.columns[from].cards.length - index,
});
