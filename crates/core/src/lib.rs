//! Spider Solitaire core engine.
//!
//! Pure computation with no I/O: card and board model, the game rules, and the
//! solver. It can back a CLI, an HTTP API, or a WASM build unchanged.
//!
//! Entry points:
//! - [`board::Board`] — deal a game, apply/undo moves, canonical hashing.
//! - [`solver::Solver`] — [`solver::Solver::solve`] (single config) and
//!   [`solver::Solver::solve_portfolio`] (parallel default).

pub mod board;
pub mod card;
pub mod rng;
pub mod solver;
