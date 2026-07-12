import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Board } from './Board';
import { solve, type SolveResponse } from './api';
import {
  computeStates,
  describeMove,
  initialState,
  type GameState,
  type Move,
} from './game';

export default function App() {
  const [suits, setSuits] = useState(4);
  const [seed, setSeed] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resp, setResp] = useState<SolveResponse | null>(null);
  const [states, setStates] = useState<GameState[] | null>(null);
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(220); // ms per move

  const moves: Move[] = resp?.moves ?? [];
  const atEnd = states ? step >= states.length - 1 : true;

  async function onSolve() {
    setLoading(true);
    setError(null);
    setPlaying(false);
    try {
      const r = await solve({ suits, seed });
      setResp(r);
      if (r.solved && r.initial_board) {
        setStates(computeStates(initialState(r.initial_board), r.moves));
        setStep(0);
      } else {
        setStates(null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setResp(null);
      setStates(null);
    } finally {
      setLoading(false);
    }
  }

  // Auto-advance while playing.
  useEffect(() => {
    if (!playing || !states) return;
    if (atEnd) {
      setPlaying(false);
      return;
    }
    const id = setTimeout(() => setStep((s) => s + 1), speed);
    return () => clearTimeout(id);
  }, [playing, step, states, speed, atEnd]);

  // Cross-check: replaying the moves in-browser should reach 8 completed runs.
  const replayWon = useMemo(
    () => (states ? states[states.length - 1].completed === 8 : false),
    [states],
  );

  const currentMove = states && step > 0 ? moves[step - 1] : null;

  return (
    <div className="app">
      <header>
        <h1>🕷️ Spider Solitaire Solver</h1>
        <p className="tagline">
          Rust engine · portfolio A* search · solutions verified by replay
        </p>
      </header>

      <div className="controls">
        <label>
          Suits
          <select value={suits} onChange={(e) => setSuits(Number(e.target.value))}>
            <option value={1}>1 (easy)</option>
            <option value={2}>2 (medium)</option>
            <option value={4}>4 (hard)</option>
          </select>
        </label>
        <label>
          Seed
          <input
            type="number"
            value={seed}
            min={0}
            onChange={(e) => setSeed(Number(e.target.value))}
          />
        </label>
        <button className="primary" onClick={onSolve} disabled={loading}>
          {loading ? 'Solving…' : 'Solve'}
        </button>
        {resp && (
          <button
            onClick={() => {
              setSeed((s) => s + 1);
            }}
            title="Bump the seed for a new deal"
          >
            Next deal →
          </button>
        )}
      </div>

      {error && <div className="banner error">⚠ {error}</div>}

      {resp && !resp.solved && (
        <div className="banner warn">
          No solution found within budget (quality: {resp.quality}). Try another
          seed or suit count.
        </div>
      )}

      {resp && resp.solved && (
        <div className="result">
          <div className="stats">
            <Stat label="Result">
              {resp.verified ? '✓ solved & verified' : 'solved (unverified!)'}
            </Stat>
            <Stat label="Moves">{resp.move_count}</Stat>
            <Stat label="Quality">{resp.quality}</Stat>
            <Stat label="Won by">
              {resp.winning_config
                ? `weight ${resp.winning_config.weight}, fdw ${resp.winning_config.fdw}`
                : 'single config'}
            </Stat>
            <Stat label="Nodes">{resp.nodes_searched.toLocaleString()}</Stat>
            <Stat label="In-browser replay">
              {replayWon ? '✓ reaches a win' : '… (mismatch)'}
            </Stat>
          </div>

          {states && (
            <div className="player">
              <div className="player-bar">
                <button onClick={() => { setPlaying(false); setStep(0); }}>⏮</button>
                <button
                  onClick={() => { setPlaying(false); setStep((s) => Math.max(0, s - 1)); }}
                >
                  ◀
                </button>
                <button className="primary" onClick={() => setPlaying((p) => !p)} disabled={atEnd}>
                  {playing ? '❚❚ Pause' : '▶ Play'}
                </button>
                <button
                  onClick={() => { setPlaying(false); setStep((s) => Math.min(states.length - 1, s + 1)); }}
                  disabled={atEnd}
                >
                  ▶
                </button>
                <button onClick={() => { setPlaying(false); setStep(states.length - 1); }}>⏭</button>
                <span className="counter">
                  move {step} / {states.length - 1}
                </span>
                <label className="speed">
                  speed
                  <input
                    type="range"
                    min={40}
                    max={500}
                    step={20}
                    value={520 - speed}
                    onChange={(e) => setSpeed(520 - Number(e.target.value))}
                  />
                </label>
              </div>
              <input
                className="scrubber"
                type="range"
                min={0}
                max={states.length - 1}
                value={step}
                onChange={(e) => { setPlaying(false); setStep(Number(e.target.value)); }}
              />
              <div className="move-desc">
                {currentMove
                  ? describeMove(currentMove)
                  : 'Initial deal'}{' '}
                <span className="completed">
                  · {states[step].completed}/8 runs complete
                </span>
              </div>
              <Board state={states[step]} move={currentMove} />
            </div>
          )}
        </div>
      )}

      {!resp && !loading && (
        <div className="empty-hint">
          Pick a difficulty and seed, then <b>Solve</b>. The board and the
          solver's moves will play out here.
        </div>
      )}
    </div>
  );
}

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{children}</div>
    </div>
  );
}
