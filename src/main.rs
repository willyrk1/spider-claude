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
    let node_limit: u64 = arg(&args, "--nodes").unwrap_or(20_000_000);
    // Explicit --weight/--fdw forces a single configuration; otherwise the
    // default is the parallel portfolio.
    let explicit_weight: Option<u32> = arg(&args, "--weight");
    let explicit_fdw: Option<u32> = arg(&args, "--fdw");
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

    let start = Instant::now();
    let result = if explicit_weight.is_some() || explicit_fdw.is_some() {
        let w = explicit_weight.unwrap_or(solver::DEFAULT_WEIGHT);
        let fdw = explicit_fdw.unwrap_or(solver::DEFAULT_FD_WEIGHT);
        println!("search: single config (weight {}, fdw {})", w, fdw);
        Solver::solve(&board, node_limit, w, fdw)
    } else {
        println!(
            "search: portfolio of {} configs across threads",
            solver::DEFAULT_PORTFOLIO.len()
        );
        Solver::solve_portfolio(&board, node_limit, solver::DEFAULT_PORTFOLIO)
    };
    let elapsed = start.elapsed();

    match result.moves {
        Some(moves) => {
            let quality = if result.from_fallback {
                "DFS fallback — long path; A* found nothing in budget".to_string()
            } else if result.converged {
                "shortest found (search converged)".to_string()
            } else {
                "shortest found so far — raise --nodes to shorten further".to_string()
            };
            let via = match result.winning_config {
                Some((w, fdw)) => format!(" via weight {}, fdw {}", w, fdw),
                None => String::new(),
            };
            println!(
                "SOLVED in {} moves [{}]{} — searched {} nodes in {:.2?}",
                moves.len(),
                quality,
                via,
                result.nodes,
                elapsed
            );

            // Self-check: replay the solution on a fresh deal and confirm it wins.
            let mut check = Board::deal(suits, seed);
            for &m in &moves {
                check.make(m);
            }
            if check.is_won() {
                println!("verified: replaying the solution wins ✓");
            } else {
                eprintln!("BUG: reported solution does NOT win when replayed!");
                std::process::exit(1);
            }

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
