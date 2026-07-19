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
use spider_core::card::{make_card, rank, suit, Card, UNKNOWN};
use spider_core::solver::{self, Advice, SolveResult, Solver};

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
        .route("/plan", post(plan))
        // Long, cancellable solve as a background job the UI polls.
        .route("/solve/jobs", post(solve_job_start))
        .route("/solve/jobs/:id", get(solve_job_poll).delete(solve_job_cancel))
        // The deep reveal search is just as long and cancellable, so it runs as
        // the same kind of job; poll/cancel are shared with the solve jobs.
        .route("/reveal/jobs", post(reveal_job_start))
        .route("/reveal/jobs/:id", get(solve_job_poll).delete(solve_job_cancel))
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
/// Cancel a job the UI hasn't polled within this long.
const JOB_LEASE: Duration = Duration::from_secs(15);
/// Keep a finished/cancelled job around this long so a final poll can read it.
const JOB_RETAIN: Duration = Duration::from_secs(60);

struct Job {
    stop: Arc<AtomicBool>,
    progress: Arc<AtomicU64>, // running node total, for the poller
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
    nodes: u64,
    elapsed_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<PlanResponse>,
}

async fn solve_job_start(
    State(state): State<AppState>,
    Json(req): Json<PlanRequest>,
) -> Result<Json<JobStarted>, (StatusCode, String)> {
    let board = board_from_plan(&req)?;
    if board.has_unknowns() {
        return Err((
            StatusCode::BAD_REQUEST,
            "board still has unknown cards — fill them in before solving".into(),
        ));
    }
    board
        .check_deck_legal(req.suits)
        .map_err(|e| (StatusCode::BAD_REQUEST, e))?;

    let job = Arc::new(Job {
        stop: Arc::new(AtomicBool::new(false)),
        progress: Arc::new(AtomicU64::new(0)),
        started: Instant::now(),
        last_seen: Mutex::new(Instant::now()),
        finished: Mutex::new(None),
        result: Mutex::new(None),
        cancelled: AtomicBool::new(false),
    });
    let id = state.next_id.fetch_add(1, Ordering::Relaxed);
    state.jobs.lock().unwrap().insert(id, Arc::clone(&job));

    // The solve is blocking and spawns its own worker threads, so give it its
    // own OS thread rather than a runtime task.
    std::thread::spawn(move || {
        let result = Solver::solve_portfolio_tracked(
            &board,
            SOLVE_JOB_NODES,
            solver::DEFAULT_PORTFOLIO,
            &job.stop,
            &job.progress,
        );
        *job.result.lock().unwrap() = Some(solve_response(&board, result));
        *job.finished.lock().unwrap() = Some(Instant::now());
    });

    Ok(Json(JobStarted { job_id: id }))
}

/// Start a background deep *reveal* search on a partially-known board. Same job
/// machinery (poll/cancel/heartbeat/reaper) as a solve — the deep search can run
/// as long, and is now cancellable and progress-reporting via `advise_deep_tracked`.
async fn reveal_job_start(
    State(state): State<AppState>,
    Json(req): Json<PlanRequest>,
) -> Result<Json<JobStarted>, (StatusCode, String)> {
    let board = board_from_plan(&req)?;
    if !board.has_unknowns() {
        return Err((
            StatusCode::BAD_REQUEST,
            "board is fully known — there is nothing to reveal".into(),
        ));
    }

    let job = Arc::new(Job {
        stop: Arc::new(AtomicBool::new(false)),
        progress: Arc::new(AtomicU64::new(0)),
        started: Instant::now(),
        last_seen: Mutex::new(Instant::now()),
        finished: Mutex::new(None),
        result: Mutex::new(None),
        cancelled: AtomicBool::new(false),
    });
    let id = state.next_id.fetch_add(1, Ordering::Relaxed);
    state.jobs.lock().unwrap().insert(id, Arc::clone(&job));

    std::thread::spawn(move || {
        let advice = Solver::advise_deep_tracked(
            &board,
            default_deep_nodes(),
            default_deep_depth(),
            &job.stop,
            &job.progress,
        );
        *job.result.lock().unwrap() = Some(reveal_response(advice));
        *job.finished.lock().unwrap() = Some(Instant::now());
    });

    Ok(Json(JobStarted { job_id: id }))
}

/// Turn a deep-reveal `Advice` into the `PlanResponse` the UI already renders for
/// the `deep` discovery path (mirrors the note the synchronous path used).
fn reveal_response(advice: Advice) -> PlanResponse {
    let deals = advice.moves.iter().filter(|m| matches!(m, Move::Deal)).count();
    if advice.moves.is_empty() {
        return PlanResponse {
            phase: "stuck".to_string(),
            note: "Even a deep search found no way to reveal a card within its budget — this line is very likely a dead end. Use ↶ Undo to back up and try a different one.".to_string(),
            moves: Vec::new(),
            uncovers: Some(0),
            verified: None,
            winning_config: None,
            nodes_searched: None,
            deep: Some(true),
        };
    }
    PlanResponse {
        phase: "discover".to_string(),
        note: format!(
            "Deep search: a {}-move line ({}) reveals {} unknown card(s) — but it's a long, committal maneuver. Review it before playing it out.",
            advice.moves.len(),
            if deals == 1 { "1 deal".to_string() } else { format!("{deals} deals") },
            advice.uncovers
        ),
        moves: advice.moves.iter().map(move_dto).collect(),
        uncovers: Some(advice.uncovers),
        verified: None,
        winning_config: None,
        nodes_searched: None,
        deep: Some(true),
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
    let (status, result) = if job.cancelled.load(Ordering::Relaxed) {
        ("cancelled", None)
    } else if let Some(r) = job.result.lock().unwrap().clone() {
        ("done", Some(r))
    } else {
        ("running", None)
    };
    Ok(Json(JobStatus { status, nodes, elapsed_ms, result }))
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
    #[serde(default = "default_advise_nodes")]
    advise_nodes: u64,
    #[serde(default = "default_nodes")]
    solve_nodes: u64,
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
    /// True when this plan came from the opt-in deep search — the client should
    /// warn (and confirm) before using it, since it may be very long.
    #[serde(skip_serializing_if = "Option::is_none")]
    deep: Option<bool>,
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

async fn plan(Json(req): Json<PlanRequest>) -> Result<Json<PlanResponse>, (StatusCode, String)> {
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

    if board.has_unknowns() {
        // Discovery: the fast, shortest-reveal search only. If it comes up empty,
        // the UI offers "Search deeper", which runs as a cancellable, pollable
        // background job (POST /reveal/jobs) rather than blocking this request.
        let b = board.clone();
        let advice: Advice = tokio::task::spawn_blocking(move || Solver::advise(&b, req.advise_nodes))
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
        let deals = advice.moves.iter().filter(|m| matches!(m, Move::Deal)).count();
        let (phase, note) = if advice.moves.is_empty() {
            (
                "stuck",
                "Nothing new can be revealed by the normal search — no short sequence reaches an unknown card. Use ↶ Undo to back up, or try a deeper search.".to_string(),
            )
        } else if advice.moves.len() == 1 && deals == 1 {
            (
                "discover",
                "No move uncovers an unknown card — deal a row from the stock, then fill in any newly dealt cards.".to_string(),
            )
        } else if deals > 0 {
            (
                "discover",
                format!(
                    "Play {} step(s) — including {} — to reveal {} unknown card(s), then fill them in.",
                    advice.moves.len(),
                    if deals == 1 { "a deal".to_string() } else { format!("{deals} deals") },
                    advice.uncovers
                ),
            )
        } else {
            (
                "discover",
                format!(
                    "Play {} move(s) to reveal {} unknown card(s), then fill them in and continue.",
                    advice.moves.len(),
                    advice.uncovers
                ),
            )
        };
        return Ok(Json(PlanResponse {
            phase: phase.to_string(),
            moves: advice.moves.iter().map(move_dto).collect(),
            note,
            uncovers: Some(advice.uncovers),
            verified: None,
            winning_config: None,
            nodes_searched: None,
            deep: None,
        }));
    }

    // Fully known → solve the rest. First reject an illegal deck (e.g. a mistyped
    // card leaving 7 kings) so we return a clear reason instead of burning the
    // whole node budget searching for a win that can't exist.
    board
        .check_deck_legal(req.suits)
        .map_err(|e| (StatusCode::BAD_REQUEST, e))?;
    let solve_board = board.clone();
    let result = tokio::task::spawn_blocking(move || {
        Solver::solve_portfolio(&solve_board, req.solve_nodes, solver::DEFAULT_PORTFOLIO)
    })
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    match result.moves {
        Some(moves) => {
            let mut check = board.clone();
            for &m in &moves {
                check.make(m);
            }
            Ok(Json(PlanResponse {
                phase: "solve".to_string(),
                note: format!("Everything is known — here is a {}-move winning line.", moves.len()),
                moves: moves.iter().map(move_dto).collect(),
                uncovers: None,
                verified: Some(check.is_won()),
                winning_config: result.winning_config.map(|(weight, fdw)| ConfigDto { weight, fdw }),
                nodes_searched: Some(result.nodes),
                deep: None,
            }))
        }
        None => Ok(Json(PlanResponse {
            phase: "stuck".to_string(),
            note: "The position is fully known, but no winning line was found in the budget — a filled-in card may be wrong, or the line you played may be a dead end. Try ↶ Undo, or raise the budget.".to_string(),
            moves: Vec::new(),
            uncovers: None,
            verified: None,
            winning_config: None,
            nodes_searched: Some(result.nodes),
            deep: None,
        })),
    }
}
