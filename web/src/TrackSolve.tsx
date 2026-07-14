import { useEffect, useMemo, useState } from 'react';
import { Board, Foundations } from './Board';
import { plan, type PlanResponse } from './api';
import {
  boardDisplayState,
  boardToGameState,
  cardToShort,
  computeStates,
  deduceLastUnknown,
  deriveBoard,
  describeMove,
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
  type GameState,
  type InitialDeal,
} from './game';

const STORAGE_KEY = 'spider-track-session';

// Standard Spider rule: you can't deal a new row while any column is empty.
// Flip to true to allow the variant (kept off by default; the API/engine
// default matches).
const ALLOW_DEAL_WITH_EMPTY_COLUMNS = false;

/** Restore the saved session (initial deal + actions) from this browser. */
function loadSaved(): { suits: number; deal: InitialDeal; actions: Action[] } | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const { suits, deal, actions } = parseTrack(raw);
    return suits && deal && actions ? { suits, deal, actions } : null;
  } catch {
    return null;
  }
}

/**
 * Track a real game as you reveal cards; solve it once everything is known.
 * The session is the (partially-known) initial deal plus a log of actions
 * (moves/deals) — reveals feed the initial deal, not the action log — and the
 * board is derived by replaying the actions. So Undo reverses actions only, and
 * a saved session reproduces the game exactly.
 */
export default function TrackSolve() {
  const [suits, setSuits] = useState<number>(() => loadSaved()?.suits ?? 4);
  const [deal, setDeal] = useState<InitialDeal>(() => loadSaved()?.deal ?? newInitialDeal());
  const [actions, setActions] = useState<Action[]>(() => loadSaved()?.actions ?? []);
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

  // Solve-phase player.
  const [states, setStates] = useState<GameState[] | null>(null);
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, serializeTrack(suits, deal, actions));
    } catch {
      /* ignore */
    }
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
    if (!playing || !states) return;
    if (step >= states.length - 1) {
      setPlaying(false);
      return;
    }
    const id = setTimeout(() => setStep((s) => s + 1), 220);
    return () => clearTimeout(id);
  }, [playing, step, states]);

  const unfilled = hasUnrevealed(board, deal);
  const emptyColumns = board.columns.some((c) => c.cards.length === 0);
  const canDeal =
    stockRemaining(board) > 0 && (ALLOW_DEAL_WITH_EMPTY_COLUMNS || !emptyColumns) && !unfilled;

  function reset() {
    setDeal(newInitialDeal());
    setActions([]);
    setResp(null);
    setError(null);
    setStates(null);
    setDrafts({});
    setDeduced(null);
  }

  /** Undo the last *action* (move or deal). Revealed cards stay known. */
  function undo() {
    if (actions.length === 0) return;
    setActions((a) => a.slice(0, -1));
    setResp(null);
    setError(null);
    setStates(null);
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
    setStates(null);
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
    setPlaying(false);
    setStates(null);
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
      if (r.phase === 'solve') {
        setStates(computeStates(boardToGameState(board, deal), r.moves));
        setStep(0);
      }
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
  const solving = resp?.phase === 'solve' && states;
  const currentMove = solving && step > 0 ? resp!.moves[step - 1] : null;

  return (
    <div className="track">
      <p className="hint">
        Track a real game as you go. Type in the face-up cards you can see; ask
        for <b>next steps</b> to uncover more; fill in each revealed <b>?</b>{' '}
        card; <b>deal a row</b> when stuck. <b>↶ Undo</b> reverses the last move
        or deal (revealed cards stay known) — press it repeatedly to back out of
        a dead end. Once every card is known, it returns the full winning
        solution.
      </p>

      <div className="controls">
        <label>
          Suits
          <select value={suits} onChange={(e) => { setSuits(Number(e.target.value)); setResp(null); }}>
            <option value={1}>1</option>
            <option value={2}>2</option>
            <option value={4}>4</option>
          </select>
        </label>
        <button className="primary" onClick={() => onPlan()} disabled={loading || unfilled}>
          {loading ? 'Thinking…' : fullyKnown(board, deal) ? 'Solve!' : 'Get next steps'}
        </button>
        <button onClick={dealRow} disabled={!canDeal} title={canDeal ? '' : 'Deal needs cards in the stock, no empty columns, and no unfilled ? cards'}>
          Deal a row ({stockRemaining(board)})
        </button>
        <button onClick={undo} disabled={actions.length === 0} title="Undo the last move or deal">
          ↶ Undo
        </button>
        <button onClick={reset}>New game</button>
      </div>

      <details className="session">
        <summary>💾 Save / load session</summary>
        <p className="hint">
          The session is the (partially-known) initial deal plus your moves &
          deals — so it reproduces the game exactly. Copy it to save, share, or
          report a bug; paste one back and <b>Load from text</b> to replay it.
          Also auto-saves in this browser.
        </p>
        <div className="session-actions">
          <button onClick={onCopySession}>
            {copied ? 'Copied ✓' : 'Copy current session'}
          </button>
          <button onClick={onLoadSession}>Load from text</button>
        </div>
        <textarea
          className="session-text"
          rows={8}
          value={sessionText}
          onChange={(e) => setSessionText(e.target.value)}
          placeholder="Click 'Copy current session' to fill this box, or paste a previously-saved session here and click 'Load from text'."
        />
      </details>

      {error && <div className="banner error">⚠ {error}</div>}

      {deduced && (
        <div className="banner good">
          Only one card was unknown, so it's deduced: <b>{deduced}</b> (the one
          card missing from everything else). The deck is now fully known — hit{' '}
          <b>Solve!</b>.
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

      {resp && resp.phase !== 'solve' && (
        <>
          <div className={`banner ${resp.phase === 'discover' ? 'good' : 'warn'}`}>{resp.note}</div>

          {/* Normal search came up empty — offer the slower, deeper search. */}
          {resp.phase === 'stuck' && !resp.deep && (
            <button className="primary" onClick={() => onPlan(true)} disabled={loading}>
              {loading ? 'Searching deeper…' : '🔎 Search deeper (slow; may return a long plan)'}
            </button>
          )}

          {resp.moves.length > 0 && resp.deep && !deepConfirmed ? (
            /* Deep plan found — warn and confirm before showing/applying it. */
            <div className="banner warn">
              ⚠ This is a <b>{resp.moves.length}-move</b> maneuver — long and
              committal. Continue only if you want to play it all out.
              <div className="session-actions" style={{ marginTop: 8 }}>
                <button className="primary" onClick={() => setDeepConfirmed(true)}>
                  Show the {resp.moves.length}-move plan
                </button>
                <button onClick={() => setResp(null)}>Cancel</button>
              </div>
            </div>
          ) : (
            resp.moves.length > 0 && (
              <>
                <ol className="move-list">
                  {resp.moves.map((m, i) => (
                    <li key={i}>{describeMove(m)}</li>
                  ))}
                </ol>
                <button className="primary" onClick={applyMoves}>
                  Apply these moves ↴
                </button>
              </>
            )
          )}
        </>
      )}

      {solving && (
        <div className="result">
          <div className="banner good">
            {resp!.note} {resp!.verified ? '✓ verified' : ''}
            {resp!.winning_config
              ? ` · via weight ${resp!.winning_config.weight}, fdw ${resp!.winning_config.fdw}`
              : ''}
          </div>
          <div className="player-bar">
            <button onClick={() => { setPlaying(false); setStep(0); }}>⏮</button>
            <button onClick={() => { setPlaying(false); setStep((s) => Math.max(0, s - 1)); }}>◀</button>
            <button className="primary" onClick={() => setPlaying((p) => !p)} disabled={step >= states!.length - 1}>
              {playing ? '❚❚ Pause' : '▶ Play'}
            </button>
            <button onClick={() => { setPlaying(false); setStep((s) => Math.min(states!.length - 1, s + 1)); }} disabled={step >= states!.length - 1}>▶</button>
            <button onClick={() => { setPlaying(false); setStep(states!.length - 1); }}>⏭</button>
            <span className="counter">move {step} / {states!.length - 1}</span>
          </div>
          <div className="move-desc">
            {currentMove ? describeMove(currentMove) : 'Start'}{' '}
            <span className="completed">· {states![step].completed}/8 runs complete</span>
          </div>
          <Foundations
            suits={states![step].completedSuits}
            justCompleted={step > 0 && states![step].completed > states![step - 1].completed}
          />
          <Board state={states![step]} move={currentMove} showStock={false} />
        </div>
      )}

      {!solving && (
        <>
          <h3 className="board-title">Your board {unfilled ? '— fill in the ? cards' : ''}</h3>
          <Board state={boardDisplayState(board, deal)} move={null} showStock={false} />
        </>
      )}
    </div>
  );
}
