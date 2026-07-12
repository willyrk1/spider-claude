//! Iterative depth-first solver with make/undo and a transposition table.
//!
//! No native recursion (so deep searches can't overflow the stack) and no
//! per-move board clone (so the hot loop barely allocates):
//!   - an explicit stack of `Frame`s mirrors what the call stack used to hold,
//!   - `board.make` / `board.undo` mutate one shared board in place,
//!   - a global `visited` set means no state is ever expanded twice,
//!   - a light move ordering tries "productive" moves first,
//!   - a node budget bounds hard/unsolvable deals.

use std::collections::HashSet;

use crate::board::{Board, Move, Undo, COLS};
use crate::card::{rank, suit};

pub struct SolveResult {
    pub moves: Option<Vec<Move>>,
    pub nodes: u64,
    pub hit_limit: bool,
}

/// One level of the search: the moves available at a node and how far we've
/// gotten through them.
struct Frame {
    moves: Vec<Move>,
    idx: usize,
}

pub struct Solver;

impl Solver {
    pub fn solve(board: &Board, node_limit: u64) -> SolveResult {
        let mut board = board.clone();
        let mut visited: HashSet<u64> = HashSet::new();
        let mut nodes: u64 = 0;

        // `path` and `undos` run in parallel: path[i] is the move taken to enter
        // depth i+1, undos[i] reverses it. `stack` holds the frame per depth.
        let mut path: Vec<Move> = Vec::new();
        let mut undos: Vec<Undo> = Vec::new();
        let mut stack: Vec<Frame> = Vec::new();

        if board.is_won() {
            return SolveResult { moves: Some(path), nodes, hit_limit: false };
        }
        visited.insert(board.hash());
        stack.push(Frame { moves: generate(&board), idx: 0 });

        loop {
            let top = match stack.last_mut() {
                Some(f) => f,
                None => break, // search space exhausted: no solution
            };

            // Try moves from this frame until one leads to a fresh state.
            let mut descend: Option<Undo> = None;
            while top.idx < top.moves.len() {
                let m = top.moves[top.idx];
                top.idx += 1;

                nodes += 1;
                if nodes > node_limit {
                    return SolveResult { moves: None, nodes, hit_limit: true };
                }

                let undo = board.make(m);
                if board.is_won() {
                    path.push(m);
                    return SolveResult { moves: Some(path), nodes, hit_limit: false };
                }
                if visited.insert(board.hash()) {
                    path.push(m);
                    descend = Some(undo);
                    break;
                }
                board.undo(&undo); // already seen — revert and try the next sibling
            }
            // `top`'s borrow ends here, so we can push/pop `stack` below.

            match descend {
                Some(undo) => {
                    undos.push(undo);
                    stack.push(Frame { moves: generate(&board), idx: 0 });
                }
                None => {
                    // Frame exhausted: backtrack one level.
                    stack.pop();
                    if let Some(undo) = undos.pop() {
                        board.undo(&undo);
                        path.pop();
                    }
                }
            }
        }

        SolveResult { moves: None, nodes, hit_limit: false }
    }
}

/// Generate the legal moves at the current state, ordered best-first.
fn generate(board: &Board) -> Vec<Move> {
    let mut moves = Vec::new();
    board.gen_moves(&mut moves);
    moves.sort_by_key(|m| move_key(board, m));
    moves
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
