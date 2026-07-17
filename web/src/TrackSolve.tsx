import { useEffect, useMemo, useState } from 'react';
import { Board, Foundations } from './Board';
import { plan, type PlanResponse } from './api';
import {
  boardDisplayState,
  boardToDisplayState,
  cardToShort,
  computeStates,
  deduceLastUnknown,
  decodeActions,
  decodeDeal,
  deriveBoard,
  describeMove,
  encodeActions,
  encodeDeal,
  fillOnlyUnknown,
  fullyKnown,
  hasUnrevealed,
  newInitialDeal,
  parseCards,
  parseTrack,
  planColumns,
  planStock,
  revealAt,
  revealTargets,
  serializeTrack,
  stockRemaining,
  type Action,
  type InitialDeal,
} from './game';

const STORAGE_KEY = 'spider-track-session';

// Standard Spider rule: you can't deal a new row while any column is empty.
// Flip to true to allow the variant (kept off by default; the API/engine
// default matches).
const ALLOW_DEAL_WITH_EMPTY_COLUMNS = false;

type Session = { suits: number; deal: InitialDeal; actions: Action[] };

/** Restore the saved session (initial deal + actions) from this browser. */
function loadSaved(): Session | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const { suits, deal, actions } = parseTrack(raw);
    return suits && deal && actions ? { suits, deal, actions } : null;
  } catch {
    return null;
  }
}

/** Read the game state from the URL query params (`d` deal, `m` moves). */
function loadFromUrl(): Session | null {
  try {
    const params = new URLSearchParams(window.location.search);
    const d = params.get('d');
    if (!d) return null;
    const decoded = decodeDeal(d);
    if (!decoded) return null;
    const actions = decodeActions(params.get('m') ?? '');
    if (actions === null) return null;
    return { suits: decoded.suits, deal: decoded.deal, actions };
  } catch {
    return null;
  }
}

/** URL params take priority over the browser's saved session, if present. */
const initialSession = loadFromUrl() ?? loadSaved();

/**
 * Track a real game as you reveal cards; solve it once everything is known.
 * The session is the (partially-known) initial deal plus a log of actions
 * (moves/deals) — reveals feed the initial deal, not the action log — and the
 * board is derived by replaying the actions. So Undo reverses actions only, and
 * a saved session reproduces the game exactly.
 */
export default function TrackSolve() {
  const [suits, setSuits] = useState<number>(() => initialSession?.suits ?? 4);
  const [deal, setDeal] = useState<InitialDeal>(() => initialSession?.deal ?? newInitialDeal());
  const [actions, setActions] = useState<Action[]>(() => initialSession?.actions ?? []);
  const board = useMemo(() => deriveBoard(deal, actions), [deal, actions]);

  const [resp, setResp] = useState<PlanResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [sessionText, setSessionText] = useState('');
  const [copied, setCopied] = useState(false);
  const [deduced, setDeduced] = useState<string | null>(null);
  // A deep-search plan is shown only after the user confirms (it can be long).
  const [deepConfirmed, setDeepConfirmed] = useState(false);

  // Plan player (shared by reveal plans and full solutions).
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(false);
  // Bumped on each *forward* step so the board animates the moved cards.
  // Back/jump/click leave it unchanged, so those update instantly.
  const [animNonce, setAnimNonce] = useState(0);

  // A plan is shown (and steppable) once we have moves — immediately for a
  // solution or a shallow reveal; a deep plan waits for the user to confirm.
  const showPlan =
    !!resp &&
    resp.moves.length > 0 &&
    (resp.phase === 'solve' || !resp.deep || deepConfirmed);

  // The board after each move of the shown plan, replayed on the current board.
  const planStates = useMemo(
    () => (showPlan ? computeStates(boardToDisplayState(board, deal), resp!.moves) : null),
    [showPlan, resp, board, deal],
  );

  // Reset the player whenever the shown plan changes.
  useEffect(() => {
    setStep(0);
    setPlaying(false);
  }, [planStates]);

  /** Advance one move, animating the cards. Used by Next and Play. */
  function advance() {
    setAnimNonce((n) => n + 1);
    setStep((s) => Math.min((planStates?.length ?? 1) - 1, s + 1));
  }
  function goTo(s: number) {
    setPlaying(false);
    setStep(s);
  }

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, serializeTrack(suits, deal, actions));
    } catch {
      /* ignore */
    }
  }, [suits, deal, actions]);

  // Mirror the game state into the URL: `d` = initial deal (with unknowns),
  // `m` = the moves so far. Both change as you play, and opening the page with
  // them reproduces the game. replaceState keeps it out of the history stack.
  useEffect(() => {
    const params = new URLSearchParams();
    params.set('d', encodeDeal(suits, deal));
    const m = encodeActions(actions);
    if (m) params.set('m', m);
    window.history.replaceState(null, '', `${window.location.pathname}?${params.toString()}`);
  }, [suits, deal, actions]);

  // When only one card is left unknown, deduce it — you never need to uncover
  // the last card (it's whatever is missing from everything else you entered).
  useEffect(() => {
    const card = deduceLastUnknown(deal, suits);
    if (card) {
      setDeal((d) => fillOnlyUnknown(d, card));
      setDeduced(cardToShort(card));
    }
  }, [deal, suits]);

  useEffect(() => {
    if (!playing || !planStates) return;
    if (step >= planStates.length - 1) {
      setPlaying(false);
      return;
    }
    const id = setTimeout(advance, 300);
    return () => clearTimeout(id);
  }, [playing, step, planStates]);

  const unfilled = hasUnrevealed(board, deal);
  const emptyColumns = board.columns.some((c) => c.cards.length === 0);
  const canDeal =
    stockRemaining(board) > 0 && (ALLOW_DEAL_WITH_EMPTY_COLUMNS || !emptyColumns) && !unfilled;

  function reset() {
    setDeal(newInitialDeal());
    setActions([]);
    setResp(null);
    setError(null);
    setDrafts({});
    setDeduced(null);
  }

  /** Back to the original deal: drop every move/deal, keep revealed cards. */
  function backToStart() {
    setActions([]);
    setResp(null);
    setError(null);
    setDrafts({});
  }

  /** Undo the last *action* (move or deal). Revealed cards stay known. */
  function undo() {
    if (actions.length === 0) return;
    setActions((a) => a.slice(0, -1));
    setResp(null);
    setError(null);
    setDrafts({});
  }

  function onCopySession() {
    const text = serializeTrack(suits, deal, actions);
    setSessionText(text);
    navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => {
        /* clipboard blocked — the text is in the box to copy manually */
      },
    );
  }

  function onLoadSession() {
    const { suits: s, deal: d, actions: a, error: err } = parseTrack(sessionText);
    if (err || !d || !a || !s) {
      setError(`Couldn't load session: ${err ?? 'invalid'}`);
      return;
    }
    setSuits(s);
    setDeal(d);
    setActions(a);
    setResp(null);
    setError(null);
    setDrafts({});
    setDeduced(null);
  }

  /** Record a revealed card into the initial deal. */
  function fillCard(c: number, text: string) {
    const { cards, error: err } = parseCards(text);
    if (err || cards.length !== 1) {
      setError(`Column ${c}: type one card (e.g. Kh)`);
      return;
    }
    setDeal((d) => revealAt(d, board, c, cards[0]));
    setDrafts((dr) => ({ ...dr, [c]: '' }));
    setError(null);
    setResp(null);
  }

  async function onPlan(deep = false) {
    if (unfilled) {
      setError('Fill in the revealed (?) cards first.');
      return;
    }
    setLoading(true);
    setError(null);
    setDeepConfirmed(false);
    try {
      const r = await plan({
        suits,
        columns: planColumns(board, deal),
        stock: planStock(board, deal),
        allow_deal_with_empty: ALLOW_DEAL_WITH_EMPTY_COLUMNS,
        deep,
      });
      setResp(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setResp(null);
    } finally {
      setLoading(false);
    }
  }

  function applyMoves() {
    if (!resp) return;
    const acts: Action[] = resp.moves.map((m) =>
      m.type === 'deal'
        ? { kind: 'deal' }
        : { kind: 'move', from: m.from, to: m.to, count: m.count },
    );
    setActions((a) => [...a, ...acts]);
    setResp(null);
    setDrafts({});
  }

  function dealRow() {
    setActions((a) => [...a, { kind: 'deal' }]);
    setResp(null);
  }

  const revealCols = revealTargets(board, deal);
  const isSolve = resp?.phase === 'solve';
  const currentMove = showPlan && step > 0 ? resp!.moves[step - 1] : null;
  const displayState = planStates ? planStates[step] : boardDisplayState(board, deal);
  const lastState = planStates ? planStates[planStates.length - 1] : null;
  const showFoundations = !!planStates && (isSolve || (lastState?.completed ?? 0) > 0);
  const atEnd = !planStates || step >= planStates.length - 1;

  return (
    <div className="track">
      <aside className="sidebar">
        <div className="controls">
          <button className="primary big" onClick={() => onPlan()} disabled={loading || unfilled}>
            {loading ? 'Thinking…' : fullyKnown(board, deal) ? '✦ Solve!' : '✦ Get next steps'}
          </button>
          <div className="control-row">
            <label className="suits">
              Suits
              <select
                value={suits}
                onChange={(e) => {
                  setSuits(Number(e.target.value));
                  setResp(null);
                }}
              >
                <option value={1}>1</option>
                <option value={2}>2</option>
                <option value={4}>4</option>
              </select>
            </label>
            <button
              onClick={dealRow}
              disabled={!canDeal}
              title={canDeal ? '' : 'Deal needs cards in the stock, no empty columns, and no unfilled ? cards'}
            >
              Deal a row ({stockRemaining(board)})
            </button>
          </div>
          <div className="control-row">
            <button onClick={undo} disabled={actions.length === 0} title="Undo the last move or deal">
              ↶ Undo
            </button>
            <button
              onClick={backToStart}
              disabled={actions.length === 0}
              title="Rewind all moves and deals back to the original deal"
            >
              ⟲ Original
            </button>
            <button onClick={reset}>New game</button>
          </div>
        </div>

        {error && <div className="banner error">⚠ {error}</div>}

        {deduced && (
          <div className="banner good">
            Only one card was unknown, so it's deduced: <b>{deduced}</b>. The deck
            is now fully known — hit <b>Solve!</b>.
          </div>
        )}

        {revealCols.length > 0 && (
          <div className="reveals">
            <b>Type in the revealed cards:</b>
            {revealCols.map((c) => (
              <span key={c} className="reveal-input">
                col {c}
                <input
                  autoFocus={c === revealCols[0]}
                  placeholder="?"
                  value={drafts[c] ?? ''}
                  onChange={(e) => setDrafts((d) => ({ ...d, [c]: e.target.value }))}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') fillCard(c, (e.target as HTMLInputElement).value);
                  }}
                  onBlur={(e) => e.target.value.trim() && fillCard(c, e.target.value)}
                />
              </span>
            ))}
          </div>
        )}

        {resp && (
          <div className="plan">
            <div className={`banner ${isSolve || resp.phase === 'discover' ? 'good' : 'warn'}`}>
              {resp.note}
              {isSolve && resp.verified ? ' ✓ verified' : ''}
            </div>

            {/* Normal search came up empty — offer the slower, deeper search. */}
            {resp.phase === 'stuck' && !resp.deep && (
              <button className="primary" onClick={() => onPlan(true)} disabled={loading}>
                {loading ? 'Searching deeper…' : '🔎 Search deeper (slow)'}
              </button>
            )}

            {/* Deep plan found — confirm before showing/stepping it. */}
            {resp.moves.length > 0 && resp.deep && !deepConfirmed && (
              <div className="banner warn">
                ⚠ A <b>{resp.moves.length}-move</b> maneuver. Step through it to
                review before playing it out.
                <div className="plan-actions">
                  <button className="primary" onClick={() => setDeepConfirmed(true)}>
                    Review the {resp.moves.length} moves
                  </button>
                  <button onClick={() => setResp(null)}>Cancel</button>
                </div>
              </div>
            )}

            {showPlan && planStates && (
              <>
                <div className="player-bar">
                  <button onClick={() => goTo(0)} disabled={step === 0} title="Start">
                    ⏮
                  </button>
                  <button onClick={() => goTo(Math.max(0, step - 1))} disabled={step === 0} title="Back">
                    ◀
                  </button>
                  <button
                    className="primary"
                    onClick={() => setPlaying((p) => !p)}
                    disabled={atEnd}
                    title="Play"
                  >
                    {playing ? '❚❚' : '▶'}
                  </button>
                  <button
                    onClick={() => {
                      setPlaying(false);
                      advance();
                    }}
                    disabled={atEnd}
                    title="Next"
                  >
                    ▶▶
                  </button>
                  <button
                    onClick={() => goTo(planStates.length - 1)}
                    disabled={atEnd}
                    title="End"
                  >
                    ⏭
                  </button>
                  <span className="counter">
                    {step} / {planStates.length - 1}
                  </span>
                </div>

                <ol className="move-list">
                  {resp.moves.map((m, i) => (
                    <li
                      key={i}
                      className={i === step - 1 ? 'current' : ''}
                      onClick={() => goTo(i + 1)}
                      title="Jump to this move"
                    >
                      {describeMove(m)}
                    </li>
                  ))}
                </ol>

                {!isSolve && (
                  <button className="primary" onClick={applyMoves}>
                    Apply these moves ↴
                  </button>
                )}
              </>
            )}
          </div>
        )}

        <details className="info">
          <summary>ℹ️ How this works</summary>
          <p className="hint">
            Track a real game as you go. Type in the face-up cards you can see;
            ask for <b>next steps</b> to uncover more; fill in each revealed{' '}
            <b>?</b> card; <b>deal a row</b> when stuck. <b>↶ Undo</b> reverses the
            last move or deal (revealed cards stay known). Suggested plans can be
            stepped through on the board — click any move to jump there, then{' '}
            <b>Apply</b> to play it. Once every card is known, it returns the full
            winning solution.
          </p>
        </details>

        <details className="session">
          <summary>💾 Save / load session</summary>
          <p className="hint">
            The session is the initial deal plus your moves & deals — it reproduces
            the game exactly. Copy it to save, share, or report a bug; paste one
            back and <b>Load from text</b> to replay it. Also auto-saves here and
            in the URL.
          </p>
          <div className="session-actions">
            <button onClick={onCopySession}>{copied ? 'Copied ✓' : 'Copy session'}</button>
            <button onClick={onLoadSession}>Load from text</button>
          </div>
          <textarea
            className="session-text"
            rows={7}
            value={sessionText}
            onChange={(e) => setSessionText(e.target.value)}
            placeholder="Click 'Copy session' to fill this box, or paste a saved session and click 'Load from text'."
          />
        </details>
      </aside>

      <main className="board-area">
        <div className="board-caption">
          {planStates ? (
            <>
              {currentMove ? describeMove(currentMove) : isSolve ? 'Starting position' : 'Before the plan'}
              {showFoundations && (
                <span className="completed"> · {displayState.completed}/8 runs</span>
              )}
            </>
          ) : (
            <>Your board{unfilled ? ' — fill in the ? cards' : ''}</>
          )}
        </div>

        {showFoundations && lastState && (
          <Foundations
            suits={displayState.completedSuits}
            justCompleted={step > 0 && (planStates![step].completed > planStates![step - 1].completed)}
          />
        )}

        <Board
          state={displayState}
          move={currentMove}
          showStock={false}
          prevState={planStates && step > 0 ? planStates[step - 1] : null}
          animNonce={animNonce}
        />
      </main>
    </div>
  );
}
