//! Depth-first solver with a transposition table.
//!
//! This is the piece to optimize later. Right now it's a straightforward
//! graph search:
//!   - clone the board per move (simple + correct; the obvious first thing to
//!     replace with make/undo if you need more speed),
//!   - a global `visited` set so no state is ever explored twice,
//!   - a light move ordering that tries "productive" moves first,
//!   - a node budget so hard/unsolvable deals terminate.

use std::collections::HashSet;

use crate::board::{Board, Move, COLS};
use crate::card::{rank, suit};

pub struct SolveResult {
    pub moves: Option<Vec<Move>>,
    pub nodes: u64,
    pub hit_limit: bool,
}

pub struct Solver {
    visited: HashSet<u64>,
    nodes: u64,
    node_limit: u64,
    path: Vec<Move>,
    hit_limit: bool,
}

impl Solver {
    pub fn solve(board: &Board, node_limit: u64) -> SolveResult {
        let mut s = Solver {
            visited: HashSet::new(),
            nodes: 0,
            node_limit,
            path: Vec::new(),
            hit_limit: false,
        };
        let mut b = board.clone();
        let won = s.dfs(&mut b);
        SolveResult {
            moves: if won { Some(s.path.clone()) } else { None },
            nodes: s.nodes,
            hit_limit: s.hit_limit,
        }
    }

    fn dfs(&mut self, b: &mut Board) -> bool {
        if b.is_won() {
            return true;
        }
        self.nodes += 1;
        if self.nodes > self.node_limit {
            self.hit_limit = true;
            return false;
        }
        if !self.visited.insert(b.hash()) {
            return false; // already fully explored from a previous path
        }

        let mut moves = Vec::new();
        b.gen_moves(&mut moves);
        moves.sort_by_key(|m| move_key(b, m));

        for m in moves {
            if self.hit_limit {
                return false;
            }
            let saved = b.clone();
            b.apply(m);
            self.path.push(m);
            if self.dfs(b) {
                return true;
            }
            self.path.pop();
            *b = saved;
        }
        false
    }
}

/// Lower key = tried first. Cheap heuristic: prefer moves that make real
/// progress (empty a column, flip a face-down card, or extend a same-suit run),
/// and deal from stock only as a last resort.
fn move_key(b: &Board, m: &Move) -> u8 {
    match *m {
        Move::Deal => 4,
        Move::Tableau { from, to, count } => {
            let (from, to, count) = (from as usize, to as usize, count as usize);
            let remaining = b.cols[from].len() - count;
            let fd = b.face_down[from] as usize;
            if remaining == 0 {
                return 0; // empties a column
            }
            if remaining == fd {
                return 0; // flips a face-down card
            }
            if to < COLS && !b.cols[to].is_empty() {
                let top = *b.cols[to].last().unwrap();
                let moved_bottom = b.cols[from][remaining];
                if suit(top) == suit(moved_bottom) && rank(top) == rank(moved_bottom) + 1 {
                    return 1; // builds a genuine same-suit run
                }
            }
            3
        }
    }
}
