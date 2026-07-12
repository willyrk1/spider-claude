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
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};

use crate::board::{Board, Move, Undo, COLS};
use crate::card::{rank, suit};

/// Default weight on the heuristic. `w = 1` is optimal but slow with a weak
/// heuristic; larger `w` trades a little length for a lot of speed (weighted A*)
/// and, on hard deals, the difference between finding a win and not.
pub const DEFAULT_WEIGHT: u32 = 2;

/// Default weight on face-down cards in the heuristic. Raising it makes the
/// search favor states that have turned up more buried cards.
pub const DEFAULT_FD_WEIGHT: u32 = 4;

/// Default portfolio of `(weight, fd_weight)` configurations run in parallel.
/// Chosen for diversity — the sweep showed different settings crack largely
/// different 4-suit deals, so their union solves far more than any single one.
pub const DEFAULT_PORTFOLIO: &[(u32, u32)] =
    &[(2, 4), (3, 4), (3, 2), (3, 8), (3, 12), (2, 2)];

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
    /// The `(weight, fd_weight)` config that produced the answer, when the
    /// portfolio was used.
    pub winning_config: Option<(u32, u32)>,
}

/// A recommendation from the partial-information advisor.
pub struct Advice {
    /// The recommended sequence of moves to play now.
    pub moves: Vec<Move>,
    /// How many face-down cards the plan exposes (ready to turn up).
    pub uncovers: u32,
    /// How many K..A runs the plan completes.
    pub completes: u32,
    /// How many columns the plan empties.
    pub empties: u32,
}

struct Frame {
    moves: Vec<Move>,
    idx: usize,
}

pub struct Solver;

impl Solver {
    /// Single-configuration search: weighted-A* primary, DFS fallback.
    pub fn solve(board: &Board, node_limit: u64, weight: u32, fd_weight: u32) -> SolveResult {
        let never = AtomicBool::new(false);
        let mut nodes: u64 = 0;

        // Primary: weighted-A* for a short solution (and best shot at hard deals).
        let (astar, converged) = astar_short(board, node_limit, &mut nodes, weight, fd_weight, &never);
        if let Some(p) = astar {
            return SolveResult {
                moves: Some(p), nodes, hit_limit: false, converged,
                from_fallback: false, winning_config: None,
            };
        }

        // Fallback: plain DFS for *any* solution, with its own fresh budget.
        let mut dfs_nodes: u64 = 0;
        let fallback = dfs_first(board, node_limit, &mut dfs_nodes);
        nodes += dfs_nodes;
        match fallback {
            Some(p) => SolveResult {
                moves: Some(p), nodes, hit_limit: false, converged: false,
                from_fallback: true, winning_config: None,
            },
            None => SolveResult {
                moves: None, nodes, hit_limit: true, converged: false,
                from_fallback: false, winning_config: None,
            },
        }
    }

    /// Run several `(weight, fd_weight)` A* searches in parallel (one thread
    /// each) and take the first solution any of them finds; a shared stop flag
    /// halts the rest. Different configs crack largely different hard deals, so
    /// the portfolio's coverage far exceeds any single configuration's. Falls
    /// back to a single-threaded DFS only if every config comes up empty.
    pub fn solve_portfolio(board: &Board, node_limit: u64, configs: &[(u32, u32)]) -> SolveResult {
        let stop = Arc::new(AtomicBool::new(false));
        let (tx, rx) = mpsc::channel();

        let mut handles = Vec::with_capacity(configs.len());
        for &(w, fdw) in configs {
            let board = board.clone();
            let stop = Arc::clone(&stop);
            let tx = tx.clone();
            handles.push(std::thread::spawn(move || {
                let mut nodes: u64 = 0;
                let (res, converged) = astar_short(&board, node_limit, &mut nodes, w, fdw, &stop);
                // Ignore send errors: the receiver may already have a winner.
                let _ = tx.send(((w, fdw), res, converged, nodes));
            }));
        }
        drop(tx); // so `rx` ends once every worker has reported

        // Drain every worker's report: remember the first solution, tally nodes.
        let mut winner: Option<((u32, u32), Vec<Move>, bool)> = None;
        let mut total_nodes: u64 = 0;
        for (config, res, converged, nodes) in rx {
            total_nodes += nodes;
            if winner.is_none() {
                if let Some(p) = res {
                    stop.store(true, Ordering::Relaxed); // tell the others to quit
                    winner = Some((config, p, converged));
                }
            }
        }
        for h in handles {
            let _ = h.join();
        }

        if let Some((config, p, converged)) = winner {
            return SolveResult {
                moves: Some(p), nodes: total_nodes, hit_limit: false, converged,
                from_fallback: false, winning_config: Some(config),
            };
        }

        // No config solved it: last-resort DFS for *any* solution.
        let mut dfs_nodes: u64 = 0;
        let fallback = dfs_first(board, node_limit, &mut dfs_nodes);
        total_nodes += dfs_nodes;
        match fallback {
            Some(p) => SolveResult {
                moves: Some(p), nodes: total_nodes, hit_limit: false, converged: false,
                from_fallback: true, winning_config: None,
            },
            None => SolveResult {
                moves: None, nodes: total_nodes, hit_limit: true, converged: false,
                from_fallback: false, winning_config: None,
            },
        }
    }

    /// Partial-information advisor. Over the *visible* cards only — no deals, and
    /// unknown (face-down) cards can't be moved — search for a short sequence
    /// that best improves the position, chiefly by uncovering face-down cards.
    /// Returns the recommended plan and what it achieves; re-run after revealing
    /// the newly-exposed cards.
    pub fn advise(board: &Board, node_limit: u64) -> Advice {
        const DEPTH_CAP: usize = 30;

        let mut b = board.clone();
        // Discovery is tableau-only: dealing reveals stock cards but is a
        // committal, user-driven action, so don't let the search deal.
        b.stock.clear();
        let initial_fd = board.face_down_total();
        let mut visited: HashSet<u64> = HashSet::new();
        let mut path: Vec<Move> = Vec::new();
        let mut undos: Vec<Undo> = Vec::new();
        let mut stack: Vec<Frame> = Vec::new();
        let mut nodes: u64 = 0;

        let mut best_score = advice_score(&b, initial_fd);
        let mut best_path: Vec<Move> = Vec::new();

        visited.insert(b.hash());
        stack.push(Frame { moves: generate(&b), idx: 0 });

        'search: loop {
            let top = match stack.last_mut() {
                Some(f) => f,
                None => break,
            };
            let mut descend = None;
            if path.len() < DEPTH_CAP {
                while top.idx < top.moves.len() {
                    let m = top.moves[top.idx];
                    top.idx += 1;
                    nodes += 1;
                    if nodes > node_limit {
                        break 'search;
                    }
                    let undo = b.make(m);
                    if visited.insert(b.hash()) {
                        path.push(m);
                        let sc = advice_score(&b, initial_fd);
                        // Strictly better score wins; equal score prefers the
                        // shorter plan.
                        if sc > best_score || (sc == best_score && path.len() < best_path.len()) {
                            best_score = sc;
                            best_path = path.clone();
                        }
                        descend = Some(undo);
                        break;
                    }
                    b.undo(&undo);
                }
            }
            match descend {
                Some(undo) => {
                    undos.push(undo);
                    stack.push(Frame { moves: generate(&b), idx: 0 });
                }
                None => {
                    stack.pop();
                    if let Some(undo) = undos.pop() {
                        b.undo(&undo);
                        path.pop();
                    }
                }
            }
        }

        // Replay the winning plan to report what it achieves.
        let mut end = board.clone();
        for &m in &best_path {
            end.make(m);
        }
        Advice {
            moves: best_path,
            uncovers: initial_fd - end.face_down_total(),
            completes: end.completed as u32,
            empties: end.empty_columns(),
        }
    }
}

/// Estimated moves remaining (0 exactly at a win). Not admissible — it's tuned
/// to guide the search, not to prove optimality.
fn heuristic(b: &Board, fd_weight: u32) -> u32 {
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
    // unlock arbitrary moves), so they lower the estimate. `fd_weight` controls
    // how strongly the search favors turning up face-down cards.
    let base = face_down * fd_weight + breaks * 3 + stock * 2 + remaining_runs * 6;
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
fn astar_short(
    start: &Board,
    node_limit: u64,
    nodes: &mut u64,
    w: u32,
    fdw: u32,
    stop: &AtomicBool,
) -> (Option<Vec<Move>>, bool) {
    let mut arena: Vec<Node> = vec![Node { parent: u32::MAX, mv: Move::Deal }];
    let mut closed: HashSet<u64> = HashSet::new();
    // (priority, g, arena index); Reverse so the smallest priority pops first.
    let mut open: BinaryHeap<(Reverse<u32>, u32, u32)> = BinaryHeap::new();

    closed.insert(start.hash());
    open.push((Reverse(w * heuristic(start, fdw)), 0, 0));

    while let Some((_pri, g, idx)) = open.pop() {
        // Another portfolio worker already won — abandon this search.
        if stop.load(Ordering::Relaxed) {
            return (None, false);
        }
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
                let pri = (g + 1) + w * heuristic(&board, fdw);
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

/// Score a partially-known state for the advisor: reward completed runs, then
/// uncovered face-down cards, then empty columns, then longer built runs.
fn advice_score(b: &Board, initial_fd: u32) -> i64 {
    let uncovered = (initial_fd - b.face_down_total()) as i64;
    let completed = b.completed as i64;
    let empties = b.empty_columns() as i64;
    let build = b.run_bonus() as i64;
    completed * 1000 + uncovered * 100 + empties * 40 + build * 2
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
