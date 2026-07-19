//! HTTP API front end for the Spider Solitaire solver.
//!
//! A thin, stateless wrapper over `spider_core`:
//!   GET  /health  -> "ok"
//!   POST /solve   -> deal a game and solve it
//!
//! Example:
//!   curl -s localhost:3000/solve \
//!     -H 'content-type: application/json' \
//!     -d '{"suits":4,"seed":0,"include_board":true}' | jq
//!
//! The solver is synchronous and CPU-heavy (it spawns its own worker threads),
//! so each request runs on a blocking task to keep the async runtime responsive.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::extract::{Path, State};
use axum::{http::StatusCode, routing::get, routing::post, Json, Router};
use serde::{Deserialize, Serialize};

use spider_core::board::{Board, Move};
use spider_core::card::{self, make_card, rank, suit, Card, UNKNOWN};
use spider_core::solver::{self, Advice, DeducedOutcome, SolveResult, Solver};

#[tokio::main]
async fn main() {
    let state = AppState {
        jobs: Arc::new(Mutex::new(HashMap::new())),
        next_id: Arc::new(AtomicU64::new(1)),
    };
    spawn_reaper(Arc::clone(&state.jobs));

    let app = Router::new()
        .route("/health", get(|| async { "ok" }))
        .route("/solve", post(solve))
        .route("/advise", post(advise))
        // The unified, staged plan search: one cancellable background job that
        // escalates quick reveal → deep reveal → deduce-and-solve (or straight to
        // a solve when the board is fully known). The UI polls it.
        .route("/plan/jobs", post(plan_job_start))
        .route("/plan/jobs/:id", get(solve_job_poll).delete(solve_job_cancel))
        .with_state(state);

    // Bind address defaults to localhost:3000; override with SPIDER_API_ADDR
    // (e.g. to run a second instance on another port without a conflict).
    let addr = std::env::var("SPIDER_API_ADDR").unwrap_or_else(|_| "127.0.0.1:3000".to_string());
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .expect("bind address");
    println!("spider-api listening on http://{addr}");
    axum::serve(listener, app).await.expect("serve");
}

// ---- Background solve jobs (poll + heartbeat) ----
//
// A full solve can run for minutes on a hard deal, and proving a deal
// *unsolvable* is effectively impossible (the reachable state space can't be
// enumerated), so we never wait for that. Instead the UI starts a job, polls it,
// and can cancel; each poll renews a lease, and a reaper cancels any job the UI
// stopped polling (a closed tab) so abandoned searches don't hog the CPU.

/// A search can't grow its closed set forever without OOMing the server, so even
/// "until cancelled" gets a generous hard ceiling per config (empirically safe
/// on commodity RAM; a hard deal reaches this in a handful of minutes).
const SOLVE_JOB_NODES: u64 = 300_000_000;
/// Most distinct arrangements of the deduced cards the deduce-and-solve stage
/// will try. Small: this is for the tail of a game (a couple of unreachable
/// cards), not mid-play ambiguity.
const MAX_DEDUCE_PERMS: usize = 4;
/// Cancel a job the UI hasn't polled within this long.
const JOB_LEASE: Duration = Duration::from_secs(15);
/// Keep a finished/cancelled job around this long so a final poll can read it.
const JOB_RETAIN: Duration = Duration::from_secs(60);

struct Job {
    stop: Arc<AtomicBool>,
    progress: Arc<AtomicU64>, // running node total, for the poller
    stage: Mutex<&'static str>, // which pipeline stage is running (for the poller)
    started: Instant,
    last_seen: Mutex<Instant>,       // renewed on each poll (the heartbeat)
    finished: Mutex<Option<Instant>>, // set when done or cancelled
    result: Mutex<Option<PlanResponse>>,
    cancelled: AtomicBool,
}

#[derive(Clone)]
struct AppState {
    jobs: Arc<Mutex<HashMap<u64, Arc<Job>>>>,
    next_id: Arc<AtomicU64>,
}

#[derive(Serialize)]
struct JobStarted {
    job_id: u64,
}

#[derive(Serialize)]
struct JobStatus {
    /// "running", "done", or "cancelled".
    status: &'static str,
    /// Which pipeline stage is (or was last) running: "quick", "deep", "deduce",
    /// or "solve". Lets the UI show what the search is doing right now.
    stage: &'static str,
    nodes: u64,
    elapsed_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<PlanResponse>,
}

/// Start the unified, staged *plan* job. One background worker escalates through
/// the searches automatically — quick reveal → deep reveal → deduce-and-solve
/// (partial boards), or straight to a solve (fully-known boards) — updating its
/// `stage` and node `progress` as it goes, and stoppable at any point via the
/// shared job machinery (poll/cancel/heartbeat/reaper).
async fn plan_job_start(
    State(state): State<AppState>,
    Json(req): Json<PlanRequest>,
) -> Result<Json<JobStarted>, (StatusCode, String)> {
    let board = board_from_plan(&req)?;
    // A fully-known board must be a legal deck before we spend a budget on it.
    if !board.has_unknowns() {
        board
            .check_deck_legal(req.suits)
            .map_err(|e| (StatusCode::BAD_REQUEST, e))?;
    }
    let suits = req.suits;

    let job = Arc::new(Job {
        stop: Arc::new(AtomicBool::new(false)),
        progress: Arc::new(AtomicU64::new(0)),
        stage: Mutex::new(""),
        started: Instant::now(),
        last_seen: Mutex::new(Instant::now()),
        finished: Mutex::new(None),
        result: Mutex::new(None),
        cancelled: AtomicBool::new(false),
    });
    let id = state.next_id.fetch_add(1, Ordering::Relaxed);
    state.jobs.lock().unwrap().insert(id, Arc::clone(&job));

    // The searches are blocking and spawn their own worker threads, so give the
    // pipeline its own OS thread rather than a runtime task.
    std::thread::spawn(move || {
        let resp = run_plan_pipeline(&board, suits, &job);
        *job.result.lock().unwrap() = Some(resp);
        *job.finished.lock().unwrap() = Some(Instant::now());
    });

    Ok(Json(JobStarted { job_id: id }))
}

/// The staged search pipeline (runs on the job's worker thread). Each stage sets
/// `job.stage` and resets `job.progress`, and checks `job.stop` between stages so
/// a cancel stops promptly and never advances to the next stage.
fn run_plan_pipeline(board: &Board, suits: u8, job: &Job) -> PlanResponse {
    let enter = |stage: &'static str| {
        *job.stage.lock().unwrap() = stage;
        job.progress.store(0, Ordering::Relaxed);
    };
    let cancelled = || job.stop.load(Ordering::Relaxed);

    // Fully known → just solve.
    if !board.has_unknowns() {
        enter("solve");
        let result = Solver::solve_portfolio_tracked(
            board,
            SOLVE_JOB_NODES,
            solver::DEFAULT_PORTFOLIO,
            &job.stop,
            &job.progress,
        );
        return solve_response(board, result);
    }

    // Partial board — hunt for a reveal, quickest first.
    enter("quick");
    let quick = Solver::advise(board, default_advise_nodes());
    if !quick.moves.is_empty() {
        return discover_response(quick, false);
    }
    if cancelled() {
        return stuck_response();
    }

    enter("deep");
    let deep = Solver::advise_deep_tracked(
        board,
        default_deep_nodes(),
        default_deep_depth(),
        &job.stop,
        &job.progress,
    );
    if !deep.moves.is_empty() {
        return discover_response(deep, true);
    }
    if cancelled() {
        return stuck_response();
    }

    // No reveal exists. If the remaining unknowns are pinned down by the deck,
    // fill them in every possible way and solve — turning "stuck" into a real
    // answer (a winning line, or a definitive "no win").
    enter("deduce");
    match Solver::solve_deduced(
        board,
        suits,
        SOLVE_JOB_NODES,
        &job.stop,
        &job.progress,
        MAX_DEDUCE_PERMS,
    ) {
        DeducedOutcome::Solved { moves, fills } => deduced_solve_response(board, suits, moves, fills),
        DeducedOutcome::NoWin { tried, converged } => deduced_nowin_response(board, suits, tried, converged),
        // Cancelled, or too ambiguous to deduce — report the reveal dead end.
        DeducedOutcome::NotDeducible => stuck_response(),
    }
}

/// A partial board where the reveal search found nothing and we couldn't deduce.
fn stuck_response() -> PlanResponse {
    PlanResponse {
        phase: "stuck".to_string(),
        note: "No search could reveal a hidden card, and the remaining unknowns aren't pinned down enough to deduce. Use ↶ Undo to back up and try a different line.".to_string(),
        moves: Vec::new(),
        uncovers: Some(0),
        verified: None,
        winning_config: None,
        nodes_searched: None,
        deep: Some(true),
        fill: None,
    }
}

/// A reveal plan (`quick` = the fast search, else the deep one) → the discover
/// `PlanResponse` the UI renders.
fn discover_response(advice: Advice, deep: bool) -> PlanResponse {
    let deals = advice.moves.iter().filter(|m| matches!(m, Move::Deal)).count();
    let note = if deep {
        format!(
            "Deep search: a {}-move line ({}) reveals {} unknown card(s) — but it's a long, committal maneuver. Review it before playing it out.",
            advice.moves.len(),
            if deals == 1 { "1 deal".to_string() } else { format!("{deals} deals") },
            advice.uncovers
        )
    } else if advice.moves.len() == 1 && deals == 1 {
        "No move uncovers an unknown card — deal a row from the stock, then fill in any newly dealt cards.".to_string()
    } else if deals > 0 {
        format!(
            "Play {} step(s) — including {} — to reveal {} unknown card(s), then fill them in.",
            advice.moves.len(),
            if deals == 1 { "a deal".to_string() } else { format!("{deals} deals") },
            advice.uncovers
        )
    } else {
        format!(
            "Play {} move(s) to reveal {} unknown card(s), then fill them in and continue.",
            advice.moves.len(),
            advice.uncovers
        )
    };
    PlanResponse {
        phase: "discover".to_string(),
        note,
        moves: advice.moves.iter().map(move_dto).collect(),
        uncovers: Some(advice.uncovers),
        verified: None,
        winning_config: None,
        nodes_searched: None,
        deep: if deep { Some(true) } else { None },
        fill: None,
    }
}

/// Comma-list the deduced cards (e.g. "9♣ and K♦") for the notes below.
fn deduced_card_list(board: &Board, suits: u8) -> String {
    let names: Vec<String> = board.missing_cards(suits).iter().map(|&c| card::name(c)).collect();
    match names.len() {
        0 => String::new(),
        1 => names[0].clone(),
        2 => format!("{} and {}", names[0], names[1]),
        _ => {
            let (last, rest) = names.split_last().unwrap();
            format!("{}, and {}", rest.join(", "), last)
        }
    }
}

/// A deduce-and-solve win: the deck forced the hidden cards, and one arrangement
/// wins. Return the winning line plus the `fill` the UI applies to lock in those
/// cards (so the line replays on a now-complete board).
fn deduced_solve_response(board: &Board, suits: u8, moves: Vec<Move>, fills: Vec<(usize, usize, Card)>) -> PlanResponse {
    // Verify by replaying on the filled board.
    let mut check = board.clone();
    for &(c, i, card) in &fills {
        check.cols[c][i] = card;
    }
    for &m in &moves {
        check.make(m);
    }
    let fill: Vec<FillDto> = fills
        .iter()
        .map(|&(col, index, card)| FillDto { col, index, rank: rank(card), suit: suit(card) })
        .collect();
    // When two or more *distinct* cards fill the unknown cells, only their
    // multiset is deduced — which card sits where is a guess (we return the first
    // arrangement that happens to win). Say so, so a wrong guess isn't a surprise.
    let distinct: std::collections::HashSet<(u8, u8)> =
        fills.iter().map(|&(_, _, c)| (rank(c), suit(c))).collect();
    let ambiguous = fills.len() >= 2 && distinct.len() >= 2;
    let mut note = format!(
        "The last hidden card(s) can only be {}. Filled in, this deal is winnable in {} moves.",
        deduced_card_list(board, suits),
        moves.len()
    );
    if ambiguous {
        note.push_str(" Their order here is a guess — if the cards come up the other way when you finally uncover them, swap them and solve again.");
    }
    PlanResponse {
        phase: "solve".to_string(),
        note,
        moves: moves.iter().map(move_dto).collect(),
        uncovers: None,
        verified: Some(check.is_won()),
        winning_config: None,
        nodes_searched: None,
        deep: None,
        fill: Some(fill),
    }
}

/// Deduce-and-solve exhausted every arrangement without a win.
fn deduced_nowin_response(board: &Board, suits: u8, tried: usize, converged: bool) -> PlanResponse {
    let cards = deduced_card_list(board, suits);
    let note = if converged {
        format!("The last hidden card(s) can only be {cards}, but no arrangement of them can be won — this position is lost.")
    } else {
        format!("The last hidden card(s) can only be {cards}; no win was found for any of the {tried} arrangement(s) within the search budget.")
    };
    PlanResponse {
        phase: "stuck".to_string(),
        note,
        moves: Vec::new(),
        uncovers: Some(0),
        verified: None,
        winning_config: None,
        nodes_searched: None,
        deep: Some(true),
        fill: None,
    }
}

async fn solve_job_poll(
    State(state): State<AppState>,
    Path(id): Path<u64>,
) -> Result<Json<JobStatus>, StatusCode> {
    let job = state.jobs.lock().unwrap().get(&id).cloned();
    let Some(job) = job else { return Err(StatusCode::NOT_FOUND) };
    *job.last_seen.lock().unwrap() = Instant::now(); // heartbeat

    let nodes = job.progress.load(Ordering::Relaxed);
    let elapsed_ms = job.started.elapsed().as_millis() as u64;
    let stage = *job.stage.lock().unwrap();
    let (status, result) = if job.cancelled.load(Ordering::Relaxed) {
        ("cancelled", None)
    } else if let Some(r) = job.result.lock().unwrap().clone() {
        ("done", Some(r))
    } else {
        ("running", None)
    };
    Ok(Json(JobStatus { status, stage, nodes, elapsed_ms, result }))
}

async fn solve_job_cancel(State(state): State<AppState>, Path(id): Path<u64>) -> StatusCode {
    match state.jobs.lock().unwrap().get(&id).cloned() {
        Some(job) => {
            job.cancelled.store(true, Ordering::Relaxed);
            job.stop.store(true, Ordering::Relaxed);
            let mut fin = job.finished.lock().unwrap();
            if fin.is_none() {
                *fin = Some(Instant::now());
            }
            StatusCode::OK
        }
        None => StatusCode::NOT_FOUND,
    }
}

/// Periodically cancel jobs whose UI stopped polling, and drop long-finished
/// ones so the map doesn't grow without bound.
fn spawn_reaper(jobs: Arc<Mutex<HashMap<u64, Arc<Job>>>>) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(3));
        let now = Instant::now();
        let mut map = jobs.lock().unwrap();
        for job in map.values() {
            let running =
                job.result.lock().unwrap().is_none() && !job.cancelled.load(Ordering::Relaxed);
            if running && now.duration_since(*job.last_seen.lock().unwrap()) > JOB_LEASE {
                job.cancelled.store(true, Ordering::Relaxed);
                job.stop.store(true, Ordering::Relaxed);
                *job.finished.lock().unwrap() = Some(now);
            }
        }
        map.retain(|_, job| match *job.finished.lock().unwrap() {
            Some(t) => now.duration_since(t) < JOB_RETAIN,
            None => true,
        });
    });
}

/// Build a fully-specified board from a plan request (columns + undealt stock).
fn board_from_plan(req: &PlanRequest) -> Result<Board, (StatusCode, String)> {
    if !matches!(req.suits, 1 | 2 | 4) {
        return Err((StatusCode::BAD_REQUEST, "suits must be 1, 2, or 4".into()));
    }
    if req.columns.len() != 10 {
        return Err((
            StatusCode::BAD_REQUEST,
            format!("expected 10 columns, got {}", req.columns.len()),
        ));
    }
    let mut columns: Vec<(u8, Vec<Card>)> = Vec::with_capacity(10);
    for (i, col) in req.columns.iter().enumerate() {
        let mut cards = Vec::with_capacity(col.cards.len());
        for c in &col.cards {
            cards.push(to_card(c, req.suits).map_err(|e| (StatusCode::BAD_REQUEST, format!("column {i}: {e}")))?);
        }
        columns.push((col.face_down, cards));
    }
    let mut stock = Vec::with_capacity(req.stock.len());
    for c in &req.stock {
        stock.push(to_card(c, req.suits).map_err(|e| (StatusCode::BAD_REQUEST, format!("stock: {e}")))?);
    }
    let mut board = Board::from_parts(&columns, &stock).map_err(|e| (StatusCode::BAD_REQUEST, e))?;
    board.allow_deal_with_empty = req.allow_deal_with_empty;
    Ok(board)
}

/// Turn a completed solve into the same `PlanResponse` shape the `/plan` solve
/// path returns, so the UI renders a job result exactly like a synchronous one.
fn solve_response(board: &Board, result: SolveResult) -> PlanResponse {
    match result.moves {
        Some(moves) => {
            let mut check = board.clone();
            for &m in &moves {
                check.make(m);
            }
            PlanResponse {
                phase: "solve".to_string(),
                note: format!("Everything is known — here is a {}-move winning line.", moves.len()),
                moves: moves.iter().map(move_dto).collect(),
                uncovers: None,
                verified: Some(check.is_won()),
                winning_config: result.winning_config.map(|(weight, fdw)| ConfigDto { weight, fdw }),
                nodes_searched: Some(result.nodes),
                deep: None,
                fill: None,
            }
        }
        None => PlanResponse {
            phase: "stuck".to_string(),
            note: format!(
                "No winning line found after {} nodes — this position may be extremely hard, or a filled-in card may be wrong. Try ↶ Undo, or run the search again.",
                result.nodes
            ),
            moves: Vec::new(),
            uncovers: None,
            verified: None,
            winning_config: None,
            nodes_searched: Some(result.nodes),
            deep: None,
            fill: None,
        },
    }
}

/// Request body for `POST /solve`. A deal is identified by `suits` + `seed`
/// (reproducible), matching the CLI. Omitting `weight`/`fdw` runs the default
/// parallel portfolio; setting either forces that single configuration.
#[derive(Deserialize)]
struct SolveRequest {
    suits: u8,
    seed: u64,
    #[serde(default = "default_nodes")]
    nodes: u64,
    weight: Option<u32>,
    fdw: Option<u32>,
    /// Include the dealt board in the response (so a UI can render it).
    #[serde(default)]
    include_board: bool,
    /// Rule variant: allow dealing a new row while columns are empty (default
    /// false — the standard rule forbids it).
    #[serde(default)]
    allow_deal_with_empty: bool,
}

fn default_nodes() -> u64 {
    20_000_000
}

#[derive(Serialize)]
struct CardDto {
    rank: u8,
    suit: u8,
    face_up: bool,
}

#[derive(Serialize)]
struct BoardDto {
    columns: Vec<Vec<CardDto>>,
    /// The undealt stock, in Vec order (a `deal` pops from the end), so a client
    /// can replay `deal` moves exactly. `face_up` is meaningless here (always
    /// false); the cards become face-up when dealt.
    stock: Vec<CardDto>,
    stock_count: usize,
}

#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "lowercase")]
enum MoveDto {
    Tableau { from: u8, to: u8, count: u8 },
    Deal,
}

#[derive(Serialize, Clone)]
struct ConfigDto {
    weight: u32,
    fdw: u32,
}

#[derive(Serialize)]
struct SolveResponse {
    suits: u8,
    seed: u64,
    solved: bool,
    /// Solution replayed on a fresh deal and confirmed to win.
    verified: bool,
    /// `"converged"`, `"budget"`, `"fallback"`, or `"unsolved"`.
    quality: String,
    move_count: usize,
    /// Which `(weight, fdw)` config produced the answer (portfolio mode only).
    winning_config: Option<ConfigDto>,
    nodes_searched: u64,
    moves: Vec<MoveDto>,
    #[serde(skip_serializing_if = "Option::is_none")]
    initial_board: Option<BoardDto>,
}

async fn solve(
    Json(req): Json<SolveRequest>,
) -> Result<Json<SolveResponse>, (StatusCode, String)> {
    if !matches!(req.suits, 1 | 2 | 4) {
        return Err((StatusCode::BAD_REQUEST, "suits must be 1, 2, or 4".into()));
    }
    // Run the blocking, CPU-heavy solve off the async runtime.
    let resp = tokio::task::spawn_blocking(move || run_solve(req))
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(resp))
}

fn run_solve(req: SolveRequest) -> SolveResponse {
    let mut board = Board::deal(req.suits, req.seed);
    board.allow_deal_with_empty = req.allow_deal_with_empty;
    let initial_board = if req.include_board {
        Some(board_dto(&board))
    } else {
        None
    };

    let result = if req.weight.is_some() || req.fdw.is_some() {
        let w = req.weight.unwrap_or(solver::DEFAULT_WEIGHT);
        let fdw = req.fdw.unwrap_or(solver::DEFAULT_FD_WEIGHT);
        Solver::solve(&board, req.nodes, w, fdw)
    } else {
        Solver::solve_portfolio(&board, req.nodes, solver::DEFAULT_PORTFOLIO)
    };

    let (solved, verified, moves, move_count) = match &result.moves {
        Some(moves) => {
            // Self-verify: replay on a fresh deal and confirm the win.
            let mut check = Board::deal(req.suits, req.seed);
            for &m in moves {
                check.make(m);
            }
            let dto: Vec<MoveDto> = moves.iter().map(move_dto).collect();
            (true, check.is_won(), dto, moves.len())
        }
        None => (false, false, Vec::new(), 0),
    };

    let quality = if !solved {
        "unsolved"
    } else if result.from_fallback {
        "fallback"
    } else if result.converged {
        "converged"
    } else {
        "budget"
    }
    .to_string();

    SolveResponse {
        suits: req.suits,
        seed: req.seed,
        solved,
        verified,
        quality,
        move_count,
        winning_config: result
            .winning_config
            .map(|(weight, fdw)| ConfigDto { weight, fdw }),
        nodes_searched: result.nodes,
        moves,
        initial_board,
    }
}

fn board_dto(b: &Board) -> BoardDto {
    let columns = b
        .cols
        .iter()
        .enumerate()
        .map(|(c, col)| {
            let fd = b.face_down[c] as usize;
            col.iter()
                .enumerate()
                .map(|(i, &card)| CardDto {
                    rank: rank(card),
                    suit: suit(card),
                    face_up: i >= fd,
                })
                .collect()
        })
        .collect();
    let stock = b
        .stock
        .iter()
        .map(|&card| CardDto {
            rank: rank(card),
            suit: suit(card),
            face_up: false,
        })
        .collect();
    BoardDto {
        columns,
        stock,
        stock_count: b.stock.len(),
    }
}

fn move_dto(m: &Move) -> MoveDto {
    match *m {
        Move::Tableau { from, to, count } => MoveDto::Tableau { from, to, count },
        Move::Deal => MoveDto::Deal,
    }
}

// ---- Advisor (partial-information "play along" mode) ----

#[derive(Deserialize)]
struct CardInput {
    rank: u8,
    suit: u8,
}

#[derive(Deserialize)]
struct ColumnInput {
    #[serde(default)]
    face_down: u8,
    /// Face-up cards, bottom → top.
    #[serde(default)]
    up: Vec<CardInput>,
}

/// A board as a player sees it: face-up cards plus face-down counts. Hidden
/// cards and the stock are unknown, so the response is advice, not a solution.
#[derive(Deserialize)]
struct AdviseRequest {
    suits: u8,
    columns: Vec<ColumnInput>,
    #[serde(default = "default_advise_nodes")]
    nodes: u64,
}

fn default_advise_nodes() -> u64 {
    2_000_000
}

#[derive(Serialize)]
struct AdviseResponse {
    moves: Vec<MoveDto>,
    /// Face-down cards the plan exposes (turn these up and re-submit).
    uncovers: u32,
    completes: u32,
    empties: u32,
    note: String,
}

async fn advise(
    Json(req): Json<AdviseRequest>,
) -> Result<Json<AdviseResponse>, (StatusCode, String)> {
    if !matches!(req.suits, 1 | 2 | 4) {
        return Err((StatusCode::BAD_REQUEST, "suits must be 1, 2, or 4".into()));
    }
    if req.columns.len() != 10 {
        return Err((
            StatusCode::BAD_REQUEST,
            format!("expected 10 columns, got {}", req.columns.len()),
        ));
    }

    // Validate and convert the visible cards.
    let mut columns: Vec<(u8, Vec<Card>)> = Vec::with_capacity(10);
    for (i, col) in req.columns.iter().enumerate() {
        let mut up = Vec::with_capacity(col.up.len());
        for c in &col.up {
            if !(1..=13).contains(&c.rank) || c.suit >= req.suits {
                return Err((
                    StatusCode::BAD_REQUEST,
                    format!(
                        "column {i}: rank {} suit {} is invalid for {}-suit",
                        c.rank, c.suit, req.suits
                    ),
                ));
            }
            up.push(make_card(c.rank, c.suit));
        }
        columns.push((col.face_down, up));
    }

    let board = Board::from_visible(&columns).map_err(|e| (StatusCode::BAD_REQUEST, e))?;
    let advice: Advice = tokio::task::spawn_blocking(move || Solver::advise(&board, req.nodes))
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let note = if advice.moves.is_empty() {
        "No productive move over the visible cards — deal a new row (if the stock has cards) or reveal more.".to_string()
    } else {
        format!(
            "Play {} move(s): uncovers {}, completes {}, empties {}.",
            advice.moves.len(),
            advice.uncovers,
            advice.completes,
            advice.empties
        )
    };

    Ok(Json(AdviseResponse {
        moves: advice.moves.iter().map(move_dto).collect(),
        uncovers: advice.uncovers,
        completes: advice.completes,
        empties: advice.empties,
        note,
    }))
}

// ---- Track & solve (deck-based, discover-or-solve) ----

#[derive(Deserialize)]
struct PlanColumn {
    #[serde(default)]
    face_down: u8,
    /// Full column bottom→top; each entry is a card or `null` (unknown).
    #[serde(default)]
    cards: Vec<Option<CardInput>>,
}

/// The current position, with `null` for any card still unknown (face-down
/// cards and undealt stock). When nothing is null, it's solved outright.
#[derive(Deserialize)]
struct PlanRequest {
    suits: u8,
    columns: Vec<PlanColumn>,
    #[serde(default)]
    stock: Vec<Option<CardInput>>,
    /// Rule variant: allow dealing a new row while columns are empty (default
    /// false — the standard rule forbids it).
    #[serde(default)]
    allow_deal_with_empty: bool,
}

fn default_deep_nodes() -> u64 {
    // Budget for the opt-in deep reveal search. Calibrated against a real stuck
    // position whose only reveal was a 14-move, two-deal maneuver: the search
    // reaches it at just under 30M nodes, so the old 25M cap missed it by a hair.
    // 60M is ~2x that threshold, giving headroom for similar deep, deal-dependent
    // reveals. Because the search returns the instant it finds a reveal, a higher
    // cap costs nothing on positions that have one — it only lengthens the worst
    // case on genuinely dead-end boards (~0.6M nodes/sec ⇒ ~90-100s), which is
    // acceptable for a button the UI already labels "(slow)".
    60_000_000
}

fn default_deep_depth() -> usize {
    200
}

#[derive(Serialize, Clone)]
struct PlanResponse {
    /// "discover" (uncover more cards), "solve" (full solution), or "stuck".
    phase: String,
    moves: Vec<MoveDto>,
    note: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    uncovers: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    verified: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    winning_config: Option<ConfigDto>,
    #[serde(skip_serializing_if = "Option::is_none")]
    nodes_searched: Option<u64>,
    /// True when this plan came from a deep search — the client should warn (and
    /// confirm) before using it, since it may be very long.
    #[serde(skip_serializing_if = "Option::is_none")]
    deep: Option<bool>,
    /// For a deduce-and-solve result: the hidden cards the deck forced, as
    /// `(col, index)` positions on the current board. The client fills these in
    /// (completing the deck) so the winning `moves` replay correctly.
    #[serde(skip_serializing_if = "Option::is_none")]
    fill: Option<Vec<FillDto>>,
}

/// One deduced hidden card and where it sits on the current board.
#[derive(Serialize, Clone)]
struct FillDto {
    col: usize,
    index: usize,
    rank: u8,
    suit: u8,
}

fn to_card(c: &Option<CardInput>, suits: u8) -> Result<Card, String> {
    match c {
        None => Ok(UNKNOWN),
        Some(ci) => {
            if !(1..=13).contains(&ci.rank) || ci.suit >= suits {
                return Err(format!(
                    "rank {} suit {} is invalid for {}-suit",
                    ci.rank, ci.suit, suits
                ));
            }
            Ok(make_card(ci.rank, ci.suit))
        }
    }
}
