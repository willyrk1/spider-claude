//! Spider Solitaire solver — native CLI.
//!
//! Usage:
//!   spider [--suits 1|2|4] [--seed N] [--nodes N] [--quiet]
//!
//! Examples:
//!   spider --suits 1                 # easy game, default seed
//!   spider --suits 2 --seed 7
//!   spider --suits 4 --nodes 20000000

mod board;
mod card;
mod rng;
mod solver;

use std::time::Instant;

use board::{Board, Move};
use solver::Solver;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let suits: u8 = arg(&args, "--suits").unwrap_or(1);
    let seed: u64 = arg(&args, "--seed").unwrap_or(42);
    let node_limit: u64 = arg(&args, "--nodes").unwrap_or(5_000_000);
    let quiet = args.iter().any(|a| a == "--quiet");

    if !matches!(suits, 1 | 2 | 4) {
        eprintln!("error: --suits must be 1, 2, or 4");
        std::process::exit(2);
    }

    let board = Board::deal(suits, seed);
    println!(
        "Spider {}-suit | seed {} | node limit {}",
        suits, seed, node_limit
    );
    if !quiet {
        println!("\nInitial deal:\n{}", board.render());
    }

    // The DFS can recurse very deep, so run it on a thread with a large stack
    // rather than the small default main-thread stack.
    let start = Instant::now();
    let search_board = board.clone();
    let result = std::thread::Builder::new()
        .stack_size(1 << 30) // 1 GiB
        .spawn(move || Solver::solve(&search_board, node_limit))
        .expect("spawn search thread")
        .join()
        .expect("search thread panicked");
    let elapsed = start.elapsed();

    match result.moves {
        Some(moves) => {
            println!(
                "SOLVED in {} moves — searched {} nodes in {:.2?}",
                moves.len(),
                result.nodes,
                elapsed
            );
            if !quiet {
                println!("\nSolution:");
                for (i, m) in moves.iter().enumerate() {
                    println!("  {:>3}. {}", i + 1, describe(&board, &moves, i, m));
                }
            }
        }
        None => {
            let why = if result.hit_limit {
                "hit node limit (try a larger --nodes)"
            } else {
                "no solution exists from this deal"
            };
            println!(
                "NOT SOLVED — {} — searched {} nodes in {:.2?}",
                why, result.nodes, elapsed
            );
        }
    }
}

/// Render a move as text. `board` + prior moves aren't replayed here (kept
/// simple); we just describe the move structurally.
fn describe(_board: &Board, _moves: &[Move], _idx: usize, m: &Move) -> String {
    match *m {
        Move::Deal => "deal a row from the stock".to_string(),
        Move::Tableau { from, to, count } => {
            format!("move {} card(s) from column {} to column {}", count, from, to)
        }
    }
}

/// Parse `--flag value` from argv into any FromStr type.
fn arg<T: std::str::FromStr>(args: &[String], flag: &str) -> Option<T> {
    let i = args.iter().position(|a| a == flag)?;
    args.get(i + 1)?.parse().ok()
}
