import type { GameState, Move } from './game';
import { COLS, isRed, rankName, suitSymbol } from './game';

const FACE_DOWN_STEP = 15; // vertical px each covered face-down card contributes
const FACE_UP_STEP = 30; //   ...and each covered face-up card

type Props = { state: GameState; move: Move | null };

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
        const cls = filled ? (isRed(suit) ? 'red' : 'black') : 'empty';
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

export function Board({ state, move }: Props) {
  const active = activeCols(move);
  const dealing = move?.type === 'deal';

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
              return (
                <div
                  key={i}
                  className={`card${faceUp ? '' : ' down'}${
                    isRed(card.suit) ? ' red' : ' black'
                  }`}
                  style={{ top: tops[i] }}
                >
                  {faceUp && (
                    <>
                      <span className="corner tl">
                        {rankName(card.rank)}
                        {suitSymbol(card.suit)}
                      </span>
                      <span className="pip">{suitSymbol(card.suit)}</span>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        );
      })}
      <div className={`stock-pile${dealing ? ' active' : ''}`}>
        <div className="col-label">stock</div>
        <div className="stock-count">{state.stock.length}</div>
        <div className="stock-sub">{state.stock.length / COLS} deals left</div>
      </div>
    </div>
  );
}
