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
use std::collections::{BinaryHeap, HashSet, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};

use crate::board::{Board, Move, COLS};
use crate::card::{is_unknown, rank, suit};

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

    /// Partial-information advisor. Searches for a short sequence that reveals
    /// *unknown* cards — exposing a card you already know teaches you nothing, so
    /// only newly-learned (unknown) cards count.
    ///
    /// It first looks for a tableau-only plan (dealing is committal, so it's
    /// avoided when unnecessary). If none reveals anything, it searches again
    /// *allowing deals* — so a deal (or several) needed on the way to uncovering
    /// a card is built into the recommended plan rather than left for the user to
    /// figure out. A deal whose row is fully known is a look-ahead step the plan
    /// can continue past; a deal that would turn up unknown cards *is itself* the
    /// reveal, so the plan stops there (you can't plan past cards you can't see).
    /// Re-run after revealing the newly-exposed cards.
    pub fn advise(board: &Board, node_limit: u64) -> Advice {
        // Phase 1: tableau only (no deal). Clearing the stock stops `gen_moves`
        // from offering a deal.
        let mut tableau = board.clone();
        tableau.stock.clear();
        if let Some(advice) = search_reveals(&tableau, node_limit, false) {
            return advice;
        }

        // Phase 2: allow deals, chaining as many known-row deals as it takes to
        // reach an uncovering (each with any moves before/after it).
        if let Some(advice) = search_reveals(board, node_limit, true) {
            return advice;
        }

        Advice { uncovers: 0, completes: 0, empties: board.empty_columns(), moves: Vec::new() }
    }
}

/// Cap on *consecutive* reversible moves in a reveal plan. A reversible move
/// only shuffles face-up cards around; a committal one makes irreversible
/// progress (see `is_committal`). Long runs of reversible moves are pure
/// wandering — capping them keeps recovered plans tight and prunes the vast
/// majority of the search space (which is reachable only via such wandering).
const MAX_CONSEC_REVERSIBLE: u32 = 8;

/// A board's "progress" scalars: fewer face-down cards, more completed runs,
/// more empty columns, or less stock all mean irreversible progress was made.
#[inline]
fn progress_key(b: &Board) -> (u32, u8, u32, usize) {
    (b.face_down_total(), b.completed, b.empty_columns(), b.stock.len())
}

/// Whether the move from `before` to `after` made irreversible progress:
/// flipped a face-down card, completed a run, emptied a column, or dealt a row.
/// Everything else just rearranges face-up cards and is reversible.
#[inline]
fn is_committal(before: (u32, u8, u32, usize), after: (u32, u8, u32, usize)) -> bool {
    after.0 < before.0 || after.1 > before.1 || after.2 > before.2 || after.3 < before.3
}

/// Breadth-first search for the shortest plan that reveals unknown cards (or
/// completes runs). When `allow_deals` is set, a deal may be used as a plan step;
/// a deal whose row is fully known is a look-ahead the search plans past, while a
/// deal that would turn up unknown cards is a *terminal* reveal (recorded but not
/// expanded — you can't plan moves over cards you haven't seen). At most
/// `MAX_CONSEC_REVERSIBLE` reversible moves may run consecutively, so plans never
/// wander. Returns `None` if no reachable plan reveals anything. Because BFS
/// visits states in nondecreasing depth, the recovered plan is a shortest one
/// (under the cap) — no redundant detours.
fn search_reveals(start_board: &Board, node_limit: u64, allow_deals: bool) -> Option<Advice> {
    let start = start_board.clone();
    let start_completed = start.completed;
    let reward =
        |b: &Board| -> i64 { b.exposed_unknowns() as i64 + (b.completed - start_completed) as i64 * 20 };

    // Whether the next row `b` would deal (the top `COLS` of the stock, which a
    // deal pops from the end) is fully known — such a deal reveals nothing itself,
    // so the search may continue planning past it.
    let next_row_known = |b: &Board| -> bool {
        let n = b.stock.len();
        n >= COLS && b.stock[n - COLS..].iter().all(|&c| !is_unknown(c))
    };

    let mut arena: Vec<Node> = vec![Node { parent: u32::MAX, mv: Move::Deal }];
    // `reversibles[i]` = how many reversible moves run consecutively into node i.
    let mut reversibles: Vec<u32> = vec![0];
    let mut visited: HashSet<u64> = HashSet::new();
    let mut queue: VecDeque<u32> = VecDeque::new();
    let mut nodes: u64 = 0;

    visited.insert(start.hash());
    queue.push_back(0);

    let mut best_reward = reward(&start); // 0 — nothing revealed yet
    let mut best_idx: u32 = 0;

    'bfs: while let Some(idx) = queue.pop_front() {
        let mut b = board_at(&start, &arena, idx);
        let run = reversibles[idx as usize];
        // A deal that turns up unknown cards is itself the reveal, so we stop
        // planning past it; a fully-known-row deal is a look-ahead step.
        let terminal_deal = !next_row_known(&b);
        let mut moves = Vec::new();
        b.gen_moves(&mut moves);
        for m in moves {
            if matches!(m, Move::Deal) && !allow_deals {
                continue;
            }
            nodes += 1;
            if nodes > node_limit {
                break 'bfs;
            }
            let before = progress_key(&b);
            let undo = b.make(m);
            let committal = is_committal(before, progress_key(&b));
            // Cap consecutive reversible moves — don't wander.
            if !committal && run >= MAX_CONSEC_REVERSIBLE {
                b.undo(&undo);
                continue;
            }
            if visited.insert(b.hash()) {
                let ci = arena.len() as u32;
                arena.push(Node { parent: idx, mv: m });
                reversibles.push(if committal { 0 } else { run + 1 });
                let r = reward(&b);
                if r > best_reward {
                    best_reward = r;
                    best_idx = ci;
                }
                // Don't expand past a deal that revealed unknown cards.
                if !(matches!(m, Move::Deal) && terminal_deal) {
                    queue.push_back(ci);
                }
            }
            b.undo(&undo);
        }
    }

    if best_reward <= 0 {
        return None;
    }
    let moves = path_to(&arena, best_idx);
    let mut end = start.clone();
    for &m in &moves {
        end.make(m);
    }
    Some(Advice {
        uncovers: end.exposed_unknowns(),
        completes: (end.completed - start_completed) as u32,
        empties: end.empty_columns(),
        moves,
    })
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

/// The moves from the root down to `idx`, in order.
fn path_to(arena: &[Node], idx: u32) -> Vec<Move> {
    let mut rev = Vec::new();
    let mut i = idx;
    while arena[i as usize].parent != u32::MAX {
        rev.push(arena[i as usize].mv);
        i = arena[i as usize].parent;
    }
    rev.reverse();
    rev
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::card::{make_card, Card, UNKNOWN};

    fn parse_card(tok: &str) -> Card {
        if tok == "?" {
            return UNKNOWN;
        }
        let (rank_str, suit_ch) = tok.split_at(tok.len() - 1);
        let rank = match rank_str {
            "A" => 1,
            "J" => 11,
            "Q" => 12,
            "K" => 13,
            n => n.parse().expect("rank"),
        };
        let suit = match suit_ch {
            "s" => 0,
            "h" => 1,
            "c" => 2,
            "d" => 3,
            _ => panic!("suit"),
        };
        make_card(rank, suit)
    }

    fn cards(s: &str) -> Vec<Card> {
        s.split_whitespace().map(parse_card).collect()
    }

    /// A real reported position: fully-known stock, tableau frozen. The only
    /// columns whose next hidden card is unknown are under immovable Kings, so no
    /// tableau move (or single deal) reaches an unknown — a reveal needs a couple
    /// of deals plus setup moves.
    fn frozen_known_stock_board() -> Board {
        let cols: Vec<(u8, Vec<Card>)> = vec![
            (5, cards("5c 6c Jd 8h Qs 10c")),
            (5, cards("? ? ? ? 6d 9h")),
            (5, cards("? ? Jd Ac 8c 3c")),
            (5, cards("? ? ? ? 2c Ac")),
            (4, cards("? ? ? ? Ks")),
            (4, cards("? ? ? ? Kc")),
            (4, cards("? ? ? 10h 3h")),
            (4, cards("9d Js Ah 9c 3d")),
            (4, cards("? ? 8s 2h 3d")),
            (4, cards("? ? 10s 4d 6h")),
        ];
        // Stock in engine order: a deal pops from the end, so reverse deal order.
        let mut stock = cards(
            "8c 5s 7s 5c 7h 4s 7s 5d Qd Kd 5h 2s 6h 9s As 4h 10d Qs Kh 6d 7d 2c 4d Ah Jc \
             As 4s Qh 2d 2s 3c 5d 5s 7c 2h 10h 6s 10s Ad 9s Qd 7h Kc Jh 9h 8d 8d 8s Ks 5h",
        );
        stock.reverse();
        Board::from_parts(&cols, &stock).expect("valid board")
    }

    #[test]
    fn advise_builds_necessary_deals_into_a_reveal_plan() {
        let board = frozen_known_stock_board();
        assert_eq!(board.exposed_unknowns(), 0, "no unknown starts face-up");

        let advice = Solver::advise(&board, 2_000_000);

        assert!(!advice.moves.is_empty(), "expected a reveal plan, not stuck");
        assert!(
            advice.moves.iter().any(|m| matches!(m, Move::Deal)),
            "a deal must be built into the plan"
        );
        assert!(advice.uncovers >= 1, "the plan must reveal an unknown");

        // The plan is legal (make would panic otherwise), exposes exactly the
        // promised unknown count when replayed, and never wanders — no more than
        // MAX_CONSEC_REVERSIBLE reversible moves run in a row.
        let mut end = board.clone();
        let mut run = 0u32;
        for &m in &advice.moves {
            let before = progress_key(&end);
            end.make(m);
            if is_committal(before, progress_key(&end)) {
                run = 0;
            } else {
                run += 1;
                assert!(run <= MAX_CONSEC_REVERSIBLE, "plan wandered: {run} reversible moves in a row");
            }
        }
        assert_eq!(end.exposed_unknowns(), advice.uncovers);
    }

    #[test]
    fn advise_with_unknown_stock_recommends_exactly_one_deal() {
        // Same tableau, but the stock is unknown: the deal itself is the reveal,
        // so the plan is a single Deal — we never plan past cards we can't see.
        let mut board = frozen_known_stock_board();
        for c in board.stock.iter_mut() {
            *c = UNKNOWN;
        }
        let advice = Solver::advise(&board, 2_000_000);
        assert_eq!(advice.moves, vec![Move::Deal]);
        assert_eq!(advice.uncovers, 10);
    }
}
