# spider-web

A React + TypeScript front end for the Spider Solitaire solver. Two modes:

- **Solve a deal** — deal a game by suits + seed, then play the solver's full
  solution move by move.
- **Play along (advisor)** — for a game you're playing elsewhere where you can
  only see the face-up cards. Enter each column's face-down count and face-up
  cards; the server recommends moves that best uncover face-down cards. Reveal
  the exposed cards, update the board, and ask again. (Uses `POST /advise`.)

## Run

Two processes: the API (Rust) and the Vite dev server (this app).

```sh
# 1) start the API (from the repo root; needs the GNU toolchain note in the
#    root README on Windows)
cargo run --release -p spider-api          # http://127.0.0.1:3000

# 2) start the web app (from web/)
npm install                                # first time only
npm run dev                                # http://localhost:5173
```

Open http://localhost:5173, pick a difficulty and seed, and click **Solve**.

The Vite dev server proxies `/api/*` to `http://127.0.0.1:3000`, so the browser
makes same-origin requests and the API needs no CORS config for local dev. (To
serve the built app from a different origin, you'd add CORS to the API.)

## What it does

- Sends `POST /api/solve` with `{ suits, seed, include_board: true }`.
- Renders the initial board from the response (`initial_board`).
- Replays the returned `moves` in the browser — a small TS port of the engine's
  move/deal/run-completion logic (`src/game.ts`) — and confirms it reaches a win
  (an independent cross-check of the Rust solver).
- A player (play/pause/step/scrub) animates the solution to the finish.
- A foundations row shows the completed K..A runs filling up (by suit) as the
  solution plays.

## Layout

- `src/game.ts` — card types, move application, run completion (mirrors the core).
- `src/api.ts` — the `/solve` client and response types.
- `src/Board.tsx` — board/column/card rendering.
- `src/App.tsx` — controls, stats, and the move player.
