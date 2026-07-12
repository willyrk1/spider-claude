# spider-solver

A fast, native **Spider Solitaire** solver written in Rust. The engine and CLI
have **zero dependencies**; an optional HTTP API adds axum/tokio. Built for the
"just give me an answer" use case: feed it a deal, get a solution (or a proof it
ran out of search budget) as fast as the machine allows.

## Build & run (CLI)

Requires the Rust toolchain (see install note below). `cargo build`/`cargo run`
from the workspace root build only the zero-dependency core + CLI.

```sh
cargo run --release -- --suits 1
cargo run --release -- --suits 2 --seed 7
cargo run --release -- --suits 4 --nodes 20000000 --quiet
```

Flags:

| flag       | default   | meaning                                             |
|------------|-----------|-----------------------------------------------------|
| `--suits`  | `1`       | difficulty: `1`, `2`, or `4` suits                  |
| `--seed`   | `42`      | RNG seed for the deal (reproducible)               |
| `--nodes`  | `20000000`| per-search node budget; raise it for harder deals   |
| `--weight` | portfolio | if set, forces a single A\* with this `g + weight*h` weight (else the portfolio runs) |
| `--fdw`    | portfolio | if set, forces the heuristic's face-down weight (else the portfolio runs) |
| `--quiet`  | off       | suppress the board dump and per-move solution list  |

## Project layout

A Cargo workspace so the engine can back many front ends:

```
crates/
├── core/   spider-core — pure engine (card, board, solver, rng); no I/O, no deps
├── cli/    spider-cli  — the `spider` binary; a thin front end over the core
└── api/    spider-api  — HTTP API (axum/tokio) exposing the solver as JSON
web/        React + TypeScript UI that calls the API (see web/README.md)
```

`cargo build` (no `-p`) builds only the zero-dependency core + CLI; the API is
built explicitly (`-p spider-api`). A WASM build could slot in the same way.

A browser UI lives in [`web/`](web/): it deals a game via the API, renders the
board, and plays the solver's solution move by move.

## HTTP API

A thin, stateless JSON wrapper over the engine.

```sh
cargo run --release -p spider-api          # serves http://127.0.0.1:3000
```

- `GET  /health` → `ok`
- `POST /solve` → deal a game (by `suits` + `seed`) and solve it.

Request body: `{ "suits": 4, "seed": 0, "nodes"?: 20000000, "weight"?: n,
"fdw"?: n, "include_board"?: false }`. Omitting `weight`/`fdw` runs the parallel
portfolio; setting either forces that single config.

```sh
curl -s localhost:3000/solve -H 'content-type: application/json' \
  -d '{"suits":4,"seed":0,"include_board":true}'
```

Response: `{ solved, verified, quality, move_count, winning_config,
nodes_searched, moves: [{type:"tableau",from,to,count} | {type:"deal"}],
initial_board? }`. The solution is self-verified server-side by replaying it.

> **Windows + GNU toolchain note:** building the API compiles `tokio`'s
> `windows-sys`, which needs `dlltool.exe` from a full MinGW-w64 install (e.g.
> WinLibs). The core/CLI don't need it. On the MSVC toolchain this isn't an issue.

## How it works

- **`crates/core/src/card.rs`** — a card is one byte: `(suit << 4) | rank`.
- **`crates/core/src/board.rs`** — board state, Spider rules, move generation,
  `make`/`undo` (in-place with an undo record, no cloning), and a *canonical*
  hash (columns are sorted before hashing, so column permutations collapse to
  one state — a big transposition-table win).
- **`crates/core/src/solver.rs`** — a heuristic search:
  - Each search is a **weighted-A\*** ordered by `g + weight*h`, where `h`
    estimates moves remaining. The heuristic counts face-down cards, sequence
    "breaks", and stock, and *rewards empty columns* — that last term is what
    makes 4-suit tractable, because an empty column unlocks arbitrary moves.
    Nodes are 8 bytes (board reconstructed by replay), so memory stays low.
  - By default the solver runs a **portfolio**: several `(weight, fd_weight)`
    configs in parallel (one thread each), taking the first solution any finds
    and stopping the rest. Different configs crack largely different hard deals,
    so the portfolio's coverage far exceeds any single config's. A single-
    threaded DFS is a last-resort fallback if every config comes up empty.

  The CLI self-verifies the returned solution by replaying it on a fresh deal,
  and reports which config won.
- **`crates/core/src/rng.rs`** — a tiny xorshift PRNG so deals are reproducible
  offline.

Typical 1-suit solutions are ~100–140 moves (down from the 1k–12k a naive
first-win DFS produces), found in well under a second. On 4-suit, the portfolio
is a big step up: it solved **27 of 30 sample deals (~90%)** at 15M nodes/thread
(seeds 0–29), in ~160–245 moves and mostly under a second — versus ~50% for any
single configuration. Every config in the portfolio won some deal no other did,
which is exactly why the union wins. The genuinely hard or unwinnable deals
still time out.

## Where to optimize next (in rough order of payoff)

1. **The hard 4-suit tail** — a stronger heuristic (e.g. a pattern-database
   lower bound) or macro-moves ("supermoves") would reach the deals that time
   out even under the portfolio.
2. **An admissible heuristic + `weight 1`** to return provably-optimal lengths.
3. **Bitset/`u64` state encoding** to hash and compare states without heap.

The rules and search are deliberately separated so the front end you eventually
want (CLI today; REST API, WASM, or a Kotlin/React UI later) can wrap this core
unchanged.

## Note

Spider is not always winnable. `NOT SOLVED` means either the search hit its node
budget (raise `--nodes`) or the deal genuinely has no solution.
