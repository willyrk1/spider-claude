import { useLayoutEffect, useRef } from 'react';
import type { Column, GameState, Move } from './game';
import { COLS, rankName, suitClass, suitSymbol } from './game';

const CARD_H = 92; // card height (px), matches --card-h
const BASE_DOWN = 15; // vertical px each covered face-down card contributes
const BASE_UP = 30; //   ...and each covered face-up card
// Horizontal distance between adjacent columns: card width (--card-w 66px) plus
// the .board flex gap (8px). Kept in sync with index.css.
const COL_PITCH = 74;
// Squish tall boards so they fit without a big page scroll. If the tallest
// column exceeds this, every column's overlap shrinks proportionally (down to a
// floor that keeps each card's rank corner readable).
const TARGET_H = 540;
const MIN_UP = 14;
const MIN_DOWN = 7;

type Steps = { up: number; down: number };

/** Per-board vertical overlap, scaled down so the tallest column fits TARGET_H. */
function computeSteps(state: GameState): Steps {
  let maxStack = 0;
  for (const col of state.columns) {
    let h = 0;
    for (let i = 0; i < col.cards.length - 1; i++) h += i < col.faceDown ? BASE_DOWN : BASE_UP;
    if (h > maxStack) maxStack = h;
  }
  const scale = maxStack + CARD_H > TARGET_H ? (TARGET_H - CARD_H) / maxStack : 1;
  return { up: Math.max(MIN_UP, BASE_UP * scale), down: Math.max(MIN_DOWN, BASE_DOWN * scale) };
}

type Props = {
  state: GameState;
  move: Move | null;
  showStock?: boolean;
  /** The state before `move`, so a forward step can animate the moved cards. */
  prevState?: GameState | null;
  /** Bumped only on a forward step (Next / Play); triggers the slide animation. */
  animNonce?: number;
};

/** Which columns the current move touches, for a subtle highlight. */
function activeCols(move: Move | null): Set<number> {
  const s = new Set<number>();
  if (!move) return s;
  if (move.type === 'tableau') {
    s.add(move.from);
    s.add(move.to);
  }
  return s;
}

/** Cumulative top offset (px) of each card in a column, at the given overlap. */
function columnTops(col: Column, steps: Steps): number[] {
  let top = 0;
  return col.cards.map((_, i) => {
    const here = top;
    top += i < col.faceDown ? steps.down : steps.up;
    return here;
  });
}

/**
 * For a forward step, work out where each card that just moved came from, as a
 * `{dx, dy}` offset from its new position. The animation plays each card from
 * that offset back to zero, so it appears to slide in from its old spot.
 * Keyed by `"col-index"` of the card in the *new* state.
 */
function computeMoveOffsets(
  prev: GameState,
  cur: GameState,
  move: Move | null,
): Map<string, { dx: number; dy: number }> {
  const offsets = new Map<string, { dx: number; dy: number }>();
  if (!move) return offsets;
  const prevSteps = computeSteps(prev);
  const curSteps = computeSteps(cur);

  if (move.type === 'tableau') {
    // If landing completed a K..A run, the moved cards were removed — nothing
    // to slide into place, so skip.
    if (cur.completed !== prev.completed) return offsets;
    const { from, to, count } = move;
    const toTops = columnTops(cur.columns[to], curSteps);
    const fromTops = columnTops(prev.columns[from], prevSteps);
    const startNew = cur.columns[to].cards.length - count;
    const startOld = prev.columns[from].cards.length - count;
    for (let k = 0; k < count; k++) {
      offsets.set(`${to}-${startNew + k}`, {
        dx: (from - to) * COL_PITCH,
        dy: (fromTops[startOld + k] ?? 0) - (toTops[startNew + k] ?? 0),
      });
    }
    return offsets;
  }

  // Deal: each column gains one card off the stock — drop it in from above.
  for (let c = 0; c < COLS; c++) {
    if (cur.columns[c].cards.length > prev.columns[c].cards.length) {
      offsets.set(`${c}-${cur.columns[c].cards.length - 1}`, { dx: 0, dy: -26 });
    }
  }
  return offsets;
}

/**
 * The completed K..A runs, shown as foundation piles that fill up during
 * playback. There are always 8 slots (a win = 8 runs); each filled slot shows
 * the suit of that completed run. `justCompleted` highlights the newest one.
 */
export function Foundations({
  suits,
  justCompleted,
}: {
  suits: number[];
  justCompleted: boolean;
}) {
  return (
    <div className="foundations">
      <div className="col-label foundations-label">completed runs</div>
      {Array.from({ length: 8 }, (_, i) => {
        const suit = suits[i];
        const filled = suit !== undefined;
        const isNewest = filled && i === suits.length - 1 && justCompleted;
        const cls = filled ? suitClass(suit) : 'empty';
        return (
          <div key={i} className={`foundation ${cls}${isNewest ? ' pop' : ''}`}>
            {filled && (
              <>
                <span className="corner tl">K{suitSymbol(suit)}</span>
                <span className="pip">{suitSymbol(suit)}</span>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function Board({ state, move, showStock = true, prevState = null, animNonce }: Props) {
  const active = activeCols(move);
  const dealing = move?.type === 'deal';
  const steps = computeSteps(state);

  // Cards that just moved, and where they came from (only when a prev state and
  // move are given — i.e. stepping a plan forward).
  const offsets = prevState
    ? computeMoveOffsets(prevState, state, move)
    : new Map<string, { dx: number; dy: number }>();
  const cardEls = useRef<Map<string, HTMLDivElement>>(new Map());

  // On a forward step, slide each moved card from its old spot into place, with
  // a brief "lift" (shadow + raised z-index) so it reads as picked up and set.
  useLayoutEffect(() => {
    if (animNonce === undefined) return;
    offsets.forEach((d, key) => {
      const el = cardEls.current.get(key);
      if (!el) return;
      el.style.zIndex = '60';
      const anim = el.animate(
        [
          { transform: `translate(${d.dx}px, ${d.dy}px) scale(1.04)`, boxShadow: '0 10px 20px rgba(0,0,0,0.5)' },
          { transform: 'translate(0, 0) scale(1)', boxShadow: '0 1px 2px rgba(0,0,0,0.35)' },
        ],
        { duration: 240, easing: 'cubic-bezier(0.22, 0.61, 0.36, 1)' },
      );
      anim.onfinish = () => {
        el.style.zIndex = '';
      };
    });
    // Only re-run when a forward step happens, not on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [animNonce]);

  return (
    <div className="board">
      {Array.from({ length: COLS }, (_, c) => {
        const col = state.columns[c];
        const tops = columnTops(col, steps);
        const height = (tops.length ? tops[tops.length - 1] : 0) + CARD_H;

        return (
          <div key={c} className={`column${active.has(c) ? ' active' : ''}`} style={{ height }}>
            <div className="col-label">{c}</div>
            {col.cards.length === 0 && <div className="empty-slot" />}
            {col.cards.map((card, i) => {
              const faceUp = i >= col.faceDown;
              const unknown = faceUp && card.rank === 0; // revealed but not typed in
              const color = unknown ? ' unknown' : ' ' + suitClass(card.suit);
              const animKey = `${c}-${i}`;
              return (
                <div
                  key={i}
                  ref={
                    offsets.has(animKey)
                      ? (el) => {
                          if (el) cardEls.current.set(animKey, el);
                        }
                      : undefined
                  }
                  className={`card${faceUp ? '' : ' down'}${color}`}
                  style={{ top: tops[i] }}
                >
                  {unknown ? (
                    <span className="corner tl">?</span>
                  ) : faceUp ? (
                    <>
                      <span className="corner tl">
                        {rankName(card.rank)}
                        {suitSymbol(card.suit)}
                      </span>
                      <span className="pip">{suitSymbol(card.suit)}</span>
                    </>
                  ) : null}
                </div>
              );
            })}
          </div>
        );
      })}
      {showStock && (
        <div className={`stock-pile${dealing ? ' active' : ''}`}>
          <div className="col-label">stock</div>
          <div className="stock-count">{state.stock.length}</div>
          <div className="stock-sub">{state.stock.length / COLS} deals left</div>
        </div>
      )}
    </div>
  );
}
