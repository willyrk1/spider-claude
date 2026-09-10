import { useEffect, useRef, useState } from 'react';
import type { GameState, Move } from '../game';
import { applyMove, computeStepAnim, suitClass, suitSymbol } from '../game';
import type { Hint } from './rules';
import { autoTarget, canDeal, canDrop, dealGame, hints, randomSeed, sameMove, tableauMove } from './rules';
import { Table } from './Table';

// The casual "just play" mode: a random deal, tap-to-move, unlimited undo/redo,
// hints. Runs entirely in the browser (no solver server), so it can be hosted
// anywhere.

/** `redo` holds undone moves, the next one to redo last. */
type Game = { suits: number; seed: number; moves: Move[]; history: GameState[]; redo: Move[] };
type Saved = { suits: number; seed: number; moves: Move[]; redo?: Move[] };

const STORE = 'spider-play-v1';
const SUIT_OPTIONS = [1, 2, 4] as const;
// Built standalone (`vite build --mode play`) there's no solver to link to.
const WITH_SOLVER = import.meta.env.MODE !== 'play';

function replay(suits: number, seed: number, moves: Move[], redo: Move[] = []): Game {
  const history = [dealGame(suits, seed)];
  for (const m of moves) history.push(applyMove(history[history.length - 1], m));
  return { suits, seed, moves, history, redo };
}

function freshGame(suits: number, seed = randomSeed()): Game {
  return replay(suits, seed, []);
}

/** A deal asked for by `?suits=&seed=`, read once at load and then cleared
 * from the address bar so a refresh doesn't restart it. */
const URL_DEAL: { suits: number; seed: number } | null = (() => {
  const params = new URLSearchParams(location.search);
  const suits = Number(params.get('suits'));
  const seed = Number(params.get('seed'));
  if (!params.has('seed') || ![1, 2, 4].includes(suits) || !Number.isSafeInteger(seed) || seed < 0) return null;
  history.replaceState(null, '', location.pathname);
  return { suits, seed };
})();

/** The URL's deal if given (resuming it if it's the saved one), else the saved
 * game, else a new one. */
function initialGame(): Game {
  let saved: Saved | null = null;
  try {
    const raw = localStorage.getItem(STORE);
    if (raw) saved = JSON.parse(raw) as Saved;
  } catch {
    /* storage unavailable — start fresh */
  }
  if (URL_DEAL && !(saved && saved.suits === URL_DEAL.suits && saved.seed === URL_DEAL.seed)) {
    return freshGame(URL_DEAL.suits, URL_DEAL.seed);
  }
  if (saved && [1, 2, 4].includes(saved.suits) && Array.isArray(saved.moves)) {
    try {
      return replay(saved.suits, saved.seed, saved.moves, Array.isArray(saved.redo) ? saved.redo : []);
    } catch {
      /* corrupt save — fall through */
    }
  }
  return freshGame(saved?.suits && [1, 2, 4].includes(saved.suits) ? saved.suits : 4);
}

const reduceMotion =
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

function SuitGlyphs({ n }: { n: number }) {
  return (
    <span className="glyphs">
      {[0, 1, 2, 3].slice(0, n).map((s) => (
        <span key={s} className={suitClass(s)}>
          {suitSymbol(s)}
        </span>
      ))}
    </span>
  );
}

export default function Play() {
  const [game, setGame] = useState<Game>(initialGame);
  // While a finished K..A run animates away, the table shows this frame (the
  // run still in place) instead of the settled state.
  const [frame, setFrame] = useState<{ state: GameState; vanishing: Set<number> } | null>(null);
  const [sheet, setSheet] = useState(false);
  const [toast, setToast] = useState<{ text: string; n: number } | null>(null);
  const [popRun, setPopRun] = useState(0); // which foundation slot (1-based) just filled
  // The ranked hints for this position and which one is showing; pressing Hint
  // again steps to the next. Cleared whenever the position changes.
  const [hint, setHint] = useState<{ list: Hint[]; i: number } | null>(null);
  const timers = useRef<number[]>([]);
  const stockRef = useRef<HTMLButtonElement>(null);

  const cur = game.history[game.history.length - 1];
  const shown = frame?.state ?? cur;
  const won = cur.completed === 8;
  const shownHint = hint ? hint.list[hint.i] : null;

  useEffect(() => {
    try {
      localStorage.setItem(
        STORE,
        JSON.stringify({ suits: game.suits, seed: game.seed, moves: game.moves, redo: game.redo }),
      );
    } catch {
      /* private mode etc. — the game just won't survive a reload */
    }
  }, [game]);

  useEffect(() => setHint(null), [cur]);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 1600);
    return () => clearTimeout(t);
  }, [toast]);

  const say = (text: string) => setToast({ text, n: Date.now() });

  function settle() {
    timers.current.forEach(clearTimeout);
    timers.current = [];
    setFrame(null);
  }

  function play(m: Move) {
    settle();
    const next = applyMove(cur, m);
    // Replaying the move you'd redo keeps the rest of the redo line; anything
    // else starts a new line.
    const top = game.redo[game.redo.length - 1];
    const redo = top && sameMove(top, m) ? game.redo.slice(0, -1) : [];
    setGame({ ...game, moves: [...game.moves, m], history: [...game.history, next], redo });
    if (next.completed <= cur.completed) return;
    setPopRun(next.completed);
    if (reduceMotion) return;
    // Land the cards first, then shrink the finished run away top-down.
    const anim = computeStepAnim(cur, m, next);
    const ids = new Set<number>();
    for (const { col } of anim.completions) {
      const cards = anim.moved.columns[col].cards;
      for (const c of cards.slice(cards.length - 13)) if (c.id !== undefined) ids.add(c.id);
    }
    setFrame({ state: anim.moved, vanishing: new Set() });
    timers.current.push(
      window.setTimeout(() => setFrame({ state: anim.moved, vanishing: ids }), 200),
      window.setTimeout(() => setFrame(null), 200 + 12 * 16 + 300),
    );
  }

  function onTap(col: number, index: number): boolean {
    if (frame) {
      settle(); // mid-animation: finish it rather than act on a stale layout
      return true;
    }
    const to = autoTarget(cur, col, index);
    if (to === null) return false;
    play(tableauMove(cur, col, index, to));
    return true;
  }

  function onDrop(col: number, index: number, to: number) {
    if (frame) settle();
    if (canDrop(cur, col, index, to)) play(tableauMove(cur, col, index, to));
  }

  function shakeStock() {
    try {
      navigator.vibrate?.(30);
    } catch {
      /* ignore */
    }
    stockRef.current?.animate(
      [{ transform: 'translateX(0)' }, { transform: 'translateX(-5px)' }, { transform: 'translateX(5px)' }, { transform: 'translateX(0)' }],
      { duration: 220 },
    );
  }

  function deal() {
    if (frame) settle();
    if (cur.stock.length === 0) {
      say('The stock is empty');
      shakeStock();
    } else if (!canDeal(cur)) {
      say('Fill every empty column before dealing');
      shakeStock();
    } else {
      play({ type: 'deal' });
    }
  }

  function undo() {
    settle();
    if (game.moves.length === 0) return;
    const last = game.moves[game.moves.length - 1];
    setGame({
      ...game,
      moves: game.moves.slice(0, -1),
      history: game.history.slice(0, -1),
      redo: [...game.redo, last],
    });
    setPopRun(0);
  }

  function redo() {
    if (game.redo.length === 0) return;
    play(game.redo[game.redo.length - 1]);
  }

  function showHint() {
    if (frame) settle();
    const list = hint ? hint.list : hints(cur);
    if (list.length === 0) {
      say('No moves left — undo, or start a new deal');
      return;
    }
    const i = hint ? (hint.i + 1) % list.length : 0;
    setHint({ list, i });
    if (list[i].type === 'deal') say('Deal a new row');
  }

  function newDeal(suits: number) {
    settle();
    setGame(freshGame(suits));
    setPopRun(0);
    setSheet(false);
  }

  function restart() {
    settle();
    setGame(freshGame(game.suits, game.seed));
    setPopRun(0);
    setSheet(false);
  }

  // Desktop shortcuts: Z / Ctrl+Z undo, Y / Shift+Z redo, H hint, D or Space
  // deal, N new deal.
  const keys = useRef({ undo, redo, deal, showHint, open: () => setSheet(true), close: () => setSheet(false) });
  keys.current = { undo, redo, deal, showHint, open: () => setSheet(true), close: () => setSheet(false) };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.altKey || e.metaKey) return;
      const k = e.key.toLowerCase();
      if (k === 'z') (e.shiftKey ? keys.current.redo : keys.current.undo)();
      else if (k === 'y') keys.current.redo();
      else if (k === 'h' && !e.ctrlKey) keys.current.showHint();
      else if ((k === 'd' || k === ' ') && !e.ctrlKey) {
        e.preventDefault();
        keys.current.deal();
      } else if (k === 'n' && !e.ctrlKey) keys.current.open();
      else if (k === 'escape') keys.current.close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const dealsLeft = shown.stock.length / 10;
  const blocked = cur.stock.length > 0 && !canDeal(cur);

  return (
    <div className="play">
      <header className="rail">
        <span className="wordmark">Spider</span>
        <span className="deal-tag">
          {game.suits} suit{game.suits > 1 ? 's' : ''} · #{game.seed}
        </span>
        <span className="spacer" />
        {WITH_SOLVER && (
          <a className="solver-link" href="./">
            Solver
          </a>
        )}
        <button onClick={() => setSheet(true)}>New deal</button>
      </header>

      <Table
        state={shown}
        vanishing={frame?.vanishing ?? new Set()}
        onTap={onTap}
        onDrop={onDrop}
        stockEl={() => stockRef.current}
        reduceMotion={reduceMotion}
        hint={shownHint?.type === 'move' ? shownHint : null}
      />

      <footer className="tray" style={{ position: 'relative' }}>
        {toast && (
          <div key={toast.n} className="toast" style={{ bottom: 'calc(100% + 8px)' }}>
            {toast.text}
          </div>
        )}
        <div className="tray-row">
          <div className="runs" aria-label={`${shown.completed} of 8 suits completed`}>
            <span className="runs-label">Runs {shown.completed}/8</span>
            <div className="runs-slots">
              {Array.from({ length: 8 }, (_, i) => {
                const suit = shown.completedSuits[i];
                const filled = suit !== undefined;
                return (
                  <div
                    key={i}
                    className={`run-slot${filled ? ` filled ${suitClass(suit)}` : ''}${filled && popRun === i + 1 ? ' pop' : ''}`}
                  >
                    {filled ? suitSymbol(suit) : ''}
                  </div>
                );
              })}
            </div>
          </div>

          <span className="moves">
            {game.moves.length}
            <span className="moves-label">moves</span>
          </span>

          <button
            ref={stockRef}
            className={`stock${dealsLeft === 0 ? ' empty' : ''}${blocked ? ' blocked' : ''}${shownHint?.type === 'deal' ? ' hint' : ''}`}
            onClick={deal}
            aria-label={dealsLeft ? `Deal a row (${dealsLeft} left)` : 'Stock empty'}
            style={{ width: dealsLeft ? 36 + (dealsLeft - 1) * 7 : 36 }}
          >
            {dealsLeft === 0 ? (
              <span className="stock-empty">empty</span>
            ) : (
              <>
                {Array.from({ length: dealsLeft }, (_, i) => (
                  <span key={i} className="back" style={{ left: i * 7 }} />
                ))}
                <span className="deals-left">{dealsLeft}</span>
              </>
            )}
          </button>
        </div>

        <div className="actions">
          <button onClick={undo} disabled={game.moves.length === 0}>
            ↶ Undo
          </button>
          <button className="hint-btn" onClick={showHint} disabled={won}>
            Hint
          </button>
          <button onClick={redo} disabled={game.redo.length === 0}>
            Redo ↷
          </button>
        </div>
      </footer>

      {sheet && !won && (
        <div className="scrim" onClick={() => setSheet(false)}>
          <div className="sheet" role="dialog" aria-label="New deal" onClick={(e) => e.stopPropagation()}>
            <h2>New deal</h2>
            <p>Pick a difficulty to deal a fresh random game. This one ends.</p>
            <div className="suit-choices">
              {SUIT_OPTIONS.map((n) => (
                <button
                  key={n}
                  className={`suit-choice${n === game.suits ? ' current' : ''}`}
                  onClick={() => newDeal(n)}
                >
                  <SuitGlyphs n={n} />
                  <span className="label">
                    {n} suit{n > 1 ? 's' : ''}
                  </span>
                </button>
              ))}
            </div>
            <div className="sheet-row">
              <button onClick={restart} disabled={game.moves.length === 0}>
                Restart deal #{game.seed}
              </button>
              <button onClick={() => setSheet(false)}>Keep playing</button>
            </div>
          </div>
        </div>
      )}

      {won && !frame && (
        <div className="scrim">
          <div className="sheet win" role="dialog" aria-label="You won">
            <h2>All eight runs home.</h2>
            <div className="count">
              {game.moves.length} <span className="runs-label">moves</span>
            </div>
            <p>
              Deal #{game.seed}, {game.suits} suit{game.suits > 1 ? 's' : ''}. Deal again:
            </p>
            <div className="suit-choices">
              {SUIT_OPTIONS.map((n) => (
                <button
                  key={n}
                  className={`suit-choice${n === game.suits ? ' current' : ''}`}
                  onClick={() => newDeal(n)}
                >
                  <SuitGlyphs n={n} />
                  <span className="label">
                    {n} suit{n > 1 ? 's' : ''}
                  </span>
                </button>
              ))}
            </div>
            <div className="sheet-row">
              <button onClick={undo}>↶ Undo last move</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
