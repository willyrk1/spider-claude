// A faithful TypeScript port of the parts of the Rust engine needed to *replay*
// a solution: apply tableau moves and deals, flip exposed cards, and remove
// completed K..A runs. Used to animate the solver's moves step by step.
//
// Cards use the same encoding as the core: rank 1..13 (A=1, K=13), suit 0..3
// (0=spades, 1=hearts, 2=clubs, 3=diamonds).

export type Card = { rank: number; suit: number };
export type ApiCard = { rank: number; suit: number; face_up: boolean };

export type Move =
  | { type: 'tableau'; from: number; to: number; count: number }
  | { type: 'deal' };

export type InitialBoard = {
  columns: ApiCard[][];
  stock: Card[];
  stock_count: number;
};

export type Column = { cards: Card[]; faceDown: number };
export type GameState = {
  columns: Column[];
  stock: Card[];
  completed: number;
  /** Suit of each completed K..A run, in completion order (length === completed). */
  completedSuits: number[];
};

export const COLS = 10;

/** Build the starting game state from the API's board payload. */
export function initialState(board: InitialBoard): GameState {
  const columns = board.columns.map((col) => {
    let faceDown = 0;
    for (const c of col) {
      if (c.face_up) break;
      faceDown++;
    }
    return { cards: col.map((c) => ({ rank: c.rank, suit: c.suit })), faceDown };
  });
  return {
    columns,
    stock: board.stock.map((c) => ({ rank: c.rank, suit: c.suit })),
    completed: 0,
    completedSuits: [],
  };
}

function cloneState(s: GameState): GameState {
  return {
    columns: s.columns.map((c) => ({ cards: c.cards.slice(), faceDown: c.faceDown })),
    stock: s.stock.slice(),
    completed: s.completed,
    completedSuits: s.completedSuits.slice(),
  };
}

function flipIfNeeded(col: Column) {
  if (col.faceDown > 0 && col.cards.length === col.faceDown) col.faceDown--;
}

/** Remove a completed K..A same-suit run from the top of column `c`, if any. */
function tryComplete(state: GameState, c: number) {
  const col = state.columns[c];
  const n = col.cards.length;
  if (n < 13) return;
  if (n - 13 < col.faceDown) return; // the 13 must be face-up
  const suit = col.cards[n - 13].suit;
  for (let i = 0; i < 13; i++) {
    const card = col.cards[n - 13 + i];
    if (card.suit !== suit || card.rank !== 13 - i) return;
  }
  col.cards.length = n - 13;
  state.completed++;
  state.completedSuits.push(suit);
  flipIfNeeded(col);
}

/** Apply one move, returning a new immutable state. */
export function applyMove(prev: GameState, m: Move): GameState {
  const s = cloneState(prev);
  if (m.type === 'deal') {
    for (let c = 0; c < COLS; c++) {
      const card = s.stock.pop();
      if (card) s.columns[c].cards.push(card);
    }
    for (let c = 0; c < COLS; c++) tryComplete(s, c);
  } else {
    const from = s.columns[m.from];
    const to = s.columns[m.to];
    const moved = from.cards.splice(from.cards.length - m.count, m.count);
    to.cards.push(...moved);
    flipIfNeeded(from);
    tryComplete(s, m.to);
  }
  return s;
}

/** Precompute the board state after each move: states[0] = initial. */
export function computeStates(init: GameState, moves: Move[]): GameState[] {
  const states = [init];
  let cur = init;
  for (const m of moves) {
    cur = applyMove(cur, m);
    states.push(cur);
  }
  return states;
}

const RANK_NAMES = ['', 'A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const SUIT_SYMBOLS = ['♠', '♥', '♣', '♦']; // ♠ ♥ ♣ ♦

export const rankName = (rank: number) => RANK_NAMES[rank] ?? '?';
export const suitSymbol = (suit: number) => SUIT_SYMBOLS[suit] ?? '?';
export const isRed = (suit: number) => suit === 1 || suit === 3;

export function describeMove(m: Move): string {
  if (m.type === 'deal') return 'Deal a row from the stock';
  const noun = m.count === 1 ? 'card' : 'cards';
  return `Move ${m.count} ${noun}: column ${m.from} → column ${m.to}`;
}

const SUIT_LETTERS: Record<string, number> = { s: 0, h: 1, c: 2, d: 3 };

/** Parse card shorthand like "Ks Qh 10c" into cards. Suits: s h c d. */
export function parseCards(text: string): { cards: Card[]; error?: string } {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  const cards: Card[] = [];
  for (const tok of tokens) {
    const m = tok.match(/^(10|[2-9]|[atjqkATJQK])([shcdSHCD])$/);
    if (!m) return { cards: [], error: `bad card "${tok}"` };
    const r = m[1].toLowerCase();
    const rank =
      r === 'a' ? 1 : r === 't' || r === '10' ? 10 : r === 'j' ? 11 : r === 'q' ? 12 : r === 'k' ? 13 : Number(r);
    cards.push({ rank, suit: SUIT_LETTERS[m[2].toLowerCase()] });
  }
  return { cards };
}

// ---- Track & solve: a live board with unknown (not-yet-revealed) cards ----

// A face-up slot that's `null` is a card just revealed but not yet typed in.
export type TrackColumn = { faceDown: number; up: (Card | null)[] };
export type TrackBoard = { columns: TrackColumn[]; stockCount: number };

/** A fresh deal: 6 cards in cols 0–3, 5 in cols 4–9, top card face-up (unknown
 *  until you type it), the rest face-down, and 50 in the stock. */
export function newTrackBoard(): TrackBoard {
  return {
    columns: Array.from({ length: COLS }, (_, i) => ({
      faceDown: i < 4 ? 5 : 4,
      up: [null] as (Card | null)[],
    })),
    stockCount: 50,
  };
}

export const hasUnfilled = (b: TrackBoard) =>
  b.columns.some((c) => c.up.some((x) => x === null));

export const allKnown = (b: TrackBoard) =>
  b.stockCount === 0 && b.columns.every((c) => c.faceDown === 0 && c.up.every((x) => x !== null));

function completeIfPossible(col: TrackColumn) {
  const up = col.up;
  if (up.length < 13) return;
  const top = up.slice(up.length - 13);
  if (top.some((c) => c === null)) return;
  const suit = top[0]!.suit;
  for (let i = 0; i < 13; i++) {
    if (top[i]!.suit !== suit || top[i]!.rank !== 13 - i) return;
  }
  up.length -= 13;
  if (up.length === 0 && col.faceDown > 0) {
    col.faceDown--;
    up.push(null); // a newly exposed face-down card
  }
}

/** Apply one move to the live board, exposing a `null` slot when a face-down
 *  card gets uncovered (or when a row is dealt). */
export function applyTrackMove(board: TrackBoard, m: Move): TrackBoard {
  const b: TrackBoard = {
    columns: board.columns.map((c) => ({ faceDown: c.faceDown, up: c.up.slice() })),
    stockCount: board.stockCount,
  };
  if (m.type === 'deal') {
    for (const c of b.columns) c.up.push(null);
    b.stockCount = Math.max(0, b.stockCount - COLS);
    for (const c of b.columns) completeIfPossible(c);
    return b;
  }
  const from = b.columns[m.from];
  const to = b.columns[m.to];
  const moved = from.up.splice(from.up.length - m.count, m.count);
  to.up.push(...moved);
  if (from.up.length === 0 && from.faceDown > 0) {
    from.faceDown--;
    from.up.push(null);
  }
  completeIfPossible(to);
  return b;
}

/** Renderable state; unknown cards (face-down or revealed-unfilled) use rank 0. */
export function trackDisplayState(board: TrackBoard): GameState {
  return {
    columns: board.columns.map((c) => ({
      cards: [
        ...Array.from({ length: c.faceDown }, () => ({ rank: 0, suit: 0 })),
        ...c.up.map((card) => card ?? { rank: 0, suit: 0 }),
      ],
      faceDown: c.faceDown,
    })),
    stock: [],
    completed: 0,
    completedSuits: [],
  };
}

/** Convert a fully-known board into a solvable GameState (for the player). */
export function trackToGameState(board: TrackBoard): GameState {
  return {
    columns: board.columns.map((c) => ({
      cards: c.up.filter((x): x is Card => x !== null),
      faceDown: 0,
    })),
    stock: [],
    completed: 0,
    completedSuits: [],
  };
}

// ---- Track session save / load (copy-paste text) ----

const SUIT_SHORT = ['s', 'h', 'c', 'd'];

/** Card as shorthand, e.g. "Ks", "10h". */
export function cardToShort(card: Card): string {
  const r = card.rank;
  const rn =
    r === 1 ? 'A' : r === 10 ? '10' : r === 11 ? 'J' : r === 12 ? 'Q' : r === 13 ? 'K' : String(r);
  return rn + (SUIT_SHORT[card.suit] ?? '?');
}

// A session is the full sequence of actions from the initial deal, so the
// entire game (and any bug) can be reproduced by replaying it.
export type TrackEvent =
  | { kind: 'reveal'; col: number; card: Card } // a face-down/dealt card typed in
  | { kind: 'move'; from: number; to: number; count: number }
  | { kind: 'deal' };

/** Fill column `col`'s first empty (null) slot with `card`. */
export function revealCard(board: TrackBoard, col: number, card: Card): TrackBoard {
  return {
    ...board,
    columns: board.columns.map((c, i) => {
      if (i !== col) return c;
      const idx = c.up.findIndex((x) => x === null);
      if (idx < 0) return c;
      const up = c.up.slice();
      up[idx] = card;
      return { ...c, up };
    }),
  };
}

/** Rebuild the board by replaying the event log from a fresh deal. */
export function replayLog(log: TrackEvent[]): TrackBoard {
  let b = newTrackBoard();
  for (const e of log) {
    if (e.kind === 'reveal') b = revealCard(b, e.col, e.card);
    else if (e.kind === 'move') {
      b = applyTrackMove(b, { type: 'tableau', from: e.from, to: e.to, count: e.count });
    } else b = applyTrackMove(b, { type: 'deal' });
  }
  return b;
}

/** Human-readable, copy-pasteable action log (one event per line). */
export function serializeTrack(suits: number, log: TrackEvent[]): string {
  const lines = [`suits: ${suits}`];
  for (const e of log) {
    if (e.kind === 'reveal') lines.push(`reveal ${e.col} ${cardToShort(e.card)}`);
    else if (e.kind === 'move') lines.push(`move ${e.from} ${e.to} ${e.count}`);
    else lines.push('deal');
  }
  return lines.join('\n');
}

/** Parse an action log produced by `serializeTrack`. */
export function parseTrack(text: string): { suits?: number; log?: TrackEvent[]; error?: string } {
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  const sm = lines[0]?.match(/^suits:\s*([124])$/i);
  if (!sm) return { error: 'first line must be "suits: 1", "suits: 2", or "suits: 4"' };
  const log: TrackEvent[] = [];
  for (let i = 1; i < lines.length; i++) {
    const p = lines[i].split(/\s+/);
    if (p[0] === 'reveal') {
      const col = parseInt(p[1], 10);
      const { cards, error } = parseCards(p[2] ?? '');
      if (Number.isNaN(col) || col < 0 || col > 9 || error || cards.length !== 1) {
        return { error: `line ${i + 1}: bad reveal "${lines[i]}"` };
      }
      log.push({ kind: 'reveal', col, card: cards[0] });
    } else if (p[0] === 'move') {
      const [from, to, count] = [parseInt(p[1], 10), parseInt(p[2], 10), parseInt(p[3], 10)];
      if ([from, to, count].some((n) => Number.isNaN(n))) {
        return { error: `line ${i + 1}: bad move "${lines[i]}"` };
      }
      log.push({ kind: 'move', from, to, count });
    } else if (p[0] === 'deal') {
      log.push({ kind: 'deal' });
    } else {
      return { error: `line ${i + 1}: unknown event "${p[0]}"` };
    }
  }
  return { suits: Number(sm[1]), log };
}
