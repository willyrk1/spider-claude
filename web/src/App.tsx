import { useState } from 'react';
import SolveView from './SolveView';
import Advisor from './Advisor';

export default function App() {
  const [mode, setMode] = useState<'solve' | 'advise'>('solve');

  return (
    <div className="app">
      <header>
        <h1>🕷️ Spider Solitaire Solver</h1>
        <p className="tagline">
          Rust engine · portfolio A* search · solutions verified by replay
        </p>
      </header>

      <div className="tabs">
        <button
          className={`tab${mode === 'solve' ? ' active' : ''}`}
          onClick={() => setMode('solve')}
        >
          Solve a deal
        </button>
        <button
          className={`tab${mode === 'advise' ? ' active' : ''}`}
          onClick={() => setMode('advise')}
        >
          Play along (advisor)
        </button>
      </div>

      {mode === 'solve' ? <SolveView /> : <Advisor />}
    </div>
  );
}
