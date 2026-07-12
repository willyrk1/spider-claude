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
| `--nodes`  | `5000000` | search budget; raise it for hard 4-suit deals       |
| `--quiet`  | off       | suppress the board dump and per-move solution list  |

## How it works

- **`src/card.rs`** — a card is one byte: `(suit << 4) | rank`.
- **`src/board.rs`** — board state, Spider rules, move generation, and a
  *canonical* hash (columns are sorted before hashing, so column permutations
  collapse to one state — a big transposition-table win).
- **`src/solver.rs`** — DFS + a global `visited` set + light move ordering,
  bounded by a node budget.
- **`src/rng.rs`** — a tiny xorshift PRNG so deals are reproducible offline.

## Where to optimize next (in rough order of payoff)

1. **make/undo instead of `board.clone()` per move** — the single biggest win.
2. **Bitset/`u64` state encoding** to hash and compare states without heap.
3. **Better heuristics / IDA\*** to reach deep solutions with less search.
4. **Iterative deepening + a real lower-bound heuristic** for hard deals.

The rules and search are deliberately separated so the front end you eventually
want (CLI today; REST API, WASM, or a Kotlin/React UI later) can wrap this core
unchanged.

## Note

Spider is not always winnable. `NOT SOLVED` means either the search hit its node
budget (raise `--nodes`) or the deal genuinely has no solution.
