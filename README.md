# spider-solver

A fast, native **Spider Solitaire** solver written in Rust with **zero dependencies**.
Built for the "just give me an answer" use case: feed it a deal, get a solution
(or a proof it ran out of search budget) as fast as the machine allows.

## Build & run

Requires the Rust toolchain (see install note below).

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
| `--nodes`  | `20000000`| search budget; raise it for harder deals            |
| `--quiet`  | off       | suppress the board dump and per-move solution list  |

## How it works

- **`src/card.rs`** — a card is one byte: `(suit << 4) | rank`.
- **`src/board.rs`** — board state, Spider rules, move generation, `make`/`undo`
  (in-place with an undo record, no cloning), and a *canonical* hash (columns
  are sorted before hashing, so column permutations collapse to one state — a
  big transposition-table win).
- **`src/solver.rs`** — a two-phase search:
  1. **Phase 1** — plain make/undo DFS with a transposition table finds *a*
     solution fast (guarantees an answer for solvable deals; kept as fallback).
  2. **Phase 2** — weighted-A\* ordered by `g + W*h`, where `h` estimates moves
     remaining (face-down cards, sequence breaks, stock, tableau size). This
     finds a *much* shorter solution. Nodes are 8 bytes (board reconstructed by
     replay), so memory stays low.

  The shorter of the two results wins, and `main` self-verifies it by replaying.
- **`src/rng.rs`** — a tiny xorshift PRNG so deals are reproducible offline.

Typical 1-suit solutions are ~100–130 moves (down from the 1k–12k that a naive
first-win DFS produces).

## Where to optimize next (in rough order of payoff)

1. **Crack 4-suit** — still unsolved within budget; needs a stronger lower-bound
   heuristic and/or a transposition table inside the A\* frontier.
2. **A stronger, admissible heuristic** to return provably-optimal lengths and
   cut A\* node counts.
3. **Bitset/`u64` state encoding** to hash and compare states without heap.

The rules and search are deliberately separated so the front end you eventually
want (CLI today; REST API, WASM, or a Kotlin/React UI later) can wrap this core
unchanged.

## Note

Spider is not always winnable. `NOT SOLVED` means either the search hit its node
budget (raise `--nodes`) or the deal genuinely has no solution.
