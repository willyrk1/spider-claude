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

use axum::{http::StatusCode, routing::get, routing::post, Json, Router};
use serde::{Deserialize, Serialize};

use spider_core::board::{Board, Move};
use spider_core::card::{make_card, rank, suit, Card};
use spider_core::solver::{self, Advice, Solver};

#[tokio::main]
async fn main() {
    let app = Router::new()
        .route("/health", get(|| async { "ok" }))
        .route("/solve", post(solve))
        .route("/advise", post(advise));

    let addr = "127.0.0.1:3000";
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .expect("bind address");
    println!("spider-api listening on http://{addr}");
    axum::serve(listener, app).await.expect("serve");
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

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum MoveDto {
    Tableau { from: u8, to: u8, count: u8 },
    Deal,
}

#[derive(Serialize)]
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
    let board = Board::deal(req.suits, req.seed);
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
