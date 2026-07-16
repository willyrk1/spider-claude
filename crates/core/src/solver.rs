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

use crate::board::{Board, Move, Undo, COLS};
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

    /// Deeper, opt-in reveal search for positions where `advise` finds nothing.
    /// Where `advise` is a breadth-first search for the *shortest* reveal (and so
    /// gives up when the shortest one lies beyond its budget), this dives depth-
    /// first and can uncover a card only reachable via a long maneuver — e.g.
    /// emptying a column to free a pinned King.
    ///
    /// A single depth-first pass finds an essentially arbitrary-length line (the
    /// consecutive-reversible cap that keeps it from wandering also decides, more
    /// or less by luck, how direct the route is). So this sweeps a ladder of caps
    /// and keeps the *shortest* line found, tightening a depth bound as it
    /// improves — later, tighter searches are cheap. The `node_limit` is a shared
    /// budget across the whole sweep. The result can still be long; callers should
    /// warn before using it. Returns an empty plan if nothing is found in budget.
    pub fn advise_deep(board: &Board, node_limit: u64, depth_limit: usize) -> Advice {
        let start_completed = board.completed;

        // Primary: a best-first search heads straight for the shallowest buried
        // unknown and returns a short line (typically a handful of moves per card
        // it has to clear). Only if it comes up empty within budget do we fall
        // back to the depth-first cap-ladder — which is strictly weaker (it caps
        // consecutive reversible moves, so it explores a subset), but explores in
        // a different order, giving a second chance when A* exhausts its budget.
        let (astar, used) = search_reveals_astar(board, node_limit, REVEAL_ASTAR_WEIGHT);
        let best = astar.or_else(|| {
            let mut remaining = node_limit.saturating_sub(used);
            let mut best: Option<Vec<Move>> = None;
            // A reveal this short is already fine for the "here's a deep line"
            // warning; don't burn budget chasing a few fewer moves.
            const GOOD_ENOUGH: usize = 60;
            for cap in [2u32, 3, 4, 5, 6, 8] {
                if remaining == 0 || best.as_ref().is_some_and(|p| p.len() <= GOOD_ENOUGH) {
                    break;
                }
                let depth = best.as_ref().map_or(depth_limit, |p| p.len().saturating_sub(1));
                if depth == 0 {
                    break;
                }
                let (found, u) = search_reveals_deep(board, remaining, depth, cap);
                remaining = remaining.saturating_sub(u);
                if let Some(moves) = found {
                    if best.as_ref().map_or(true, |b| moves.len() < b.len()) {
                        best = Some(moves);
                    }
                }
            }
            best
        });

        match best {
            Some(moves) => {
                // Drop wasted round trips the DFS left in before reporting.
                let moves = simplify_reveal_plan(board, moves);
                let mut end = board.clone();
                for &m in &moves {
                    end.make(m);
                }
                Advice {
                    uncovers: end.exposed_unknowns(),
                    completes: (end.completed - start_completed) as u32,
                    empties: end.empty_columns(),
                    moves,
                }
            }
            None => Advice { uncovers: 0, completes: 0, empties: board.empty_columns(), moves: Vec::new() },
        }
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

/// Cards sitting above the shallowest still-hidden unknown in column `c` — how
/// many must be cleared before it flips face-up. `None` if `c` hides no unknown.
fn cover_over_unknown(b: &Board, c: usize) -> Option<usize> {
    let col = &b.cols[c];
    let fd = b.face_down[c] as usize;
    (0..fd).rev().find(|&i| is_unknown(col[i])).map(|u| col.len() - 1 - u)
}

/// The unknown-hiding column that's easiest to break into (fewest cards on top
/// of its shallowest unknown) — the reveal search's dig target.
fn easiest_unknown_column(b: &Board) -> Option<usize> {
    (0..COLS)
        .filter_map(|c| cover_over_unknown(b, c).map(|cov| (cov, c)))
        .min()
        .map(|(_, c)| c)
}

/// Ordering score for a move in the deep reveal search (higher is tried first).
/// A depth-first search commits to whatever it explores first, so — unguided —
/// it wanders and blows its budget before reaching a deeply buried unknown. This
/// steers it: dig the easiest target column, favor moves that flip a face-down
/// card, and never pile back onto the target.
fn reveal_move_rank(b: &Board, target: Option<usize>, m: Move) -> i32 {
    let Move::Tableau { from, to, count } = m else { return -1 }; // deals bury; try last
    let (f, t, k) = (from as usize, to as usize, count as usize);
    let mut score = 0;
    if Some(f) == target {
        score += 3; // clearing cover off the easiest unknown
    }
    let fd = b.face_down[f] as usize;
    if fd > 0 && b.cols[f].len().checked_sub(k) == Some(fd) {
        score += 2; // this move flips a face-down card up
    }
    if Some(t) == target {
        score -= 4; // burying the target again — worst
    }
    score
}

/// Legal moves, ordered best-first for the reveal search (see `reveal_move_rank`).
fn gen_moves_toward_reveal(b: &Board, out: &mut Vec<Move>) {
    b.gen_moves(out);
    let target = easiest_unknown_column(b);
    // Stable sort keeps `gen_moves`' order among moves of equal rank.
    out.sort_by_key(|&m| Reverse(reveal_move_rank(b, target, m)));
}

/// One depth-first pass: find the first line (up to `depth_limit` moves, at most
/// `max_reversible` reversible moves in a row) that reveals a card. Same deal
/// handling as `search_reveals`, but DFS reaches reveals a breadth-first search
/// can't afford, and moves are ordered to dig toward the buried unknowns rather
/// than wander (see `gen_moves_toward_reveal`). Explores each board once
/// (`visited`), so it always terminates. Returns the plan (if any) and how many
/// nodes it spent, so the caller can run several passes against a shared budget.
fn search_reveals_deep(
    start_board: &Board,
    node_limit: u64,
    depth_limit: usize,
    max_reversible: u32,
) -> (Option<Vec<Move>>, u64) {
    let start = start_board.clone();

    let next_row_known = |b: &Board| -> bool {
        let n = b.stock.len();
        n >= COLS && b.stock[n - COLS..].iter().all(|&c| !is_unknown(c))
    };

    struct Frame {
        moves: Vec<Move>,
        idx: usize,
        undo: Option<Undo>,
        via: Option<Move>,
        run: u32, // consecutive reversible moves leading into this state
    }

    let mut b = start.clone();
    let mut visited: HashSet<u64> = HashSet::new();
    visited.insert(b.hash());
    let mut stack: Vec<Frame> = Vec::new();
    {
        let mut mv = Vec::new();
        gen_moves_toward_reveal(&b, &mut mv);
        stack.push(Frame { moves: mv, idx: 0, undo: None, via: None, run: 0 });
    }
    let mut nodes: u64 = 0;

    while let Some(top) = stack.last_mut() {
        if top.idx >= top.moves.len() {
            let f = stack.pop().unwrap();
            if let Some(u) = f.undo {
                b.undo(&u);
            }
            continue;
        }
        let run = top.run;
        let m = top.moves[top.idx];
        top.idx += 1;

        let terminal_deal = matches!(m, Move::Deal) && !next_row_known(&b);
        let before = progress_key(&b);
        let undo = b.make(m);
        let committal = is_committal(before, progress_key(&b));
        if !committal && run >= max_reversible {
            b.undo(&undo);
            continue;
        }
        nodes += 1;
        if nodes > node_limit {
            b.undo(&undo);
            break;
        }

        if b.exposed_unknowns() > 0 {
            let mut moves: Vec<Move> = stack.iter().filter_map(|f| f.via).collect();
            moves.push(m);
            return (Some(moves), nodes);
        }

        // Dive unless we've hit the depth cap, this deal is terminal (can't plan
        // past unseen cards), or we've been here before.
        if !terminal_deal && stack.len() < depth_limit && visited.insert(b.hash()) {
            let mut mv = Vec::new();
            gen_moves_toward_reveal(&b, &mut mv);
            let nc = if committal { 0 } else { run + 1 };
            stack.push(Frame { moves: mv, idx: 0, undo: Some(undo), via: Some(m), run: nc });
        } else {
            b.undo(&undo);
        }
    }

    (None, nodes)
}

/// Base cost of one move in the best-first reveal search, and the extra charged
/// for a move that splits a same-suit run. The penalty is *soft* — smaller than
/// a move — so the search avoids gratuitous suit-breaking but still breaks a run
/// when doing so reaches the reveal in fewer moves overall (the "shortening a
/// stack for a later purpose" case). Both are scaled up from 1 so the penalty
/// can be a fraction of a move without needing floats.
const REVEAL_MOVE_COST: u32 = 4;
const SUIT_BREAK_COST: u32 = 1;

/// Heuristic weight for the best-first reveal search (`g + w*h`). Matches the
/// main solver's default: `1` is near-optimal but explores more; `2` trades a
/// move or two for markedly fewer nodes and holds up on hard, deeply-buried
/// positions.
const REVEAL_ASTAR_WEIGHT: u32 = 2;

/// Distance-to-a-reveal estimate: the fewest cards covering any hidden unknown,
/// in move-cost units. A lower bound-ish guide (each covering card needs at
/// least one move to clear), used to steer the best-first search.
fn reveal_h(b: &Board) -> u32 {
    let min_cover = (0..COLS).filter_map(|c| cover_over_unknown(b, c)).min().unwrap_or(0);
    min_cover as u32 * REVEAL_MOVE_COST
}

/// Cost of `m` in the reveal search: a base per move, plus the suit-break penalty
/// when the move separates a same-suit run at its source.
fn reveal_move_cost(b: &Board, m: Move) -> u32 {
    let Move::Tableau { from, count, .. } = m else { return REVEAL_MOVE_COST + 2 }; // deals bury
    let (f, k) = (from as usize, count as usize);
    let col = &b.cols[f];
    let n = col.len();
    if n > k {
        let left = col[n - k - 1]; // card left on top of the source after the move
        let moved_bottom = col[n - k];
        if !is_unknown(left) && suit(left) == suit(moved_bottom) && rank(left) == rank(moved_bottom) + 1 {
            return REVEAL_MOVE_COST + SUIT_BREAK_COST; // splitting a same-suit run
        }
    }
    REVEAL_MOVE_COST
}

/// Best-first (weighted-A*) search for a *short* line that reveals an unknown.
/// Ordered by `g + weight*h`, where `g` is accumulated move cost (with the
/// suit-break penalty) and `h` is `reveal_h`. Unlike the depth-first `search_
/// reveals_deep`, it heads straight for the shallowest buried unknown and returns
/// a far shorter line, without a reversible-run cap (churn just costs `g`, so
/// it's naturally deprioritized). Same memory-lean node arena as `astar_short`.
fn search_reveals_astar(start: &Board, node_limit: u64, weight: u32) -> (Option<Vec<Move>>, u64) {
    let mut arena: Vec<Node> = vec![Node { parent: u32::MAX, mv: Move::Deal }];
    let mut closed: HashSet<u64> = HashSet::new();
    let mut open: BinaryHeap<(Reverse<u32>, u32, u32)> = BinaryHeap::new();

    closed.insert(start.hash());
    open.push((Reverse(weight * reveal_h(start)), 0, 0));
    let mut nodes: u64 = 0;

    while let Some((_pri, g, idx)) = open.pop() {
        let mut board = board_at(start, &arena, idx);
        let mut moves = Vec::new();
        board.gen_moves(&mut moves);
        for m in moves {
            nodes += 1;
            if nodes > node_limit {
                return (None, nodes);
            }
            let cost = reveal_move_cost(&board, m);
            let undo = board.make(m);
            if board.exposed_unknowns() > 0 {
                return (Some(reconstruct(&arena, idx, m)), nodes);
            }
            if closed.insert(board.hash()) {
                let ng = g + cost;
                let pri = ng + weight * reveal_h(&board);
                let ci = arena.len() as u32;
                arena.push(Node { parent: idx, mv: m });
                open.push((Reverse(pri), ng, ci));
            }
            board.undo(&undo);
        }
    }
    (None, nodes)
}

/// Strip wasted motion the depth-first deep search leaves in a reveal plan. Two
/// kinds, both verified by replay so correctness never rests on reasoning about
/// how the moves in between interact:
///
/// 1. **Contiguous collapse.** If a short run of moves ends at the same position
///    it started (a wasted cycle), it drops out; if a *single* legal move
///    reaches the run's end position, that move replaces the whole run. This
///    folds a suited run that was split through a temp column and rejoined
///    (`P→T`, `P→D`, `T→D`) back into one `P→D`. It only fires when the cards
///    really form a movable run — an off-suit pair has no single-move equivalent,
///    so `gen_moves` won't offer one and the split legitimately stays.
/// 2. **Inverse-pair cancel.** A card sent out and brought back later, with
///    unrelated work in between that the contiguous pass can't absorb: drop both
///    moves.
///
/// Each accepted rewrite strictly shortens the plan, so this reaches a fixpoint.
fn simplify_reveal_plan(start: &Board, mut plan: Vec<Move>) -> Vec<Move> {
    // How far apart the ends of a collapsible contiguous block may be.
    const WINDOW: usize = 6;
    'again: loop {
        // boards[t] = the position after the first t moves of the plan.
        let boards = prefix_boards(start, &plan);

        for i in 0..plan.len() {
            let end = plan.len().min(i + WINDOW);
            let mut from_i: Vec<Move> = Vec::new();
            let mut generated = false;
            for j in (i + 1)..end {
                let target = boards[j + 1].hash();
                let candidate = if target == boards[i].hash() {
                    // The block returns to where it began — a wasted cycle.
                    Some(splice(&plan, i, j, None))
                } else {
                    if !generated {
                        boards[i].gen_moves(&mut from_i);
                        generated = true;
                    }
                    // A single move that reaches the block's end position replaces it.
                    from_i.iter().copied().find_map(|m| {
                        let mut b = boards[i].clone();
                        b.make(m);
                        (b.hash() == target).then(|| splice(&plan, i, j, Some(m)))
                    })
                };
                if let Some(next) = candidate {
                    if plan_reveals(start, &next) {
                        plan = next;
                        continue 'again;
                    }
                }
            }
        }

        for i in 0..plan.len() {
            let Move::Tableau { from: fi, to: ti, count: ci } = plan[i] else { continue };
            for j in (i + 1)..plan.len() {
                let Move::Tableau { from: fj, to: tj, count: cj } = plan[j] else { continue };
                // An inverse move sends the same number of cards straight back.
                if !(fj == ti && tj == fi && cj == ci) {
                    continue;
                }
                let mut next = Vec::with_capacity(plan.len() - 2);
                next.extend_from_slice(&plan[..i]);
                next.extend_from_slice(&plan[i + 1..j]);
                next.extend_from_slice(&plan[j + 1..]);
                if plan_reveals(start, &next) {
                    plan = next;
                    continue 'again;
                }
            }
        }

        break;
    }
    plan
}

/// The position after each prefix of `moves`: `out[t]` is the board after the
/// first `t` moves (`out[0]` is `start`).
fn prefix_boards(start: &Board, moves: &[Move]) -> Vec<Board> {
    let mut boards = Vec::with_capacity(moves.len() + 1);
    let mut b = start.clone();
    boards.push(b.clone());
    for &m in moves {
        b.make(m);
        boards.push(b.clone());
    }
    boards
}

/// `plan` with moves `[i..=j]` replaced by `repl` (one move, or nothing).
fn splice(plan: &[Move], i: usize, j: usize, repl: Option<Move>) -> Vec<Move> {
    let mut out = Vec::with_capacity(plan.len());
    out.extend_from_slice(&plan[..i]);
    out.extend(repl);
    out.extend_from_slice(&plan[j + 1..]);
    out
}

/// Whether `moves` replays legally from `start` (every move comes from
/// `gen_moves`) and the final board turns up an unknown card. This is the sole
/// acceptance test for a simplification.
///
/// Note it deliberately does *not* re-impose the search's reversible-run cap:
/// that cap keeps the *search* from wandering, but simplification only ever
/// removes moves, so it can't introduce wandering — and collapsing a suited run
/// that was split through a temp column may legitimately leave a slightly longer
/// reversible run inside a strictly shorter plan, which is still an improvement.
fn plan_reveals(start: &Board, moves: &[Move]) -> bool {
    let mut b = start.clone();
    let mut legal = Vec::new();
    for &m in moves {
        legal.clear();
        b.gen_moves(&mut legal);
        if !legal.contains(&m) {
            return false;
        }
        b.make(m);
    }
    b.exposed_unknowns() > 0
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
    fn advise_deep_finds_a_reveal() {
        // The deep search must return a legal, reasonably-short plan that reveals
        // exactly what it promises. (The reversible-run cap is a property of the
        // raw search, checked separately — the simplifier that runs afterward may
        // legitimately merge runs while making the plan strictly shorter.)
        let board = frozen_known_stock_board();
        let advice = Solver::advise_deep(&board, 25_000_000, 200);

        assert!(!advice.moves.is_empty(), "deep search should find a reveal");
        assert!(advice.uncovers >= 1);
        assert!(advice.moves.len() <= 200, "deep plan too long: {}", advice.moves.len());
        assert!(plan_reveals(&board, &advice.moves));

        let mut end = board.clone();
        for &m in &advice.moves {
            end.make(m);
        }
        assert_eq!(end.exposed_unknowns(), advice.uncovers);
    }

    #[test]
    fn deep_search_respects_the_reversible_cap() {
        // The raw depth-first search (before simplification) must never run more
        // than its `max_reversible` reversible moves in a row.
        let board = frozen_known_stock_board();
        let (found, _) = search_reveals_deep(&board, 25_000_000, 200, MAX_CONSEC_REVERSIBLE);
        let moves = found.expect("deep search should find a reveal at the loosest cap");

        let mut end = board.clone();
        let mut run = 0u32;
        for &m in &moves {
            let before = progress_key(&end);
            end.make(m);
            if is_committal(before, progress_key(&end)) {
                run = 0;
            } else {
                run += 1;
                assert!(run <= MAX_CONSEC_REVERSIBLE, "search wandered: {run} in a row");
            }
        }
    }

    #[test]
    fn simplify_strips_a_no_op_round_trip() {
        // A card sent out and brought straight back, while the actual reveal
        // happens elsewhere, should be cut — leaving just the revealing move.
        let cols: Vec<(u8, Vec<Card>)> = vec![
            (1, cards("? 9h")),  // moving 9h off flips the hidden card -> reveal
            (0, cards("10s")),   // 9h lands here
            (0, cards("9c 8h")), // 8h can bounce to col 3 and come back onto 9c
            (0, cards("9s")),    // ...bouncing through here
            (0, cards("2s")),
            (0, cards("3s")),
            (0, cards("4s")),
            (0, cards("5s")),
            (0, cards("6s")),
            (0, cards("7s")),
        ];
        let board = Board::from_parts(&cols, &[]).expect("valid board");
        assert_eq!(board.exposed_unknowns(), 0);

        let bounce = vec![
            Move::Tableau { from: 2, to: 3, count: 1 }, // 8h out
            Move::Tableau { from: 3, to: 2, count: 1 }, // 8h back — pure no-op
            Move::Tableau { from: 0, to: 1, count: 1 }, // 9h off -> reveal
        ];
        // The bounce line is itself a legal, revealing plan...
        assert!(plan_reveals(&board, &bounce));
        // ...but the round trip is redundant, so only the reveal survives.
        assert_eq!(
            simplify_reveal_plan(&board, bounce),
            vec![Move::Tableau { from: 0, to: 1, count: 1 }],
        );
    }

    #[test]
    fn astar_reveal_finds_a_short_line() {
        // The best-first reveal search should return a short, legal, revealing
        // line — far shorter than the depth-first search's wandering. On this
        // frozen board it finds a single-digit-move reveal in a few thousand nodes.
        let board = frozen_known_stock_board();
        let (found, _) = search_reveals_astar(&board, 25_000_000, REVEAL_ASTAR_WEIGHT);
        let moves = found.expect("best-first search should find a reveal");
        assert!(moves.len() <= 20, "expected a short line, got {}", moves.len());
        assert!(plan_reveals(&board, &moves));
    }

    #[test]
    fn reveal_move_cost_penalizes_splitting_a_suited_run() {
        // Moving 8h off a 9h-8h run (col 0) splits a suit and costs extra; moving
        // 8h off an unrelated card (col 1) does not.
        let cols: Vec<(u8, Vec<Card>)> = vec![
            (0, cards("9h 8h")),  // 8h sits on same-suit 9h -> splitting it is penalized
            (0, cards("2s 8h")),  // 8h sits on unrelated 2s -> no penalty
            (0, cards("10s")), (0, cards("10c")),
            (0, cards("3s")), (0, cards("4s")), (0, cards("5s")),
            (0, cards("6s")), (0, cards("7s")), (0, cards("Jh")),
        ];
        let board = Board::from_parts(&cols, &[]).expect("valid");
        let split = Move::Tableau { from: 0, to: 2, count: 1 }; // 8h off the 9h-8h run
        let clean = Move::Tableau { from: 1, to: 3, count: 1 }; // 8h off an unrelated card
        assert_eq!(reveal_move_cost(&board, split), REVEAL_MOVE_COST + SUIT_BREAK_COST);
        assert_eq!(reveal_move_cost(&board, clean), REVEAL_MOVE_COST);
    }

    #[test]
    fn reveal_search_orders_digging_before_burying() {
        // With an unknown buried under 9h in col 0, the ordered move list must put
        // the move that clears col 0 (9h -> col 1) ahead of one that piles onto it
        // (8h -> col 0). This ordering is what steers the deep DFS to the needle.
        let cols: Vec<(u8, Vec<Card>)> = vec![
            (1, cards("? 9h")),  // col 0: unknown buried under 9h -> the dig target
            (0, cards("10s")),   // 9h can move here (clears col 0)
            (0, cards("8h")),    // 8h can move onto 9h (buries col 0 deeper)
            (0, cards("2s")), (0, cards("3s")), (0, cards("4s")),
            (0, cards("5s")), (0, cards("6s")), (0, cards("7s")), (0, cards("Ah")),
        ];
        let board = Board::from_parts(&cols, &[]).expect("valid");
        assert_eq!(easiest_unknown_column(&board), Some(0));

        let mut mv = Vec::new();
        gen_moves_toward_reveal(&board, &mut mv);
        let dig = mv.iter().position(|m| matches!(m, Move::Tableau { from: 0, to: 1, .. }));
        let bury = mv.iter().position(|m| matches!(m, Move::Tableau { from: 2, to: 0, .. }));
        assert!(
            dig < bury,
            "digging col 0 ({dig:?}) should be ordered before burying it ({bury:?})",
        );
    }

    #[test]
    #[ignore = "slow (~minute); regression for the deeply-buried-unknown false negative"]
    fn advise_deep_digs_out_a_deeply_buried_unknown() {
        // A real reported position (URL2): all stock dealt, the 3 unknowns pinned
        // at the bottom of a 13-card column. Unguided, the deep search burned its
        // 25M-node budget and returned "stuck" though a reveal exists; guided move
        // ordering must now find one within the default budget.
        let cols: Vec<(u8, Vec<Card>)> = vec![
            (3, cards("9c 7d Js As 5h Kd Qs 7h 6h Qh")),
            (4, cards("5c 2h 4h Kc Ac Kh Qh Jh Qc")),
            (4, cards("? ? ? Ks Ks 8s 7s 6c Qc Jd 10d 9c 8c")),
            (5, cards("3s Jc Ah Jh 8s Qs Jd Ac 10c 9h 8c 3d 2h Ah")),
            (1, cards("10c Jc")),
            (3, cards("9s As Kc 6s 8h 2s 9d 8d")),
            (3, cards("7s 10s 5h Kh Kd 3d 4h 3h 2c 6c 9h")),
            (3, cards("6s 10h 10d 10s 9d 8d Qd Js 10h 5d 4d 6d 3c 2d Ad")),
            (0, cards("3h")),
            (4, cards("2c 7c Qd 7h 7d 6d 5c 4c 3c 2d Ad 4c 5s 4s 4d 7c 6h 5d 4s 3s 2s")),
        ];
        let board = Board::from_parts(&cols, &[]).expect("valid");
        let advice = Solver::advise_deep(&board, 25_000_000, 200);
        assert!(advice.uncovers >= 1, "deep search should dig out a buried unknown");
        assert!(plan_reveals(&board, &advice.moves));
    }

    #[test]
    fn simplify_never_breaks_a_real_deep_plan() {
        // advise_deep already runs the simplifier; its output must stay a legal,
        // capped, revealing line, and simplifying again must be a fixpoint (no
        // cancelable pair left behind).
        let board = frozen_known_stock_board();
        let advice = Solver::advise_deep(&board, 25_000_000, 200);
        assert!(!advice.moves.is_empty());
        assert!(plan_reveals(&board, &advice.moves));
        assert_eq!(
            simplify_reveal_plan(&board, advice.moves.clone()),
            advice.moves,
            "simplify should be idempotent — nothing left to cut",
        );
    }

    #[test]
    fn simplify_collapses_a_run_split_through_a_temp_column() {
        // A suited pair (9h,8h) relocated to col 1 via a temp column in three
        // moves collapses to the single 2-card move that does the same thing.
        let cols: Vec<(u8, Vec<Card>)> = vec![
            (1, cards("? 9h 8h")), // moving the 9h-8h run off flips the hidden card
            (0, cards("10s")),     // the run lands here
            (0, cards("")),        // an empty temp column
            (0, cards("2s")),
            (0, cards("3s")),
            (0, cards("4s")),
            (0, cards("5s")),
            (0, cards("6s")),
            (0, cards("7s")),
            (0, cards("8s")),
        ];
        let board = Board::from_parts(&cols, &[]).expect("valid board");
        let split = vec![
            Move::Tableau { from: 0, to: 2, count: 1 }, // 8h -> temp
            Move::Tableau { from: 0, to: 1, count: 1 }, // 9h -> col1 (reveal)
            Move::Tableau { from: 2, to: 1, count: 1 }, // 8h -> col1, rejoining 9h
        ];
        assert!(plan_reveals(&board, &split));
        assert_eq!(
            simplify_reveal_plan(&board, split),
            vec![Move::Tableau { from: 0, to: 1, count: 2 }],
        );
    }

    #[test]
    fn simplify_cancels_an_interleaved_round_trip() {
        // 8h is parked on col 1 and brought back later, with two unrelated
        // reveals in between that the contiguous pass can't fold together. The
        // inverse-pair cancel must still strip the bounce, leaving the reveals.
        let cols: Vec<(u8, Vec<Card>)> = vec![
            (0, cards("8h")),   // bounces to col1 and back — pure waste
            (0, cards("9s")),   // ...parking on 9s
            (1, cards("? 7d")), // reveal A: 7d -> col3
            (0, cards("8c")),
            (1, cards("? 6s")), // reveal B: 6s -> col5
            (0, cards("7h")),
            (0, cards("2s")),
            (0, cards("3s")),
            (0, cards("4s")),
            (0, cards("5s")),
        ];
        let board = Board::from_parts(&cols, &[]).expect("valid board");
        let plan = vec![
            Move::Tableau { from: 0, to: 1, count: 1 }, // 8h out (waste)
            Move::Tableau { from: 2, to: 3, count: 1 }, // reveal A
            Move::Tableau { from: 4, to: 5, count: 1 }, // reveal B
            Move::Tableau { from: 1, to: 0, count: 1 }, // 8h back (waste)
        ];
        assert!(plan_reveals(&board, &plan));
        assert_eq!(
            simplify_reveal_plan(&board, plan),
            vec![
                Move::Tableau { from: 2, to: 3, count: 1 },
                Move::Tableau { from: 4, to: 5, count: 1 },
            ],
        );
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
