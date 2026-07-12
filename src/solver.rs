//! Solver that returns a *short* solution.
//!
//! A plain DFS finds *a* solution fast, but it's a long, meandering path — DFS
//! never seeks short paths. Short solutions (and the best shot at hard deals)
//! need a heuristic that estimates "distance to the goal" so the search heads
//! toward it. So:
//!
//!   - **Primary** is a weighted-A\* search ordered by `g + w*h`, where `g` is
//!     moves made and `h` estimates moves remaining. It explores far fewer,
//!     far more purposeful states and returns a much shorter solution — and on
//!     hard deals it's the search most likely to find a win at all.
//!   - **Fallback** is a plain make/undo DFS. It only runs if A\* fails, so a
//!     solvable easy deal always gets *an* answer even if A\* ran out of budget.
//!
//! A\* runs first with the full budget; the DFS fallback gets its own budget
//! only when A\* comes up empty.

use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashSet};

use crate::board::{Board, Move, COLS};
use crate::card::{rank, suit};

/// Default weight on the heuristic. `w = 1` is optimal but slow with a weak
/// heuristic; larger `w` trades a little length for a lot of speed (weighted A*)
/// and, on hard deals, the difference between finding a win and not.
pub const DEFAULT_WEIGHT: u32 = 2;

pub struct SolveResult {
    pub moves: Option<Vec<Move>>,
    pub nodes: u64,
    pub hit_limit: bool,
    /// True when A* fully explored its space within budget (no shorter solution
    /// was findable). Meaningful only when `moves` came from A*.
    pub converged: bool,
    /// True when the answer came from the DFS fallback (A* found nothing), so
    /// the solution is valid but not short.
    pub from_fallback: bool,
}

struct Frame {
    moves: Vec<Move>,
    idx: usize,
}

pub struct Solver;

impl Solver {
    pub fn solve(board: &Board, node_limit: u64, weight: u32) -> SolveResult {
        let mut nodes: u64 = 0;

        // Primary: weighted-A* for a short solution (and best shot at hard deals).
        let (astar, converged) = astar_short(board, node_limit, &mut nodes, weight);
        if let Some(p) = astar {
            return SolveResult { moves: Some(p), nodes, hit_limit: false, converged, from_fallback: false };
        }

        // Fallback: plain DFS for *any* solution, with its own fresh budget.
        let mut dfs_nodes: u64 = 0;
        let fallback = dfs_first(board, node_limit, &mut dfs_nodes);
        nodes += dfs_nodes;
        match fallback {
            Some(p) => SolveResult { moves: Some(p), nodes, hit_limit: false, converged: false, from_fallback: true },
            None => SolveResult { moves: None, nodes, hit_limit: true, converged: false, from_fallback: false },
        }
    }
}

/// Estimated moves remaining (0 exactly at a win). Not admissible — it's tuned
/// to guide the search, not to prove optimality.
fn heuristic(b: &Board) -> u32 {
    let mut face_down = 0u32;
    let mut breaks = 0u32;
    let mut empties = 0u32;
    for c in 0..COLS {
        let col = &b.cols[c];
        if col.is_empty() {
            empties += 1;
            continue;
        }
        let fd = b.face_down[c] as usize;
        face_down += fd as u32;
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
    let remaining_runs = 8 - b.completed as u32;
    // Every hidden card must be uncovered, every break resolved, every stock card
    // dealt, and every remaining run assembled. Empty columns are powerful (they
    // unlock arbitrary moves), so they lower the estimate.
    let base = face_down * 4 + breaks * 3 + stock * 2 + remaining_runs * 6;
    base.saturating_sub(empties * 3)
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
fn astar_short(start: &Board, node_limit: u64, nodes: &mut u64, w: u32) -> (Option<Vec<Move>>, bool) {
    let mut arena: Vec<Node> = vec![Node { parent: u32::MAX, mv: Move::Deal }];
    let mut closed: HashSet<u64> = HashSet::new();
    // (priority, g, arena index); Reverse so the smallest priority pops first.
    let mut open: BinaryHeap<(Reverse<u32>, u32, u32)> = BinaryHeap::new();

    closed.insert(start.hash());
    open.push((Reverse(w * heuristic(start)), 0, 0));

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
                let pri = (g + 1) + w * heuristic(&board);
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
