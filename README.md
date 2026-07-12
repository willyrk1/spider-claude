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
| `--weight` | `2`       | heuristic weight in A\* (`g + weight*h`); higher is  |
|            |           | greedier — faster and more likely to crack hard deals, but longer solutions |
| `--quiet`  | off       | suppress the board dump and per-move solution list  |

## How it works

- **`src/card.rs`** — a card is one byte: `(suit << 4) | rank`.
- **`src/board.rs`** — board state, Spider rules, move generation, `make`/`undo`
  (in-place with an undo record, no cloning), and a *canonical* hash (columns
  are sorted before hashing, so column permutations collapse to one state — a
  big transposition-table win).
- **`src/solver.rs`** — a heuristic search:
  - **Primary** is a weighted-A\* ordered by `g + weight*h`, where `h` estimates
    moves remaining. The heuristic counts face-down cards, sequence "breaks", and
    stock, and *rewards empty columns* — that last term is what makes 4-suit
    tractable, because an empty column unlocks arbitrary moves. Nodes are 8 bytes
    (board reconstructed by replay), so memory stays low.
  - **Fallback** is a plain make/undo DFS that runs only if A\* finds nothing, so
    an easy solvable deal always gets *an* answer.

  `main` self-verifies the returned solution by replaying it on a fresh deal.
- **`src/rng.rs`** — a tiny xorshift PRNG so deals are reproducible offline.

Typical 1-suit solutions are ~100–130 moves (down from the 1k–12k a naive
first-win DFS produces). Many 4-suit deals now solve too (~180–220 moves),
though some remain out of reach within budget.

## Where to optimize next (in rough order of payoff)

1. **Solve more 4-suit deals** — a stronger heuristic and/or a transposition
   table inside the A\* frontier would extend reach to the currently-hard deals.
2. **An admissible heuristic + `weight 1`** to return provably-optimal lengths.
3. **Bitset/`u64` state encoding** to hash and compare states without heap.

The rules and search are deliberately separated so the front end you eventually
want (CLI today; REST API, WASM, or a Kotlin/React UI later) can wrap this core
unchanged.

## Note

Spider is not always winnable. `NOT SOLVED` means either the search hit its node
budget (raise `--nodes`) or the deal genuinely has no solution.
