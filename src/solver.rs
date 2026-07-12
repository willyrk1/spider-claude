//! Two-phase solver that returns a *short* solution.
//!
//! A plain DFS finds *a* solution fast, but it's a long, meandering path — DFS
//! never seeks short paths, and a depth cap alone gives the search no guidance.
//! Short solutions need a heuristic that estimates "distance to the goal" so the
//! search heads toward it. So:
//!
//!   - **Phase 1** runs a plain depth-first search to find *a* solution quickly
//!     (the old reliable behavior). This guarantees an answer for solvable
//!     deals — no regression — and is kept as a fallback.
//!   - **Phase 2** runs a weighted-A\* search ordered by `g + W*h`, where `g` is
//!     moves made and `h` estimates moves remaining. It explores far fewer,
//!     far more purposeful states and returns a much shorter solution.
//!
//! Both phases share one node budget, and the shorter of the two results wins.

use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashSet};

use crate::board::{Board, Move, COLS};
use crate::card::{rank, suit};

/// Weight on the heuristic. `W = 1` is optimal but slow with a weak heuristic;
/// `W > 1` trades a little length for a lot of speed (weighted A*).
const W: u32 = 2;

pub struct SolveResult {
    pub moves: Option<Vec<Move>>,
    pub nodes: u64,
    pub hit_limit: bool,
    /// True when Phase 2 (A*) fully explored its space within budget.
    pub converged: bool,
}

struct Frame {
    moves: Vec<Move>,
    idx: usize,
}

pub struct Solver;

impl Solver {
    pub fn solve(board: &Board, node_limit: u64) -> SolveResult {
        let mut nodes: u64 = 0;

        // Phase 1: any solution, fast (also proves solvability / fallback).
        let phase1 = dfs_first(board, node_limit, &mut nodes);
        let mut best = match phase1 {
            Some(p) => p,
            None => return SolveResult { moves: None, nodes, hit_limit: nodes >= node_limit, converged: false },
        };

        // Phase 2: heuristic search for a shorter solution with the rest.
        let (astar, converged) = astar_short(board, node_limit, &mut nodes);
        if let Some(p) = astar {
            if p.len() < best.len() {
                best = p;
            }
        }

        SolveResult {
            moves: Some(best),
            nodes,
            hit_limit: nodes >= node_limit,
            converged,
        }
    }
}

/// Estimated moves remaining (0 exactly at a win). Not admissible — it's tuned
/// to guide the search, not to prove optimality.
fn heuristic(b: &Board) -> u32 {
    let mut face_down = 0u32;
    let mut breaks = 0u32;
    let mut tableau = 0u32;
    for c in 0..COLS {
        let fd = b.face_down[c] as usize;
        face_down += fd as u32;
        let col = &b.cols[c];
        tableau += col.len() as u32;
        // Count "breaks": adjacent face-up cards not in same-suit descending order.
        for i in fd..col.len().saturating_sub(1) {
            let upper = col[i];
            let lower = col[i + 1];
            if !(suit(upper) == suit(lower) && rank(upper) == rank(lower) + 1) {
                breaks += 1;
            }
        }
    }
    let stock = b.stock.len() as u32;
    // Every hidden card must be uncovered, every break resolved, every run still
    // owed assembled, and the tableau ultimately emptied.
    face_down * 2 + breaks * 2 + stock + tableau / 4 + (8 - b.completed as u32)
}

/// Plain depth-first search for the first solution (never re-expands a state).
fn dfs_first(start: &Board, node_limit: u64, nodes: &mut u64) -> Option<Vec<Move>> {
    let mut board = start.clone();
    let mut visited: HashSet<u64> = HashSet::new();
    let mut path: Vec<Move> = Vec::new();
    let mut undos = Vec::new();
    let mut stack: Vec<Frame> = Vec::new();

    if board.is_won() {
        return Some(path);
    }
    visited.insert(board.hash());
    stack.push(Frame { moves: generate(&board), idx: 0 });

    loop {
        let top = match stack.last_mut() {
            Some(f) => f,
            None => return None,
        };
        let mut descend = None;
        while top.idx < top.moves.len() {
            let m = top.moves[top.idx];
            top.idx += 1;
            *nodes += 1;
            if *nodes > node_limit {
                return None;
            }
            let undo = board.make(m);
            if board.is_won() {
                path.push(m);
                return Some(path);
            }
            if visited.insert(board.hash()) {
                path.push(m);
                descend = Some(undo);
                break;
            }
            board.undo(&undo);
        }
        match descend {
            Some(undo) => {
                undos.push(undo);
                stack.push(Frame { moves: generate(&board), idx: 0 });
            }
            None => {
                stack.pop();
                if let Some(undo) = undos.pop() {
                    board.undo(&undo);
                    path.pop();
                }
            }
        }
    }
}

/// A search-tree node, kept tiny: just enough to walk back to the root. The
/// board is *not* stored — it's reconstructed on demand by replaying moves.
#[derive(Clone, Copy)]
struct Node {
    parent: u32, // u32::MAX for the root
    mv: Move,    // move from parent into this node (meaningless for the root)
}

/// Weighted-A* search ordered by `g + W*h`. Returns the solution (if found) and
/// whether the open set was exhausted within budget (converged).
///
/// Memory-lean: nodes are 8 bytes (no stored board), and expansion uses
/// make/undo on one working board instead of cloning per child.
fn astar_short(start: &Board, node_limit: u64, nodes: &mut u64) -> (Option<Vec<Move>>, bool) {
    let mut arena: Vec<Node> = vec![Node { parent: u32::MAX, mv: Move::Deal }];
    let mut closed: HashSet<u64> = HashSet::new();
    // (priority, g, arena index); Reverse so the smallest priority pops first.
    let mut open: BinaryHeap<(Reverse<u32>, u32, u32)> = BinaryHeap::new();

    closed.insert(start.hash());
    open.push((Reverse(W * heuristic(start)), 0, 0));

    while let Some((_pri, g, idx)) = open.pop() {
        // Rebuild this node's board once, then expand with make/undo.
        let mut board = board_at(start, &arena, idx);
        let mut moves = Vec::new();
        board.gen_moves(&mut moves);

        for m in moves {
            *nodes += 1;
            if *nodes > node_limit {
                return (None, false);
            }
            let undo = board.make(m);
            if board.is_won() {
                return (Some(reconstruct(&arena, idx, m)), true);
            }
            if closed.insert(board.hash()) {
                let ci = arena.len() as u32;
                let pri = (g + 1) + W * heuristic(&board);
                arena.push(Node { parent: idx, mv: m });
                open.push((Reverse(pri), g + 1, ci));
            }
            board.undo(&undo);
        }
    }
    (None, true) // open exhausted: no (further) solution reachable
}

/// Reconstruct a node's board by replaying its moves from the root.
fn board_at(start: &Board, arena: &[Node], idx: u32) -> Board {
    let mut rev = Vec::new();
    let mut i = idx;
    while arena[i as usize].parent != u32::MAX {
        rev.push(arena[i as usize].mv);
        i = arena[i as usize].parent;
    }
    let mut board = start.clone();
    for &m in rev.iter().rev() {
        board.make(m);
    }
    board
}

/// Walk parent pointers to rebuild the move sequence, then append the final
/// winning move `last`.
fn reconstruct(arena: &[Node], idx: u32, last: Move) -> Vec<Move> {
    let mut rev = vec![last];
    let mut i = idx;
    while arena[i as usize].parent != u32::MAX {
        rev.push(arena[i as usize].mv);
        i = arena[i as usize].parent;
    }
    rev.reverse();
    rev
}

/// Generate the legal moves at the current state, ordered best-first so Phase 1
/// finds a first solution quickly.
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
