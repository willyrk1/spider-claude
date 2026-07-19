import type { Move } from './game';

// Each card in a /plan request is a card object or null (still unknown).
export type PlanCard = { rank: number; suit: number } | null;
export type PlanColumn = { face_down: number; cards: PlanCard[] };

export type PlanResponse = {
  phase: 'discover' | 'solve' | 'stuck';
  moves: Move[];
  note: string;
  uncovers?: number;
  verified?: boolean;
  winning_config?: { weight: number; fdw: number };
  nodes_searched?: number;
  /** True when this plan came from the opt-in deep search (may be very long). */
  deep?: boolean;
};

export type PlanParams = {
  suits: number;
  columns: PlanColumn[];
  stock: PlanCard[];
  allow_deal_with_empty?: boolean;
};

async function postJson(url: string, body: unknown) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`API ${res.status}${text ? `: ${text}` : ''}`);
  }
  return res.json();
}

/** POST /plan — discover more cards, or (once all known) the full solution. */
export function plan(params: PlanParams): Promise<PlanResponse> {
  return postJson('/api/plan', params);
}

// ---- Async jobs (long, cancellable, polled) ----
//
// Two kinds share the same job machinery on the server (poll/cancel/heartbeat/
// reaper): a full solve of a known board, and a deep reveal search on a
// partially-known one. They start at different endpoints but poll/cancel the
// same way, keyed by `kind`.

export type JobKind = 'solve' | 'reveal';

export type SolveJobStatus = {
  status: 'running' | 'done' | 'cancelled';
  nodes: number;
  elapsed_ms: number;
  result?: PlanResponse;
};

/** POST /solve/jobs — kick off a background solve of a fully-known board. */
export async function startSolveJob(params: PlanParams): Promise<number> {
  const { job_id } = await postJson('/api/solve/jobs', params);
  return job_id;
}

/** POST /reveal/jobs — kick off a background deep reveal search. */
export async function startRevealJob(params: PlanParams): Promise<number> {
  const { job_id } = await postJson('/api/reveal/jobs', params);
  return job_id;
}

/** GET /{kind}/jobs/:id — poll a job (also renews its lease/heartbeat). */
export async function pollJob(kind: JobKind, id: number): Promise<SolveJobStatus | null> {
  const res = await fetch(`/api/${kind}/jobs/${id}`);
  if (res.status === 404) return null; // reaped or unknown
  if (!res.ok) throw new Error(`API ${res.status}`);
  return res.json();
}

/** DELETE /{kind}/jobs/:id — cancel a running job. */
export async function cancelJob(kind: JobKind, id: number): Promise<void> {
  await fetch(`/api/${kind}/jobs/${id}`, { method: 'DELETE' }).catch(() => {});
}
