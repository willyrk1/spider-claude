import type { Move } from './game';

// Each card in a plan request is a card object or null (still unknown).
export type PlanCard = { rank: number; suit: number } | null;
export type PlanColumn = { face_down: number; cards: PlanCard[] };

/** A deduced hidden card and where it sits on the current board. */
export type FillCard = { col: number; index: number; rank: number; suit: number };

export type PlanResponse = {
  phase: 'discover' | 'solve' | 'stuck';
  moves: Move[];
  note: string;
  uncovers?: number;
  verified?: boolean;
  winning_config?: { weight: number; fdw: number };
  nodes_searched?: number;
  /** True when this plan came from a deep search (may be very long). */
  deep?: boolean;
  /** For a deduce-and-solve result: hidden cards to fill in before the moves replay. */
  fill?: FillCard[];
};

export type PlanParams = {
  suits: number;
  columns: PlanColumn[];
  stock: PlanCard[];
  allow_deal_with_empty?: boolean;
};

const UNREACHABLE =
  "Can't reach the solver server — start it with `cargo run --release -p spider-api` and try again.";

/**
 * Turn a failed response into a useful Error. The API always sends a message
 * body with its own errors, so a bodiless 5xx is the dev-server proxy telling
 * us it couldn't connect to the API at all — a much more actionable thing to
 * say than "API 500".
 */
async function failure(res: Response): Promise<Error> {
  const text = await res.text().catch(() => '');
  if (!text && res.status >= 500) return new Error(UNREACHABLE);
  return new Error(`API ${res.status}${text ? `: ${text}` : ''}`);
}

async function postJson(url: string, body: unknown) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await failure(res);
  return res.json();
}

// ---- The unified plan job (long, staged, cancellable, polled) ----
//
// One background job escalates through the searches automatically — quick reveal
// → deep reveal → deduce-and-solve, or straight to a solve when the board is
// fully known — reporting which `stage` it's in and its node progress, and
// stoppable at any point.

/** Which stage the plan job is (or was last) running. */
export type PlanStage = 'quick' | 'deep' | 'deduce' | 'solve' | '';

export type PlanJobStatus = {
  status: 'running' | 'done' | 'cancelled';
  stage: PlanStage;
  nodes: number;
  elapsed_ms: number;
  result?: PlanResponse;
};

/** POST /plan/jobs — kick off the staged plan search. */
export async function startPlanJob(params: PlanParams): Promise<number> {
  const { job_id } = await postJson('/api/plan/jobs', params);
  return job_id;
}

/** GET /plan/jobs/:id — poll the job (also renews its lease/heartbeat). */
export async function pollPlanJob(id: number): Promise<PlanJobStatus | null> {
  const res = await fetch(`/api/plan/jobs/${id}`);
  if (res.status === 404) return null; // reaped or unknown
  if (!res.ok) throw await failure(res);
  return res.json();
}

/** DELETE /plan/jobs/:id — cancel the running job. */
export async function cancelPlanJob(id: number): Promise<void> {
  await fetch(`/api/plan/jobs/${id}`, { method: 'DELETE' }).catch(() => {});
}
