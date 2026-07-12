import { useEffect, useMemo, useState } from 'react';
import { Board, Foundations } from './Board';
import { plan, type PlanResponse } from './api';
import {
  allKnown,
  computeStates,
  describeMove,
  hasUnfilled,
  parseCards,
  parseTrack,
  replayLog,
  serializeTrack,
  trackDisplayState,
  trackToGameState,
  type GameState,
  type TrackEvent,
} from './game';

const STORAGE_KEY = 'spider-track-log';

/** Restore the saved action log from this browser, if any. */
function loadSaved(): { suits: number; log: TrackEvent[] } | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const { suits, log } = parseTrack(raw);
    return suits && log ? { suits, log } : null;
  } catch {
    return null;
  }
}

/**
 * Track a real game as you reveal cards; solve it once everything is known.
 * The whole game is stored as an action log (reveals, moves, deals) from the
 * initial deal, and the board is derived by replaying it — so a saved session
 * reproduces the game exactly.
 */
export default function TrackSolve() {
  const [suits, setSuits] = useState<number>(() => loadSaved()?.suits ?? 4);
  const [log, setLog] = useState<TrackEvent[]>(() => loadSaved()?.log ?? []);
  const board = useMemo(() => replayLog(log), [log]);

  const [resp, setResp] = useState<PlanResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [sessionText, setSessionText] = useState('');
  const [copied, setCopied] = useState(false);

  // Solve-phase player.
  const [states, setStates] = useState<GameState[] | null>(null);
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, serializeTrack(suits, log));
    } catch {
      /* ignore */
    }
  }, [suits, log]);

  useEffect(() => {
    if (!playing || !states) return;
    if (step >= states.length - 1) {
      setPlaying(false);
      return;
    }
    const id = setTimeout(() => setStep((s) => s + 1), 220);
    return () => clearTimeout(id);
  }, [playing, step, states]);

  const unfilled = hasUnfilled(board);
  const emptyColumns = board.columns.some((c) => c.faceDown === 0 && c.up.length === 0);
  const canDeal = board.stockCount > 0 && !emptyColumns && !unfilled;

  function reset() {
    setLog([]);
    setResp(null);
    setError(null);
    setStates(null);
    setDrafts({});
  }

  function onCopySession() {
    const text = serializeTrack(suits, log);
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
    const { suits: s, log: lg, error: err } = parseTrack(sessionText);
    if (err || !lg || !s) {
      setError(`Couldn't load session: ${err ?? 'invalid'}`);
      return;
    }
    setSuits(s);
    setLog(lg);
    setResp(null);
    setStates(null);
    setError(null);
    setDrafts({});
  }

  /** Record a revealed card in column `c` (appends to the log). */
  function fillCard(c: number, text: string) {
    const { cards, error: err } = parseCards(text);
    if (err || cards.length !== 1) {
      setError(`Column ${c}: type one card (e.g. Kh)`);
      return;
    }
    if (!board.columns[c].up.some((x) => x === null)) return; // no slot to fill
    setLog((l) => [...l, { kind: 'reveal', col: c, card: cards[0] }]);
    setDrafts((d) => ({ ...d, [c]: '' }));
    setError(null);
    setResp(null);
  }

  async function onPlan() {
    if (unfilled) {
      setError('Fill in the revealed (?) cards first.');
      return;
    }
    setLoading(true);
    setError(null);
    setPlaying(false);
    setStates(null);
    try {
      const columns = board.columns.map((c) => ({
        face_down: c.faceDown,
        cards: [
          ...Array.from({ length: c.faceDown }, () => null),
          ...c.up,
        ] as ({ rank: number; suit: number } | null)[],
      }));
      const stock = Array.from({ length: board.stockCount }, () => null);
      const r = await plan({ suits, columns, stock });
      setResp(r);
      if (r.phase === 'solve') {
        setStates(computeStates(trackToGameState(board), r.moves));
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
    const events: TrackEvent[] = resp.moves.map((m) =>
      m.type === 'deal'
        ? { kind: 'deal' }
        : { kind: 'move', from: m.from, to: m.to, count: m.count },
    );
    setLog((l) => [...l, ...events]);
    setResp(null);
    setDrafts({});
  }

  function dealRow() {
    setLog((l) => [...l, { kind: 'deal' }]);
    setResp(null);
  }

  const revealCols = board.columns
    .map((c, i) => (c.up.some((x) => x === null) ? i : -1))
    .filter((i) => i >= 0);

  const solving = resp?.phase === 'solve' && states;
  const currentMove = solving && step > 0 ? resp!.moves[step - 1] : null;

  return (
    <div className="track">
      <p className="hint">
        Track a real game as you go. Type in the face-up cards you can see; ask
        for <b>next steps</b> to uncover more; fill in each revealed <b>?</b>{' '}
        card; <b>deal a row</b> when stuck. Once every card is known, it returns
        the full winning solution.
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
        <button className="primary" onClick={onPlan} disabled={loading || unfilled}>
          {loading ? 'Thinking…' : allKnown(board) ? 'Solve!' : 'Get next steps'}
        </button>
        <button onClick={dealRow} disabled={!canDeal} title={canDeal ? '' : 'Deal needs cards in the stock, no empty columns, and no unfilled ? cards'}>
          Deal a row ({board.stockCount})
        </button>
        <button onClick={reset}>New game</button>
      </div>

      <details className="session">
        <summary>💾 Save / load session</summary>
        <p className="hint">
          This is the full action log from the initial deal, so it reproduces
          your game exactly. Copy it to save, share, or report a bug; paste one
          back and <b>Load from text</b> to replay it. Also auto-saves in this
          browser.
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
          {resp.moves.length > 0 && (
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
          <Board state={trackDisplayState(board)} move={null} showStock={false} />
        </>
      )}
    </div>
  );
}
