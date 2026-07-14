import TrackSolve from './TrackSolve';

export default function App() {
  return (
    <div className="app">
      <header>
        <h1>🕷️ Spider Solitaire Solver</h1>
        <p className="tagline">
          Rust engine · portfolio A* search · solutions verified by replay
        </p>
      </header>

      <TrackSolve />
    </div>
  );
}
