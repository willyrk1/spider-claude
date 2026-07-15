import { useLayoutEffect, useRef } from 'react';
import type { Column, GameState, Move } from './game';
import { COLS, rankName, suitClass, suitSymbol } from './game';

const FACE_DOWN_STEP = 15; // vertical px each covered face-down card contributes
const FACE_UP_STEP = 30; //   ...and each covered face-up card
// Horizontal distance between adjacent columns: card width (--card-w 66px) plus
// the .board flex gap (12px). Kept in sync with index.css.
const COL_PITCH = 78;

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

/** Cumulative top offset (px) of each card in a column, matching the render. */
function columnTops(col: Column): number[] {
  let top = 0;
  return col.cards.map((_, i) => {
    const here = top;
    top += i < col.faceDown ? FACE_DOWN_STEP : FACE_UP_STEP;
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

  if (move.type === 'tableau') {
    // If landing completed a K..A run, the moved cards were removed — nothing
    // to slide into place, so skip.
    if (cur.completed !== prev.completed) return offsets;
    const { from, to, count } = move;
    const curTo = cur.columns[to];
    const prevFrom = prev.columns[from];
    const toTops = columnTops(curTo);
    const fromTops = columnTops(prevFrom);
    const startNew = curTo.cards.length - count;
    const startOld = prevFrom.cards.length - count;
    for (let k = 0; k < count; k++) {
      const iNew = startNew + k;
      const iOld = startOld + k;
      offsets.set(`${to}-${iNew}`, {
        dx: (from - to) * COL_PITCH,
        dy: (fromTops[iOld] ?? 0) - (toTops[iNew] ?? 0),
      });
    }
    return offsets;
  }

  // Deal: each column gains one card off the stock — drop it in from above.
  for (let c = 0; c < COLS; c++) {
    if (cur.columns[c].cards.length > prev.columns[c].cards.length) {
      offsets.set(`${c}-${cur.columns[c].cards.length - 1}`, { dx: 0, dy: -24 });
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
                <span className="corner tl">
                  K{suitSymbol(suit)}
                </span>
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

  // Cards that just moved, and where they came from (only when a prev state and
  // move are given — i.e. the solution player stepping forward).
  const offsets = prevState
    ? computeMoveOffsets(prevState, state, move)
    : new Map<string, { dx: number; dy: number }>();
  const cardEls = useRef<Map<string, HTMLDivElement>>(new Map());

  // On a forward step, slide each moved card from its old spot into place.
  useLayoutEffect(() => {
    if (animNonce === undefined) return;
    offsets.forEach((d, key) => {
      const el = cardEls.current.get(key);
      if (!el || (d.dx === 0 && d.dy === 0)) return;
      el.animate(
        [
          { transform: `translate(${d.dx}px, ${d.dy}px)` },
          { transform: 'translate(0, 0)' },
        ],
        { duration: 200, easing: 'cubic-bezier(0.22, 0.61, 0.36, 1)' },
      );
    });
    // Only re-run when a forward step happens, not on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [animNonce]);

  return (
    <div className="board">
      {Array.from({ length: COLS }, (_, c) => {
        const col = state.columns[c];
        // Cumulative top offsets so cards cascade downward.
        let top = 0;
        const tops = col.cards.map((_, i) => {
          const here = top;
          top += i < col.faceDown ? FACE_DOWN_STEP : FACE_UP_STEP;
          return here;
        });
        const height = (tops.length ? tops[tops.length - 1] : 0) + 92;

        return (
          <div
            key={c}
            className={`column${active.has(c) ? ' active' : ''}`}
            style={{ height }}
          >
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
