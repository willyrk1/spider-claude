// A faithful TypeScript port of the parts of the Rust engine needed to *replay*
// a solution: apply tableau moves and deals, flip exposed cards, and remove
// completed K..A runs. Used to animate the solver's moves step by step.
//
// Cards use the same encoding as the core: rank 1..13 (A=1, K=13), suit 0..3
// (0=spades, 1=hearts, 2=clubs, 3=diamonds).

export type Card = { rank: number; suit: number };

export type Move =
  | { type: 'tableau'; from: number; to: number; count: number }
  | { type: 'deal' };

export type Column = { cards: Card[]; faceDown: number };
export type GameState = {
  columns: Column[];
  stock: Card[];
  completed: number;
  /** Suit of each completed K..A run, in completion order (length === completed). */
  completedSuits: number[];
};

export const COLS = 10;

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

// Four-colour deck: spades black, hearts red, clubs green, diamonds blue.
export const suitClass = (suit: number): string =>
  ['black', 'red', 'green', 'blue'][suit] ?? 'black';

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

// ---- Track & solve: the initial deal (knowledge) + a log of actions ----
//
// The whole game is determined by the initial deck. As you play you *learn*
// that deck (reveals fill it in); moves and deals are the reversible actions.
// So the session = the (partially-known) initial deal + the action log, and the
// current board is derived by replaying the actions on the initial deal.

const SUIT_SHORT = ['s', 'h', 'c', 'd'];
const TABLEAU_SIZES = [6, 6, 6, 6, 5, 5, 5, 5, 5, 5];

/** Card as shorthand, e.g. "Ks", "10h". */
export function cardToShort(card: Card): string {
  const r = card.rank;
  const rn =
    r === 1 ? 'A' : r === 10 ? '10' : r === 11 ? 'J' : r === 12 ? 'Q' : r === 13 ? 'K' : String(r);
  return rn + (SUIT_SHORT[card.suit] ?? '?');
}

/** A reference to a fixed position in the initial deck. */
export type Origin =
  | { src: 't'; col: number; pos: number } // initial tableau card (col, bottom→top index)
  | { src: 's'; idx: number }; // initial stock card (deal order)

/** What we know of the initial deck; `null` = not yet revealed. */
export type InitialDeal = {
  tableau: (Card | null)[][]; // 10 columns, sizes 6,6,6,6,5,5,5,5,5,5, bottom→top
  stock: (Card | null)[]; // 50, in deal order (10 dealt per row, cols 0..9)
};

/** A reversible action (never a reveal). */
export type Action =
  | { kind: 'move'; from: number; to: number; count: number }
  | { kind: 'deal' };

export function newInitialDeal(): InitialDeal {
  return {
    tableau: TABLEAU_SIZES.map((n) => Array.from({ length: n }, () => null as Card | null)),
    stock: Array.from({ length: 50 }, () => null as Card | null),
  };
}

export const originValue = (deal: InitialDeal, o: Origin): Card | null =>
  o.src === 't' ? deal.tableau[o.col][o.pos] : deal.stock[o.idx];

// The derived board holds Origin references; values are looked up in the deal.
type OriginColumn = { faceDown: number; cards: Origin[] };
export type OriginBoard = { columns: OriginColumn[]; stockDealt: number };

function initialOriginBoard(): OriginBoard {
  return {
    columns: TABLEAU_SIZES.map((n, col) => ({
      faceDown: n - 1,
      cards: Array.from({ length: n }, (_, pos) => ({ src: 't', col, pos }) as Origin),
    })),
    stockDealt: 0,
  };
}

function completeIfPossible(col: OriginColumn, deal: InitialDeal) {
  const n = col.cards.length;
  if (n < 13) return;
  const vals = col.cards.slice(n - 13).map((o) => originValue(deal, o));
  if (vals.some((v) => v === null)) return;
  const suit = vals[0]!.suit;
  for (let i = 0; i < 13; i++) {
    if (vals[i]!.suit !== suit || vals[i]!.rank !== 13 - i) return;
  }
  col.cards.length = n - 13;
  if (col.cards.length === col.faceDown && col.faceDown > 0) col.faceDown--;
}

function applyAction(ob: OriginBoard, a: Action, deal: InitialDeal): OriginBoard {
  const nb: OriginBoard = {
    columns: ob.columns.map((c) => ({ faceDown: c.faceDown, cards: c.cards.slice() })),
    stockDealt: ob.stockDealt,
  };
  if (a.kind === 'deal') {
    for (let c = 0; c < COLS; c++) nb.columns[c].cards.push({ src: 's', idx: nb.stockDealt + c });
    nb.stockDealt += COLS;
    for (const col of nb.columns) completeIfPossible(col, deal);
    return nb;
  }
  const from = nb.columns[a.from];
  const to = nb.columns[a.to];
  const moved = from.cards.splice(from.cards.length - a.count, a.count);
  to.cards.push(...moved);
  if (from.cards.length === from.faceDown && from.faceDown > 0) from.faceDown--;
  completeIfPossible(to, deal);
  return nb;
}

/** Replay the actions on the initial deal to get the current board. */
export function deriveBoard(deal: InitialDeal, actions: Action[]): OriginBoard {
  let ob = initialOriginBoard();
  for (const a of actions) ob = applyAction(ob, a, deal);
  return ob;
}

export const stockRemaining = (ob: OriginBoard) => 50 - ob.stockDealt;

/** Columns whose top (face-up) card hasn't been revealed yet — need typing in. */
export function revealTargets(ob: OriginBoard, deal: InitialDeal): number[] {
  const out: number[] = [];
  ob.columns.forEach((c, i) => {
    if (c.cards.length > c.faceDown && originValue(deal, c.cards[c.cards.length - 1]) === null) {
      out.push(i);
    }
  });
  return out;
}

export const hasUnrevealed = (ob: OriginBoard, deal: InitialDeal) =>
  revealTargets(ob, deal).length > 0;

/** Nothing is unknown anymore (tableau + undealt stock) → ready to solve. */
export function fullyKnown(ob: OriginBoard, deal: InitialDeal): boolean {
  for (const c of ob.columns) for (const o of c.cards) if (originValue(deal, o) === null) return false;
  for (let i = ob.stockDealt; i < 50; i++) if (deal.stock[i] === null) return false;
  return true;
}

/**
 * If exactly one card in the whole deck is still unknown, deduce it — it's the
 * one card missing from everything else you've entered. (You never need to
 * uncover the very last card.) Returns null unless exactly one is unknown.
 */
export function deduceLastUnknown(deal: InitialDeal, suits: number): Card | null {
  const copies = 8 / suits; // 4-suit → 2, 2-suit → 4, 1-suit → 8
  const remaining = new Map<string, number>();
  for (let s = 0; s < suits; s++) for (let r = 1; r <= 13; r++) remaining.set(`${r},${s}`, copies);

  let unknowns = 0;
  const account = (c: Card | null) => {
    if (c === null) unknowns++;
    else remaining.set(`${c.rank},${c.suit}`, (remaining.get(`${c.rank},${c.suit}`) ?? 0) - 1);
  };
  for (const col of deal.tableau) for (const c of col) account(c);
  for (const c of deal.stock) account(c);

  if (unknowns !== 1) return null;
  for (const [key, n] of remaining) {
    if (n > 0) {
      const [rank, suit] = key.split(',').map(Number);
      return { rank, suit };
    }
  }
  return null;
}

/** Fill the single unknown slot in the deal with `card`. */
export function fillOnlyUnknown(deal: InitialDeal, card: Card): InitialDeal {
  const nd: InitialDeal = { tableau: deal.tableau.map((t) => t.slice()), stock: deal.stock.slice() };
  for (const col of nd.tableau) {
    const i = col.indexOf(null);
    if (i >= 0) {
      col[i] = card;
      return nd;
    }
  }
  const j = nd.stock.indexOf(null);
  if (j >= 0) nd.stock[j] = card;
  return nd;
}

/** Record the card just revealed at column `col`'s top into the initial deal. */
export function revealAt(deal: InitialDeal, ob: OriginBoard, col: number, card: Card): InitialDeal {
  const c = ob.columns[col];
  if (c.cards.length <= c.faceDown) return deal;
  const o = c.cards[c.cards.length - 1];
  if (originValue(deal, o) !== null) return deal;
  const nd: InitialDeal = { tableau: deal.tableau.map((t) => t.slice()), stock: deal.stock.slice() };
  if (o.src === 't') nd.tableau[o.col][o.pos] = card;
  else nd.stock[o.idx] = card;
  return nd;
}

/** Renderable state; unknown cards (face-down or revealed-unfilled) use rank 0. */
export function boardDisplayState(ob: OriginBoard, deal: InitialDeal): GameState {
  return {
    columns: ob.columns.map((c) => ({
      cards: c.cards.map((o) => originValue(deal, o) ?? { rank: 0, suit: 0 }),
      faceDown: c.faceDown,
    })),
    stock: [],
    completed: 0,
    completedSuits: [],
  };
}

/**
 * A fully-known board as a solvable GameState for the solution player. Keeps
 * the real face-down counts (so they render as backs and flip up during the
 * solution, exactly like the Solve tab) and the undealt stock in the engine's
 * deal order (see `planStock`).
 */
export function boardToGameState(ob: OriginBoard, deal: InitialDeal): GameState {
  return {
    columns: ob.columns.map((c) => ({
      cards: c.cards.map((o) => originValue(deal, o)!),
      faceDown: c.faceDown,
    })),
    stock: stockForEngine(ob, deal) as Card[],
    completed: 0,
    completedSuits: [],
  };
}

/** The current position as a /plan request (columns + undealt stock). */
export function planColumns(ob: OriginBoard, deal: InitialDeal) {
  return ob.columns.map((c) => ({
    face_down: c.faceDown,
    cards: c.cards.map((o) => originValue(deal, o)) as (Card | null)[],
  }));
}

/**
 * The undealt stock in the order the engine expects. The engine (and the
 * replay) deal by popping from the *end*, so reversing the deal-order stock
 * makes `col c` receive `stock[stockDealt + c]` — matching the real deal order.
 */
function stockForEngine(ob: OriginBoard, deal: InitialDeal): (Card | null)[] {
  return deal.stock.slice(ob.stockDealt).reverse();
}
export const planStock = stockForEngine;

// ---- Session save / load (initial deal + actions) ----

function parseCardTokens(str: string): { cards: (Card | null)[]; error?: string } {
  const out: (Card | null)[] = [];
  for (const tok of str.trim().split(/\s+/).filter(Boolean)) {
    if (tok === '?') {
      out.push(null);
      continue;
    }
    const { cards, error } = parseCards(tok);
    if (error || cards.length !== 1) return { cards: [], error: `bad card "${tok}"` };
    out.push(cards[0]);
  }
  return { cards: out };
}

/** Human-readable session: the initial deal plus the action log. */
export function serializeTrack(suits: number, deal: InitialDeal, actions: Action[]): string {
  const short = (c: Card | null) => (c ? cardToShort(c) : '?');
  const lines = [`suits: ${suits}`];
  deal.tableau.forEach((col, i) => lines.push(`t${i}: ${col.map(short).join(' ')}`));
  lines.push(`stock: ${deal.stock.map(short).join(' ')}`);
  for (const a of actions) {
    lines.push(a.kind === 'move' ? `move ${a.from} ${a.to} ${a.count}` : 'deal');
  }
  return lines.join('\n');
}

export function parseTrack(
  text: string,
): { suits?: number; deal?: InitialDeal; actions?: Action[]; error?: string } {
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  const sm = lines[0]?.match(/^suits:\s*([124])$/i);
  if (!sm) return { error: 'first line must be "suits: 1", "suits: 2", or "suits: 4"' };

  const tableau: (Card | null)[][] = [];
  for (let i = 0; i < 10; i++) {
    const m = lines[1 + i]?.match(/^t(\d):\s*(.*)$/);
    if (!m || Number(m[1]) !== i) return { error: `expected line ${i + 2} to be "t${i}: ..."` };
    const { cards, error } = parseCardTokens(m[2]);
    if (error) return { error: `t${i}: ${error}` };
    if (cards.length !== TABLEAU_SIZES[i]) {
      return { error: `t${i}: expected ${TABLEAU_SIZES[i]} cards, got ${cards.length}` };
    }
    tableau.push(cards);
  }

  const sMatch = lines[11]?.match(/^stock:\s*(.*)$/);
  if (!sMatch) return { error: 'expected a "stock: ..." line' };
  const { cards: stock, error: stockErr } = parseCardTokens(sMatch[1]);
  if (stockErr) return { error: `stock: ${stockErr}` };
  if (stock.length !== 50) return { error: `stock: expected 50 cards, got ${stock.length}` };

  const actions: Action[] = [];
  for (let i = 12; i < lines.length; i++) {
    const p = lines[i].split(/\s+/);
    if (p[0] === 'move') {
      const [from, to, count] = [parseInt(p[1], 10), parseInt(p[2], 10), parseInt(p[3], 10)];
      if ([from, to, count].some((n) => Number.isNaN(n))) {
        return { error: `line ${i + 1}: bad move "${lines[i]}"` };
      }
      actions.push({ kind: 'move', from, to, count });
    } else if (p[0] === 'deal') {
      actions.push({ kind: 'deal' });
    } else {
      return { error: `line ${i + 1}: unknown action "${p[0]}"` };
    }
  }
  return { suits: Number(sm[1]), deal: { tableau, stock }, actions };
}
