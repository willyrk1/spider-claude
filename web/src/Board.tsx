import { useLayoutEffect, useRef, useState } from 'react';
import type { Column, GameState, Move } from './game';
import { COLS, computeStepAnim, rankName, suitClass, suitSymbol } from './game';

const CARD_H = 92; // card height (px), matches --card-h
const BASE_DOWN = 15; // vertical px each covered face-down card contributes
const BASE_UP = 30; //   ...and each covered face-up card
// Horizontal distance between adjacent columns: card width (--card-w 66px) plus
// the .board flex gap (8px). Kept in sync with index.css.
const COL_PITCH = 74;
// Squish tall boards so they fit without a big page scroll.
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

/** Cumulative top offset (px) of each card in a column, at the given overlap. */
function columnTops(col: Column, steps: Steps): number[] {
  let top = 0;
  return col.cards.map((_, i) => {
    const here = top;
    top += i < col.faceDown ? steps.down : steps.up;
    return here;
  });
}

type Props = {
  state: GameState;
  move: Move | null;
  showStock?: boolean;
  /** The state before `move`, so a forward step can animate the moved cards. */
  prevState?: GameState | null;
  /** Bumped only on a forward step (Next / Play); triggers the animation. */
  animNonce?: number;
  /** Full multi-phase choreography (Next) vs a quick slide (Play). */
  rich?: boolean;
};

/** Which columns the current move touches, for a subtle highlight. */
function activeCols(move: Move | null): Set<number> {
  const s = new Set<number>();
  if (move?.type === 'tableau') {
    s.add(move.from);
    s.add(move.to);
  }
  return s;
}

/**
 * Where each just-moved card started, as a `{dx, dy}` offset from its rendered
 * (destination) position — the animation plays it from there back to zero.
 * Keyed by `"col-index"` of the card in the *new* frame.
 */
function moveOffsets(prev: GameState, cur: GameState, move: Move | null): Map<string, { dx: number; dy: number }> {
  const offsets = new Map<string, { dx: number; dy: number }>();
  if (!move) return offsets;
  const prevSteps = computeSteps(prev);
  const curSteps = computeSteps(cur);

  if (move.type === 'tableau') {
    if (cur.completed !== prev.completed) return offsets; // run vanished — nothing to land
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
  for (let c = 0; c < COLS; c++) {
    if (cur.columns[c].cards.length > prev.columns[c].cards.length) {
      offsets.set(`${c}-${cur.columns[c].cards.length - 1}`, { dx: 0, dy: -34 });
    }
  }
  return offsets;
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * The completed K..A runs, shown as foundation piles that fill up during
 * playback. Always 8 slots (a win = 8 runs); `justCompleted` pops the newest.
 */
export function Foundations({ suits, justCompleted }: { suits: number[]; justCompleted: boolean }) {
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

export function Board({ state, move, showStock = true, prevState = null, animNonce, rich = true }: Props) {
  // The board actually rendered. Normally === `state`; during a forward-step
  // animation it walks through intermediate frames (source → moved → run
  // removed → flips) that don't each correspond to a single game state.
  const [frame, setFrame] = useState<GameState>(state);
  const [highlight, setHighlight] = useState<Set<string>>(() => new Set());
  const [flipHi, setFlipHi] = useState<string | null>(null);
  const cardEls = useRef<Map<string, HTMLDivElement>>(new Map());
  // Bumped whenever the requested board changes; a running animation aborts once
  // its token is stale, so rapid stepping never leaves a half-played frame.
  const token = useRef(0);

  const get = (key: string) => cardEls.current.get(key);

  // Any change to the requested state cancels a running animation and shows it.
  useLayoutEffect(() => {
    token.current++;
    setFrame(state);
    setHighlight(new Set());
    setFlipHi(null);
  }, [state]);

  // A forward step animates from `prevState`; Play uses a quick slide.
  useLayoutEffect(() => {
    if (prevState == null || move == null) return;
    const my = ++token.current;
    if (!rich) {
      quickSlide(prevState, state, move);
      return;
    }
    void runRich(prevState, move, state, my);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [animNonce]);

  function quickSlide(prev: GameState, cur: GameState, mv: Move) {
    moveOffsets(prev, cur, mv).forEach((d, key) => {
      const el = get(key);
      if (!el) return;
      el.style.zIndex = '60';
      const a = el.animate(
        [{ transform: `translate(${d.dx}px, ${d.dy}px)` }, { transform: 'translate(0, 0)' }],
        { duration: 190, easing: 'cubic-bezier(0.22, 0.61, 0.36, 1)' },
      );
      a.onfinish = () => {
        el.style.zIndex = '';
      };
    });
  }

  async function runRich(prev: GameState, mv: Move, cur: GameState, my: number) {
    const alive = () => my === token.current;
    try {
      await playPhases(prev, mv, cur, alive);
    } catch {
      /* fall through to settle */
    }
    // Whatever happened, land exactly on the target (unless a newer step took over).
    if (alive()) {
      setHighlight(new Set());
      setFlipHi(null);
      setFrame(cur);
    }
  }

  // Sequencing is driven by `delay` (setTimeout), never rAF or WAAPI `.finished`
  // — those freeze when the tab isn't foreground, which would strand a step
  // mid-animation. The Web Animations run purely for the visuals; if they're
  // throttled the frames still advance on the timers and the step still settles.
  async function playPhases(prev: GameState, mv: Move, cur: GameState, alive: () => boolean) {
    const { moved, movedKeys, afterComplete, completion, flips } = computeStepAnim(prev, mv, cur);
    const commit = () => delay(24); // let React paint the new frame before we animate

    // Phase 1 — draw attention: highlight the cards about to move, at their source.
    const sourceKeys =
      mv.type === 'tableau'
        ? Array.from({ length: mv.count }, (_, k) => `${mv.from}-${prev.columns[mv.from].cards.length - mv.count + k}`)
        : movedKeys;
    setFrame(prev);
    setHighlight(new Set(sourceKeys));
    await commit();
    await delay(280);
    if (!alive()) return;

    // Phase 2 — move: relocate the cards, then slide them in with a downward dip.
    setFrame(moved);
    setHighlight(new Set(movedKeys));
    await commit();
    moveOffsets(prev, moved, mv).forEach((d, key) => {
      const el = get(key);
      if (!el) return;
      el.style.zIndex = '60';
      const a = el.animate(
        [
          { transform: `translate(${d.dx}px, ${d.dy}px) scale(1.03)`, boxShadow: '0 10px 20px rgba(0,0,0,0.5)', offset: 0 },
          { transform: `translate(${d.dx * 0.4}px, ${d.dy * 0.4 + 34}px) scale(1.05)`, offset: 0.55 },
          { transform: 'translate(0, 0) scale(1)', boxShadow: '0 1px 2px rgba(0,0,0,0.35)', offset: 1 },
        ],
        { duration: 380, easing: 'cubic-bezier(0.4, 0.02, 0.25, 1)' },
      );
      a.onfinish = () => {
        el.style.zIndex = '';
      };
    });
    await delay(400);
    if (!alive()) return;

    // Phase 3 — finished a suit: the run melts away, the King rides up to the top.
    if (completion) {
      const cards = moved.columns[completion.col].cards;
      for (let i = cards.length - 13; i < cards.length; i++) {
        const el = get(`${completion.col}-${i}`);
        if (!el) continue;
        el.style.zIndex = '70';
        const isKing = i === cards.length - 13;
        el.animate(
          isKing
            ? [
                { opacity: 1, transform: 'translateY(0) scale(1)' },
                { opacity: 0, transform: 'translateY(-96px) scale(0.9)' },
              ]
            : [{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(0.45)' }],
          { duration: 440, easing: 'ease-in', fill: 'forwards' },
        );
      }
      await delay(460);
      if (!alive()) return;
      setFrame(afterComplete);
      await commit();
    }

    // Phase 4 — settle: drop the highlight on the cards we moved.
    setHighlight(new Set());
    await delay(140);
    if (!alive()) return;

    // Phase 5 — turn up newly exposed face-down cards, one at a time (a squash flip).
    let work = afterComplete;
    for (const { col, index } of flips) {
      if (!alive()) return;
      const key = `${col}-${index}`;
      setFlipHi(key);
      const back = get(key);
      let a1: Animation | undefined;
      if (back) {
        back.style.transformOrigin = 'center';
        a1 = back.animate([{ transform: 'scaleX(1)' }, { transform: 'scaleX(0.06)' }], {
          duration: 120,
          easing: 'ease-in',
          fill: 'forwards',
        });
      }
      await delay(125);
      if (back) {
        back.style.transform = 'scaleX(0.06)'; // hold the squash across the reveal
        a1?.cancel();
      }
      work = { ...work, columns: work.columns.map((c, i) => (i === col ? { ...c, faceDown: index } : c)) };
      setFrame(work);
      await commit();
      if (!alive()) return;
      const front = get(key);
      if (front) {
        front.style.transform = 'scaleX(0.06)';
        const a2 = front.animate([{ transform: 'scaleX(0.06)' }, { transform: 'scaleX(1)' }], {
          duration: 130,
          easing: 'ease-out',
          fill: 'forwards',
        });
        await delay(135);
        front.style.transform = '';
        a2.cancel();
      } else {
        await delay(135);
      }
      await delay(60);
    }
    setFlipHi(null);
    setFrame(cur);
  }

  const steps = computeSteps(frame);
  const active = activeCols(move);
  const dealing = move?.type === 'deal';

  return (
    <div className="board">
      {Array.from({ length: COLS }, (_, c) => {
        const col = frame.columns[c];
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
              const key = `${c}-${i}`;
              const cls =
                `card${faceUp ? '' : ' down'}${color}` +
                `${highlight.has(key) ? ' hi' : ''}${flipHi === key ? ' fliphi' : ''}`;
              return (
                <div
                  key={i}
                  ref={(el) => {
                    if (el) cardEls.current.set(key, el);
                  }}
                  className={cls}
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
