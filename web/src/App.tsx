import { useState } from 'react';
import SolveView from './SolveView';
import Advisor from './Advisor';
import TrackSolve from './TrackSolve';

type Mode = 'solve' | 'advise' | 'track';

export default function App() {
  const [mode, setMode] = useState<Mode>('solve');

  const tab = (id: Mode, label: string) => (
    <button className={`tab${mode === id ? ' active' : ''}`} onClick={() => setMode(id)}>
      {label}
    </button>
  );

  return (
    <div className="app">
      <header>
        <h1>🕷️ Spider Solitaire Solver</h1>
        <p className="tagline">
          Rust engine · portfolio A* search · solutions verified by replay
        </p>
      </header>

      <div className="tabs">
        {tab('solve', 'Solve a deal')}
        {tab('advise', 'Play along (advisor)')}
        {tab('track', 'Track & solve')}
      </div>

      {mode === 'solve' && <SolveView />}
      {mode === 'advise' && <Advisor />}
      {mode === 'track' && <TrackSolve />}
    </div>
  );
}
