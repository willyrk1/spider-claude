import { useState } from 'react';
import { Board } from './Board';
import { advise, type AdviseResponse } from './api';
import { describeMove, displayState, parseCards, type Move } from './game';

type ColInput = { faceDown: number; text: string };

const EMPTY_COLS: ColInput[] = Array.from({ length: 10 }, () => ({ faceDown: 0, text: '' }));

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
  const [suits, setSuits] = useState(4);
  const [cols, setCols] = useState<ColInput[]>(EXAMPLE);
  const [resp, setResp] = useState<AdviseResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parsed = cols.map((c) => parseCards(c.text));
  const firstBadCol = parsed.findIndex((p) => p.error);

  function setCol(i: number, patch: Partial<ColInput>) {
    setCols((cs) => cs.map((c, j) => (j === i ? { ...c, ...patch } : c)));
    setResp(null);
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
