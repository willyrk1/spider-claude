# spider-web

A React + TypeScript front end for the Spider Solitaire solver, plus a casual
table for just playing.

## Just play (`play.html`)

A random deal you play yourself — built phone-first, and entirely in the
browser (no solver server), so it can be hosted on any static host.

- **Tap a card** to move it (with everything on top of it). It goes to the first
  of: a column whose top card is the **same suit** (the one that makes the
  longest same-suit run wins); a column with a **different suit**; an **empty**
  column. If it can't go anywhere the cards shake (and the phone buzzes, where
  supported).
- **Drag** a card to put it somewhere else than the tap would.
- **Tap the stock** (bottom right; one back per deal left) to deal a row. It
  refuses while a column is empty — the standard rule.
- **↶ Undo** is unlimited. **New deal** picks 1, 2, or 4 suits, or restarts.
- The game auto-saves in the browser. Deals use the engine's own RNG, so
  `play.html?suits=4&seed=7` is the same deal as `POST /solve {suits:4, seed:7}`.
- Desktop keys: `Z` undo, `D`/Space deal, `N` new deal.

It shares the solver's deck (four-colour suits, card faces) and move logic
(`src/game.ts`); its own code lives in `src/play/`. In dev it's at
http://localhost:5173/play.html (the solver links to it).

**Standalone build:** `npm run build:play` builds just the table into
`dist-play/`, and folds it into a single self-contained `dist-play/index.html`
(~165 KB; fonts come from Google Fonts) — upload that one file anywhere.

## Solver

Two modes:

- **Solve a deal** — deal a game by suits + seed, then play the solver's full
  solution move by move.
- **Track & solve** — track a real game as you reveal cards (uses `POST /plan`).
  Type in the face-up cards; ask for the next steps to uncover more; the tool
  applies the moves and shows each newly-revealed card as a **?** to fill in;
  deal a row when stuck; **↶ Undo** reverses the last move/deal. Once every card
  is known it returns — and plays — the full winning solution from your current
  position.

  The model: the game is determined by the initial deck, which you *learn* as
  you reveal cards. So a revealed card feeds the **initial deal** (knowledge),
  while moves/deals are the reversible **actions** — and Undo reverses actions
  only, never your knowledge. The **Save / load session** panel stores the
  (partially-known) initial deal plus the action log (`t0…t9` + `stock` +
  `move`/`deal` lines); pasting it back replays the game exactly — handy for
  resuming, sharing, or reporting a bug. Auto-saves to the browser too.

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
