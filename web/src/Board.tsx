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

/** The most-scrunched overlap among a set of frames — held steady through a
 * step's animation so cards never reflow or overflow mid-move; the board
 * un-scrunches (if the move freed room) only after, when this is released. */
function stableSteps(frames: GameState[]): Steps {
  return frames.map(computeSteps).reduce((a, b) => (a.up <= b.up ? a : b));
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
  /**
   * Hold back the newest `n` completed suits from the foundations until their
   * King has flown up (Phase 3). Called with the count when a completing step's
   * rich animation starts, and with 0 to reveal all (on settle or any jump), so
   * the foundation King never appears before the run has vanished.
   */
  onHideCompletions?: (n: number) => void;
  /** One held-back completion's King has landed — reveal it in the foundations. */
  onRevealCompletion?: () => void;
};

/**
 * Where each just-moved card started, as a `{dx, dy}` offset from its rendered
 * position — the animation plays it from there back to zero. Keyed by
 * `"col-index"` of the card in the target frame. `steps` is the overlap the
 * board is rendered at (held constant through the step), so offsets line up.
 */
function moveOffsets(
  prev: GameState,
  cur: GameState,
  move: Move | null,
  steps: Steps,
): Map<string, { dx: number; dy: number }> {
  const offsets = new Map<string, { dx: number; dy: number }>();
  if (!move) return offsets;

  if (move.type === 'tableau') {
    if (cur.completed !== prev.completed) return offsets; // run vanished — nothing to land
    const { from, to, count } = move;
    const toTops = columnTops(cur.columns[to], steps);
    const fromTops = columnTops(prev.columns[from], steps);
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

export function Board({
  state,
  move,
  showStock = true,
  prevState = null,
  animNonce,
  rich = true,
  onHideCompletions,
  onRevealCompletion,
}: Props) {
  // Normally the board is rendered straight from `state` (so jumps/Play never
  // lag). Only during the multi-phase Next choreography does `richFrame` override
  // it with intermediate frames. `animSteps`, when set, freezes the overlap for a
  // step's whole animation (see stableSteps).
  const [richFrame, setRichFrame] = useState<GameState | null>(null);
  const [animSteps, setAnimSteps] = useState<Steps | null>(null);
  const [highlight, setHighlight] = useState<Set<string>>(() => new Set());
  const [flipHi, setFlipHi] = useState<string | null>(null);
  const cardEls = useRef<Map<string, HTMLDivElement>>(new Map());
  const token = useRef(0);
  // A move's source-offset slide, queued so it can be applied in a layout effect
  // the instant its `moved` frame commits — before the browser paints it — so the
  // rich Next slide never flashes the cards at their destination first. (Play's
  // quickSlide already applies its transform pre-paint, from the animNonce effect.)
  const pendingSlide = useRef<{ token: number; apply: () => void } | null>(null);

  const get = (key: string) => cardEls.current.get(key);

  // A new requested state cancels a running animation and shows it (functional
  // updates bail when nothing changes, so static re-renders stay cheap).
  useLayoutEffect(() => {
    token.current++;
    setRichFrame((f) => (f ? null : f));
    setAnimSteps((s) => (s ? null : s));
    setHighlight((h) => (h.size ? new Set() : h));
    setFlipHi((f) => (f ? null : f));
    onHideCompletions?.(0); // any new state (jump/Play/interrupt) reveals all completed suits
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  // A forward step (Next / Play) animates from `prevState`.
  useLayoutEffect(() => {
    if (prevState == null || move == null) return;
    const my = ++token.current;
    const anim = computeStepAnim(prevState, move, state);
    const held = stableSteps([prevState, anim.moved, anim.afterComplete, state]);
    if (!rich) {
      quickSlide(prevState, state, move, held, my);
      return;
    }
    void runRich(prevState, move, state, anim, held, my);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [animNonce]);

  // Apply a queued move-slide the moment its frame commits, before that frame can
  // paint (see pendingSlide). Fires on every richFrame change but no-ops unless a
  // slide is queued for the animation still in flight.
  useLayoutEffect(() => {
    const ps = pendingSlide.current;
    if (!ps || ps.token !== token.current) return;
    pendingSlide.current = null;
    ps.apply();
  }, [richFrame]);

  function quickSlide(prev: GameState, cur: GameState, mv: Move, held: Steps, my: number) {
    // Hold the overlap steady for the slide (set from this layout effect, so it's
    // flushed before the first paint — no reflow mid-slide).
    setAnimSteps(held);
    moveOffsets(prev, cur, mv, held).forEach((d, key) => {
      const el = get(key);
      if (!el) return;
      slideFromSource(el, d, 190, 'cubic-bezier(0.22, 0.61, 0.36, 1)');
    });
    setTimeout(() => {
      if (token.current === my) setAnimSteps((s) => (s ? null : s)); // un-scrunch after
    }, 230);
  }

  /**
   * Play a card sliding in from a `{dx, dy}` offset. The offset is written to the
   * element's inline transform *synchronously* (in a layout effect, before paint)
   * so the card is at its source on the very first frame — never flashed onto the
   * destination — and the Web Animation then carries it to zero.
   */
  function slideFromSource(
    el: HTMLDivElement,
    d: { dx: number; dy: number },
    duration: number,
    easing: string,
    keyframes?: Keyframe[],
  ) {
    el.style.zIndex = '60';
    el.style.transform = `translate(${d.dx}px, ${d.dy}px)`;
    const a = el.animate(
      keyframes ?? [{ transform: `translate(${d.dx}px, ${d.dy}px)` }, { transform: 'translate(0, 0)' }],
      { duration, easing, fill: 'forwards' },
    );
    a.onfinish = () => {
      el.style.transform = '';
      el.style.zIndex = '';
      a.cancel();
    };
  }

  async function runRich(
    prev: GameState,
    mv: Move,
    cur: GameState,
    anim: ReturnType<typeof computeStepAnim>,
    held: Steps,
    my: number,
  ) {
    const alive = () => my === token.current;
    setAnimSteps(held);
    // Hold this step's finished suits out of the foundations until each King flies
    // up in Phase 3, so the run visibly vanishes before its King appears there.
    if (anim.completions.length > 0) onHideCompletions?.(anim.completions.length);
    try {
      await playPhases(anim, prev, mv, cur, held, alive, my);
    } catch {
      /* fall through to settle */
    }
    if (alive()) {
      setHighlight(new Set());
      setFlipHi(null);
      setRichFrame(null);
      setAnimSteps(null); // un-scrunch only now, after the whole animation
      onHideCompletions?.(0); // safety: everything this step finished is now shown
    }
  }

  // Timeout-driven (never rAF / WAAPI `.finished`, which freeze in a backgrounded
  // tab); the Web Animations run only for the visuals.
  async function playPhases(
    anim: ReturnType<typeof computeStepAnim>,
    prev: GameState,
    mv: Move,
    cur: GameState,
    held: Steps,
    alive: () => boolean,
    my: number,
  ) {
    const { moved, movedKeys, afterComplete, completions, flips } = anim;
    const commit = () => delay(24);

    // Phase 1 — highlight the cards about to move, at their source.
    const sourceKeys =
      mv.type === 'tableau'
        ? Array.from({ length: mv.count }, (_, k) => `${mv.from}-${prev.columns[mv.from].cards.length - mv.count + k}`)
        : movedKeys;
    setRichFrame(prev);
    setHighlight(new Set(sourceKeys));
    await commit();
    await delay(420); // dwell on the highlighted source so the eye catches it before the move
    if (!alive()) return;

    // Phase 2 — move: relocate the cards, then slide them in with a downward dip.
    // The source-offset transforms are queued and applied the instant the `moved`
    // frame commits (in the richFrame layout effect, before it paints) — so the
    // cards are never painted at their destination before the slide begins.
    const offsets = moveOffsets(prev, moved, mv, held);
    pendingSlide.current = {
      token: my,
      apply: () =>
        offsets.forEach((d, key) => {
          const el = get(key);
          if (!el) return;
          slideFromSource(el, d, 380, 'cubic-bezier(0.4, 0.02, 0.25, 1)', [
            { transform: `translate(${d.dx}px, ${d.dy}px) scale(1.03)`, boxShadow: '0 10px 20px rgba(0,0,0,0.5)', offset: 0 },
            { transform: `translate(${d.dx * 0.4}px, ${d.dy * 0.4 + 34}px) scale(1.05)`, offset: 0.55 },
            { transform: 'translate(0, 0) scale(1)', boxShadow: '0 1px 2px rgba(0,0,0,0.35)', offset: 1 },
          ]);
        }),
    };
    setRichFrame(moved);
    setHighlight(new Set(movedKeys));
    await commit();
    await delay(400);
    if (!alive()) return;

    // Phase 3 — finished a suit: highlight the whole run, vanish the cards top to
    // bottom one at a time, then send the King up toward the foundations.
    for (const { col } of completions) {
      if (!alive()) return;
      const cards = moved.columns[col].cards;
      const kingIdx = cards.length - 13;
      setHighlight(new Set(Array.from({ length: 13 }, (_, k) => `${col}-${kingIdx + k}`)));
      await delay(260);
      if (!alive()) return;
      for (let i = cards.length - 1; i > kingIdx; i--) {
        const el = get(`${col}-${i}`);
        if (el) {
          el.style.zIndex = '70';
          el.animate([{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(0.4)' }], {
            duration: 170,
            easing: 'ease-in',
            fill: 'forwards',
          });
        }
        await delay(65);
      }
      await delay(120);
      if (!alive()) return;
      const king = get(`${col}-${kingIdx}`);
      if (king) {
        king.style.zIndex = '70';
        king.animate(
          [
            { opacity: 1, transform: 'translateY(0) scale(1)' },
            { opacity: 0, transform: 'translateY(-104px) scale(0.9)' },
          ],
          { duration: 360, easing: 'ease-in', fill: 'forwards' },
        );
      }
      await delay(380);
      if (!alive()) return;
      onRevealCompletion?.(); // King has flown up — now show it in the foundations
    }
    if (completions.length > 0) {
      if (!alive()) return;
      setRichFrame(afterComplete);
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
        back.style.transform = 'scaleX(0.06)';
        a1?.cancel();
      }
      work = { ...work, columns: work.columns.map((c, i) => (i === col ? { ...c, faceDown: index } : c)) };
      setRichFrame(work);
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
    setRichFrame(cur);
  }

  const rendered = richFrame ?? state;
  const steps = animSteps ?? computeSteps(rendered);
  const dealing = move?.type === 'deal';

  return (
    <div className="board">
      {Array.from({ length: COLS }, (_, c) => {
        const col = rendered.columns[c];
        const tops = columnTops(col, steps);
        const height = (tops.length ? tops[tops.length - 1] : 0) + CARD_H;

        return (
          <div key={c} className="column" style={{ height }}>
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
