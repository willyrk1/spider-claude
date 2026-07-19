import { useEffect, useMemo, useState } from 'react';
import { Board, Foundations } from './Board';
import PreFill from './PreFill';
import {
  cancelPlanJob,
  pollPlanJob,
  startPlanJob,
  type FillCard,
  type PlanResponse,
  type PlanStage,
} from './api';

/** What the search is doing right now, for the progress panel. */
const STAGE_LABEL: Record<PlanStage, string> = {
  '': 'Starting the search…',
  quick: 'Looking for a quick reveal…',
  deep: 'Searching deeper for a reveal…',
  deduce: 'Deducing the last cards and solving…',
  solve: 'Searching for a solution…',
};
import {
  boardDisplayState,
  boardToDisplayState,
  cardToShort,
  computeStates,
  deduceLastUnknown,
  decodeActions,
  decodeDeal,
  deriveBoard,
  describeMove,
  encodeActions,
  encodeDeal,
  fillOnlyUnknown,
  fullyKnown,
  hasUnrevealed,
  newInitialDeal,
  parseCards,
  parseTrack,
  planColumns,
  planStock,
  revealAt,
  revealTargets,
  serializeTrack,
  stockRemaining,
  type Action,
  type GameState,
  type InitialDeal,
  type Move,
} from './game';

const STORAGE_KEY = 'spider-track-session';

// Standard Spider rule: you can't deal a new row while any column is empty.
// Flip to true to allow the variant (kept off by default; the API/engine
// default matches).
const ALLOW_DEAL_WITH_EMPTY_COLUMNS = false;

type Session = { suits: number; deal: InitialDeal; actions: Action[] };

/** Restore the saved session (initial deal + actions) from this browser. */
function loadSaved(): Session | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const { suits, deal, actions } = parseTrack(raw);
    return suits && deal && actions ? { suits, deal, actions } : null;
  } catch {
    return null;
  }
}

/** Read the game state from the URL query params (`d` deal, `m` moves). */
function loadFromUrl(): Session | null {
  try {
    const params = new URLSearchParams(window.location.search);
    const d = params.get('d');
    if (!d) return null;
    const decoded = decodeDeal(d);
    if (!decoded) return null;
    const actions = decodeActions(params.get('m') ?? '');
    if (actions === null) return null;
    return { suits: decoded.suits, deal: decoded.deal, actions };
  } catch {
    return null;
  }
}

/** URL params take priority over the browser's saved session, if present. */
const initialSession = loadFromUrl() ?? loadSaved();

/**
 * Track a real game as you reveal cards; solve it once everything is known.
 * The session is the (partially-known) initial deal plus a log of actions
 * (moves/deals) — reveals feed the initial deal, not the action log — and the
 * board is derived by replaying the actions. So Undo reverses actions only, and
 * a saved session reproduces the game exactly.
 */
export default function TrackSolve() {
  const [suits, setSuits] = useState<number>(() => initialSession?.suits ?? 4);
  const [deal, setDeal] = useState<InitialDeal>(() => initialSession?.deal ?? newInitialDeal());
  const [actions, setActions] = useState<Action[]>(() => initialSession?.actions ?? []);
  const board = useMemo(() => deriveBoard(deal, actions), [deal, actions]);

  const [resp, setResp] = useState<PlanResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The search runs as one staged background job the UI polls (with a Cancel).
  // `jobStage` is the stage the server reports it's currently in, so we can label
  // what's happening and let the user bail out of any of it.
  const [jobId, setJobId] = useState<number | null>(null);
  const [jobStage, setJobStage] = useState<PlanStage>('');
  const [jobProgress, setJobProgress] = useState<{ nodes: number; elapsedMs: number } | null>(null);
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [sessionText, setSessionText] = useState('');
  const [copied, setCopied] = useState(false);
  const [deduced, setDeduced] = useState<string | null>(null);
  // A deep-search plan is shown only after the user confirms (it can be long).
  const [deepConfirmed, setDeepConfirmed] = useState(false);
  // The blown-up "pre-fill the whole deck" editor.
  const [prefillOpen, setPrefillOpen] = useState(false);

  // Plan player (shared by reveal plans and full solutions).
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(false);
  // Bumped on each *forward* step so the board animates the moved cards.
  // Back/jump/click leave it unchanged, so those update instantly.
  const [animNonce, setAnimNonce] = useState(0);
  // Next gets the full multi-phase choreography; Play stays a quick slide.
  const [richAnim, setRichAnim] = useState(true);
  // Newest completed suits held out of the foundations while their run animates
  // away (the Board reveals them once each King has flown up).
  const [hiddenCompletions, setHiddenCompletions] = useState(0);
  // The board *before* a manual "Deal a row", so that deal (and any suit it
  // completes) animates on the live board just like a playback step.
  const [dealAnim, setDealAnim] = useState<GameState | null>(null);

  // A plan is shown (and steppable) once we have moves — immediately for a
  // solution or a shallow reveal; a deep plan waits for the user to confirm.
  const showPlan =
    !!resp &&
    resp.moves.length > 0 &&
    (resp.phase === 'solve' || !resp.deep || deepConfirmed);

  // The board after each move of the shown plan, replayed on the current board.
  const planStates = useMemo(
    () => (showPlan ? computeStates(boardToDisplayState(board, deal), resp!.moves) : null),
    [showPlan, resp, board, deal],
  );

  // Reset the player whenever the shown plan changes.
  useEffect(() => {
    setStep(0);
    setPlaying(false);
    setHiddenCompletions(0);
  }, [planStates]);

  /** Advance one move, animating the cards. Used by Next and Play. */
  function advance() {
    setAnimNonce((n) => n + 1);
    setStep((s) => Math.min((planStates?.length ?? 1) - 1, s + 1));
  }
  function goTo(s: number) {
    setPlaying(false);
    setStep(s);
  }

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, serializeTrack(suits, deal, actions));
    } catch {
      /* ignore */
    }
  }, [suits, deal, actions]);

  // Mirror the game state into the URL: `d` = initial deal (with unknowns),
  // `m` = the moves so far. Both change as you play, and opening the page with
  // them reproduces the game. replaceState keeps it out of the history stack.
  useEffect(() => {
    const params = new URLSearchParams();
    params.set('d', encodeDeal(suits, deal));
    const m = encodeActions(actions);
    if (m) params.set('m', m);
    window.history.replaceState(null, '', `${window.location.pathname}?${params.toString()}`);
  }, [suits, deal, actions]);

  // When only one card is left unknown, deduce it — you never need to uncover
  // the last card (it's whatever is missing from everything else you entered).
  // Not while the pre-fill editor is open: there you may be deliberately clearing
  // a card you suspect is wrong, and auto-filling it back would defeat that (and
  // hide it from the solver's drill-back guidance). `prefillOpen` is intentionally
  // left out of the deps so closing the editor doesn't re-deduce the blank you
  // left — it only resumes once you change a card during normal play.
  useEffect(() => {
    // Drop a stale "deduced" note the moment the deck stops being fully known
    // (e.g. you cleared a card you suspect is wrong in the editor).
    const anyUnknown =
      deal.tableau.some((c) => c.some((x) => x === null)) || deal.stock.some((x) => x === null);
    if (anyUnknown) setDeduced(null);
    if (prefillOpen) return;
    const card = deduceLastUnknown(deal, suits);
    if (card) {
      setDeal((d) => fillOnlyUnknown(d, card));
      setDeduced(cardToShort(card));
    }
  }, [deal, suits]);

  useEffect(() => {
    if (!playing || !planStates) return;
    if (step >= planStates.length - 1) {
      setPlaying(false);
      return;
    }
    const id = setTimeout(() => {
      setRichAnim(false); // Play: quick slide, not the full choreography
      advance();
    }, 340);
    return () => clearTimeout(id);
  }, [playing, step, planStates]);

  const unfilled = hasUnrevealed(board, deal);
  const emptyColumns = board.columns.some((c) => c.cards.length === 0);
  const canDeal =
    stockRemaining(board) > 0 && (ALLOW_DEAL_WITH_EMPTY_COLUMNS || !emptyColumns) && !unfilled;

  function reset() {
    setSuits(4); // a fresh game defaults to the full 4-suit deck
    setDeal(newInitialDeal());
    setActions([]);
    setResp(null);
    setError(null);
    setDrafts({});
    setDeduced(null);
  }

  /** Back to the original deal: drop every move/deal, keep revealed cards. */
  function backToStart() {
    setActions([]);
    setResp(null);
    setError(null);
    setDrafts({});
  }

  /** Undo the last *action* (move or deal). Revealed cards stay known. */
  function undo() {
    if (actions.length === 0) return;
    setActions((a) => a.slice(0, -1));
    setResp(null);
    setError(null);
    setDrafts({});
  }

  function onCopySession() {
    const text = serializeTrack(suits, deal, actions);
    setSessionText(text);
    navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => {
        /* clipboard blocked — the text is in the box to copy manually */
      },
    );
  }

  function onLoadSession() {
    const { suits: s, deal: d, actions: a, error: err } = parseTrack(sessionText);
    if (err || !d || !a || !s) {
      setError(`Couldn't load session: ${err ?? 'invalid'}`);
      return;
    }
    setSuits(s);
    setDeal(d);
    setActions(a);
    setResp(null);
    setError(null);
    setDrafts({});
    setDeduced(null);
  }

  /** Record a revealed card into the initial deal. */
  function fillCard(c: number, text: string) {
    const { cards, error: err } = parseCards(text);
    if (err || cards.length !== 1) {
      setError(`Column ${c}: type one card (e.g. Kh)`);
      return;
    }
    setDeal((d) => revealAt(d, board, c, cards[0]));
    setDrafts((dr) => ({ ...dr, [c]: '' }));
    setError(null);
    setResp(null);
  }

  /**
   * Start the one staged plan search and poll it. The server escalates quick
   * reveal → deep reveal → deduce-and-solve (or straight to a solve when the deck
   * is fully known) on its own; the UI just shows the stage and a Cancel.
   */
  async function onPlan() {
    if (unfilled) {
      setError('Fill in the revealed (?) cards first.');
      return;
    }
    setError(null);
    setResp(null);
    setDeepConfirmed(false);
    setLoading(true);
    try {
      const id = await startPlanJob({
        suits,
        columns: planColumns(board, deal),
        stock: planStock(board, deal),
        allow_deal_with_empty: ALLOW_DEAL_WITH_EMPTY_COLUMNS,
      });
      setJobStage('');
      setJobProgress({ nodes: 0, elapsedMs: 0 });
      setJobId(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  /** Lock in the deduced hidden cards so the winning line replays on a full deck. */
  function applyFills(fills: FillCard[]) {
    setDeal((d) => {
      const nd: InitialDeal = { tableau: d.tableau.map((t) => t.slice()), stock: d.stock.slice() };
      for (const f of fills) {
        const origin = board.columns[f.col]?.cards[f.index];
        if (!origin) continue;
        const card = { rank: f.rank, suit: f.suit };
        if (origin.src === 't') nd.tableau[origin.col][origin.pos] = card;
        else nd.stock[origin.idx] = card;
      }
      return nd;
    });
  }

  // A single Cancel stops whatever stage is running and doesn't advance.
  function cancelSearch() {
    if (jobId !== null) cancelPlanJob(jobId);
    setJobId(null);
    setJobProgress(null);
  }

  // Poll the running plan job ~1×/s (which also renews its server-side lease).
  useEffect(() => {
    if (jobId === null) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    // Give up rather than spin forever if the server becomes unreachable (a
    // dropped dev server, a network blip). Resets on any successful poll.
    let failures = 0;
    const MAX_FAILURES = 5;
    const tick = async () => {
      try {
        const s = await pollPlanJob(jobId);
        if (stopped) return;
        failures = 0;
        if (!s) {
          setJobId(null);
          setJobProgress(null);
          setError('The search was dropped (server restarted or it timed out). Try again.');
          return;
        }
        setJobStage(s.stage);
        setJobProgress({ nodes: s.nodes, elapsedMs: s.elapsed_ms });
        if (s.status === 'done') {
          setJobId(null);
          setJobProgress(null);
          if (s.result) {
            // A deduced solve tells us the hidden cards — fill them so the
            // winning line replays on the now-complete deck.
            if (s.result.fill?.length) applyFills(s.result.fill);
            setResp(s.result);
          }
        } else if (s.status === 'cancelled') {
          setJobId(null);
          setJobProgress(null);
        } else {
          timer = setTimeout(tick, 1000);
        }
      } catch {
        if (stopped) return;
        failures += 1;
        if (failures >= MAX_FAILURES) {
          setJobId(null);
          setJobProgress(null);
          setError("Lost contact with the server — the search may still be running, but the app can't reach it. Check the server, then try again.");
          return;
        }
        timer = setTimeout(tick, 1500);
      }
    };
    timer = setTimeout(tick, 300);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  // If the board changes under a running job, its result is stale — cancel it.
  // (Applying deduced fills changes the board too, but the job is already done by
  // then, so the `jobId !== null` guard makes this a no-op in that case.)
  useEffect(() => {
    if (jobId !== null) {
      cancelPlanJob(jobId);
      setJobId(null);
      setJobProgress(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [board]);

  function applyMoves() {
    if (!resp) return;
    const acts: Action[] = resp.moves.map((m) =>
      m.type === 'deal'
        ? { kind: 'deal' }
        : { kind: 'move', from: m.from, to: m.to, count: m.count },
    );
    setActions((a) => [...a, ...acts]);
    setResp(null);
    setDrafts({});
  }

  function dealRow() {
    setDealAnim(boardDisplayState(board, deal)); // snapshot before the deal
    setRichAnim(true);
    setAnimNonce((n) => n + 1);
    setActions((a) => [...a, { kind: 'deal' }]);
    setResp(null);
  }

  const revealCols = revealTargets(board, deal);
  const isSolve = resp?.phase === 'solve';
  const currentMove = showPlan && step > 0 ? resp!.moves[step - 1] : null;
  const displayState = planStates ? planStates[step] : boardDisplayState(board, deal);
  const lastState = planStates ? planStates[planStates.length - 1] : null;
  const showFoundations = !!planStates && (isSolve || (lastState?.completed ?? 0) > 0);
  // Suits to actually show in the foundations now: all completed, minus any whose
  // run is still animating away this step (held back by the Board until the King
  // lands). Pop the newest only once it's a suit this step actually revealed.
  const shownCompleted = Math.max(0, displayState.completed - hiddenCompletions);
  const shownSuits = displayState.completedSuits.slice(0, shownCompleted);
  const prevCompleted = planStates && step > 0 ? planStates[step - 1].completed : 0;
  const atEnd = !planStates || step >= planStates.length - 1;
  // The board Board animates from: a plan step, or a manual deal on the live board.
  const boardPrev = planStates ? (step > 0 ? planStates[step - 1] : null) : dealAnim;
  const boardMove: Move | null = planStates ? currentMove : dealAnim ? { type: 'deal' } : null;

  return (
    <>
      {prefillOpen && (
        <PreFill
          suits={suits}
          deal={deal}
          onSuits={(s) => {
            setSuits(s);
            setResp(null);
          }}
          onDeal={(update) => {
            setDeal(update);
            setResp(null);
          }}
          onClose={() => setPrefillOpen(false)}
        />
      )}
      <div className="track">
      <aside className="sidebar">
        <div className="controls">
          <button
            className="primary big"
            onClick={onPlan}
            disabled={loading || unfilled || jobId !== null}
          >
            {jobId !== null
              ? 'Searching…'
              : loading
                ? 'Thinking…'
                : fullyKnown(board, deal)
                  ? '✦ Solve!'
                  : '✦ Get next steps'}
          </button>
          <div className="control-row">
            <label className="suits">
              Suits
              <select
                value={suits}
                onChange={(e) => {
                  setSuits(Number(e.target.value));
                  setResp(null);
                }}
              >
                <option value={1}>1</option>
                <option value={2}>2</option>
                <option value={4}>4</option>
              </select>
            </label>
            <button
              onClick={dealRow}
              disabled={!canDeal}
              title={canDeal ? '' : 'Deal needs cards in the stock, no empty columns, and no unfilled ? cards'}
            >
              Deal a row ({stockRemaining(board)})
            </button>
          </div>
          <div className="control-row">
            <button onClick={undo} disabled={actions.length === 0} title="Undo the last move or deal">
              ↶ Undo
            </button>
            <button
              onClick={backToStart}
              disabled={actions.length === 0}
              title="Rewind all moves and deals back to the original deal"
            >
              ⟲ Original
            </button>
            <button onClick={reset}>New game</button>
          </div>
          <button onClick={() => setPrefillOpen(true)} title="Type in all the cards you already know">
            ✎ Pre-fill deck…
          </button>
        </div>

        {jobId !== null && (
          <div className="banner good solving">
            <div className="solving-head">
              <span className="spinner" />
              <b>{STAGE_LABEL[jobStage]}</b>
            </div>
            <div className="solve-progress">
              {jobProgress
                ? `${(jobProgress.nodes / 1e6).toFixed(0)}M nodes · ${(jobProgress.elapsedMs / 1000).toFixed(0)}s`
                : 'starting…'}
            </div>
            <p className="hint" style={{ margin: '4px 0 8px' }}>
              It escalates on its own — quick reveal, then a deeper search, then
              deducing the last cards. Cancel any time to stop where it is.
            </p>
            <button onClick={cancelSearch}>Cancel search</button>
          </div>
        )}

        {error && <div className="banner error">⚠ {error}</div>}

        {deduced && (
          <div className="banner good">
            Only one card was unknown, so it's deduced: <b>{deduced}</b>. The deck
            is now fully known — hit <b>Solve!</b>.
          </div>
        )}

        {revealCols.length > 0 && (
          <div className="reveals">
            <b>Type in the revealed cards:</b>
            {revealCols.map((c) => (
              <span key={c} className="reveal-input">
                col {c}
                <input
                  autoFocus={c === revealCols[0]}
                  placeholder="?"
                  value={drafts[c] ?? ''}
                  onChange={(e) => setDrafts((d) => ({ ...d, [c]: e.target.value }))}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') fillCard(c, (e.target as HTMLInputElement).value);
                  }}
                  onBlur={(e) => e.target.value.trim() && fillCard(c, e.target.value)}
                />
              </span>
            ))}
          </div>
        )}

        {resp && (
          <div className="plan">
            <div className={`banner ${isSolve || resp.phase === 'discover' ? 'good' : 'warn'}`}>
              {resp.note}
              {isSolve && resp.verified ? ' ✓ verified' : ''}
            </div>

            {/* Deep plan found — confirm before showing/stepping it. */}
            {resp.moves.length > 0 && resp.deep && !deepConfirmed && (
              <div className="banner warn">
                ⚠ A <b>{resp.moves.length}-move</b> maneuver. Step through it to
                review before playing it out.
                <div className="plan-actions">
                  <button className="primary" onClick={() => setDeepConfirmed(true)}>
                    Review the {resp.moves.length} moves
                  </button>
                  <button onClick={() => setResp(null)}>Cancel</button>
                </div>
              </div>
            )}

            {showPlan && planStates && (
              <>
                <div className="player-bar">
                  <button onClick={() => goTo(0)} disabled={step === 0} title="Start">
                    ⏮
                  </button>
                  <button onClick={() => goTo(Math.max(0, step - 1))} disabled={step === 0} title="Back">
                    ◀
                  </button>
                  <button
                    className="primary"
                    onClick={() => setPlaying((p) => !p)}
                    disabled={atEnd}
                    title="Play"
                  >
                    {playing ? '❚❚' : '▶'}
                  </button>
                  <button
                    onClick={() => {
                      setPlaying(false);
                      setRichAnim(true);
                      advance();
                    }}
                    disabled={atEnd}
                    title="Next"
                  >
                    ▶▶
                  </button>
                  <button
                    onClick={() => goTo(planStates.length - 1)}
                    disabled={atEnd}
                    title="End"
                  >
                    ⏭
                  </button>
                  <span className="counter">
                    {step} / {planStates.length - 1}
                  </span>
                </div>

                <ol className="move-list">
                  {resp.moves.map((m, i) => (
                    <li
                      key={i}
                      className={i === step - 1 ? 'current' : ''}
                      onClick={() => goTo(i + 1)}
                      title="Jump to this move"
                    >
                      {describeMove(m)}
                    </li>
                  ))}
                </ol>

                {!isSolve && (
                  <button className="primary" onClick={applyMoves}>
                    Apply these moves ↴
                  </button>
                )}
              </>
            )}
          </div>
        )}

        <details className="info">
          <summary>ℹ️ How this works</summary>
          <p className="hint">
            Track a real game as you go. Type in the face-up cards you can see;
            ask for <b>next steps</b> to uncover more; fill in each revealed{' '}
            <b>?</b> card; <b>deal a row</b> when stuck. <b>↶ Undo</b> reverses the
            last move or deal (revealed cards stay known). Suggested plans can be
            stepped through on the board — click any move to jump there, then{' '}
            <b>Apply</b> to play it. Once every card is known, it returns the full
            winning solution.
          </p>
        </details>

        <details className="session">
          <summary>💾 Save / load session</summary>
          <p className="hint">
            The session is the initial deal plus your moves & deals — it reproduces
            the game exactly. Copy it to save, share, or report a bug; paste one
            back and <b>Load from text</b> to replay it. Also auto-saves here and
            in the URL.
          </p>
          <div className="session-actions">
            <button onClick={onCopySession}>{copied ? 'Copied ✓' : 'Copy session'}</button>
            <button onClick={onLoadSession}>Load from text</button>
          </div>
          <textarea
            className="session-text"
            rows={7}
            value={sessionText}
            onChange={(e) => setSessionText(e.target.value)}
            placeholder="Click 'Copy session' to fill this box, or paste a saved session and click 'Load from text'."
          />
        </details>
      </aside>

      <main className="board-area">
        <div className="board-caption">
          {planStates ? (
            <>
              {currentMove ? describeMove(currentMove) : isSolve ? 'Starting position' : 'Before the plan'}
              {showFoundations && (
                <span className="completed"> · {displayState.completed}/8 runs</span>
              )}
            </>
          ) : (
            <>Your board{unfilled ? ' — fill in the ? cards' : ''}</>
          )}
        </div>

        {showFoundations && lastState && (
          <Foundations suits={shownSuits} justCompleted={shownCompleted > prevCompleted} />
        )}

        <Board
          state={displayState}
          move={boardMove}
          showStock={false}
          prevState={boardPrev}
          animNonce={animNonce}
          rich={richAnim}
          onHideCompletions={setHiddenCompletions}
          onRevealCompletion={() => setHiddenCompletions((h) => Math.max(0, h - 1))}
        />
      </main>
      </div>
    </>
  );
}
