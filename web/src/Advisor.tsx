import { useEffect, useState } from 'react';
import { Board } from './Board';
import { advise, type AdviseResponse } from './api';
import {
  describeMove,
  displayState,
  parseCards,
  parseSession,
  serializeSession,
  type Move,
} from './game';

type ColInput = { faceDown: number; text: string };

const EMPTY_COLS: ColInput[] = Array.from({ length: 10 }, () => ({ faceDown: 0, text: '' }));

const STORAGE_KEY = 'spider-advisor-session';

/** Restore the last board from this browser's localStorage, if any. */
function loadSaved(): { suits: number; cols: ColInput[] } | null {
  try {
    const text = localStorage.getItem(STORAGE_KEY);
    if (!text) return null;
    const { session } = parseSession(text);
    return session ? { suits: session.suits, cols: session.cols } : null;
  } catch {
    return null;
  }
}

// A small mid-game snapshot to try the advisor on. Column 1's 5♠ can move onto
// column 0's 6♠, uncovering a face-down card.
const EXAMPLE: ColInput[] = [
  { faceDown: 5, text: '6s' },
  { faceDown: 5, text: '5s' },
  { faceDown: 4, text: 'Kh' },
  { faceDown: 4, text: '2c' },
  { faceDown: 4, text: '9d' },
  { faceDown: 4, text: '7h' },
  { faceDown: 4, text: 'Qs' },
  { faceDown: 4, text: '3d' },
  { faceDown: 4, text: '10c' },
  { faceDown: 4, text: 'Jh' },
];

/** Play-along advisor: enter what you can see, get recommended moves. */
export default function Advisor() {
  const [suits, setSuits] = useState<number>(() => loadSaved()?.suits ?? 4);
  const [cols, setCols] = useState<ColInput[]>(() => loadSaved()?.cols ?? EXAMPLE);
  const [resp, setResp] = useState<AdviseResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sessionText, setSessionText] = useState('');
  const [copied, setCopied] = useState(false);

  // Auto-save the board to this browser so a refresh doesn't lose it.
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, serializeSession({ suits, cols }));
    } catch {
      /* ignore quota / privacy-mode errors */
    }
  }, [suits, cols]);

  const parsed = cols.map((c) => parseCards(c.text));
  const firstBadCol = parsed.findIndex((p) => p.error);

  function setCol(i: number, patch: Partial<ColInput>) {
    setCols((cs) => cs.map((c, j) => (j === i ? { ...c, ...patch } : c)));
    setResp(null);
  }

  function onCopySession() {
    const text = serializeSession({ suits, cols });
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
    const { session, error: err } = parseSession(sessionText);
    if (err || !session) {
      setError(`Couldn't load session: ${err ?? 'invalid'}`);
      return;
    }
    setSuits(session.suits);
    setCols(session.cols);
    setResp(null);
    setError(null);
  }

  async function onAdvise() {
    if (firstBadCol >= 0) {
      setError(`Column ${firstBadCol}: ${parsed[firstBadCol].error}`);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const columns = cols.map((c, i) => ({ face_down: c.faceDown, up: parsed[i].cards }));
      setResp(await advise({ suits, columns }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setResp(null);
    } finally {
      setLoading(false);
    }
  }

  const displayCols = cols.map((c, i) => ({
    faceDown: c.faceDown,
    up: parsed[i].error ? [] : parsed[i].cards,
  }));
  const state = displayState(displayCols);
  const firstMove: Move | null = resp && resp.moves.length ? resp.moves[0] : null;

  return (
    <div className="advisor">
      <p className="hint">
        Enter the game you're playing elsewhere: each column's <b>face-down count</b>{' '}
        and its <b>face-up cards</b>, typed in order down the pile (buried first,
        the playable card last), e.g. <code>Ks Qh 10c</code>. Suits: <code>s h c d</code>.
        Hidden cards stay unknown, so this is advice, not a full solution — it
        favors moves that <b>uncover face-down cards</b>. Reveal them, update the
        board, and ask again.
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
        <button className="primary" onClick={onAdvise} disabled={loading}>
          {loading ? 'Thinking…' : 'Get advice'}
        </button>
        <button onClick={() => { setCols(EXAMPLE); setResp(null); setError(null); }}>Load example</button>
        <button onClick={() => { setCols(EMPTY_COLS); setResp(null); setError(null); }}>Clear</button>
      </div>

      <div className="col-editor">
        {cols.map((c, i) => (
          <div key={i} className={`col-row${parsed[i].error ? ' bad' : ''}`}>
            <span className="cr-label">col {i}</span>
            <label className="cr-fd">
              face-down
              <input
                type="number"
                min={0}
                max={20}
                value={c.faceDown}
                onChange={(e) => setCol(i, { faceDown: Math.max(0, Number(e.target.value)) })}
              />
            </label>
            <input
              className="cr-cards"
              placeholder="face-up cards, e.g. Ks Qh 10c"
              value={c.text}
              onChange={(e) => setCol(i, { text: e.target.value })}
            />
            {parsed[i].error && <span className="cr-err">{parsed[i].error}</span>}
          </div>
        ))}
      </div>

      <details className="session">
        <summary>💾 Save / load session</summary>
        <p className="hint">
          Copy this text to save or share your game; paste it back and{' '}
          <b>Load from text</b> to restore. Your board is also auto-saved in this
          browser, so a refresh won't lose it.
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

      {resp && (
        <>
          <div className={`banner ${resp.moves.length ? 'good' : 'warn'}`}>{resp.note}</div>
          {resp.moves.length > 0 && (
            <ol className="move-list">
              {resp.moves.map((m, i) => (
                <li key={i}>{describeMove(m)}</li>
              ))}
            </ol>
          )}
        </>
      )}

      <h3 className="board-title">
        Your board{firstMove ? ' — first recommended move highlighted' : ''}
      </h3>
      <Board state={state} move={firstMove} showStock={false} />
    </div>
  );
}
