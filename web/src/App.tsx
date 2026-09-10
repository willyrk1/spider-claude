import TrackSolve from './TrackSolve';

export default function App() {
  return (
    <div className="app">
      <header>
        <div className="title-row">
          <h1>🕷️ Spider Solitaire Solver</h1>
          <a className="mode-link" href="play.html">
            Just play a random deal →
          </a>
        </div>
        <p className="tagline">
          Rust engine · portfolio A* search · solutions verified by replay
        </p>
      </header>

      <TrackSolve />
    </div>
  );
}
