import type { InitialBoard, Move } from './game';

export type WinningConfig = { weight: number; fdw: number };

export type SolveResponse = {
  suits: number;
  seed: number;
  solved: boolean;
  verified: boolean;
  quality: string; // "converged" | "budget" | "fallback" | "unsolved"
  move_count: number;
  winning_config: WinningConfig | null;
  nodes_searched: number;
  moves: Move[];
  initial_board?: InitialBoard;
};

export type SolveParams = {
  suits: number;
  seed: number;
  weight?: number;
  fdw?: number;
  nodes?: number;
};

/** POST /solve via the Vite dev proxy (same-origin, no CORS). */
export async function solve(params: SolveParams): Promise<SolveResponse> {
  const res = await fetch('/api/solve', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...params, include_board: true }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`API ${res.status}${text ? `: ${text}` : ''}`);
  }
  return res.json();
}

export type AdviseColumn = {
  face_down: number;
  up: { rank: number; suit: number }[];
};

export type AdviseResponse = {
  moves: Move[];
  uncovers: number;
  completes: number;
  empties: number;
  note: string;
};

/** POST /advise — partial-information advice for a game you can only partly see. */
export async function advise(params: {
  suits: number;
  columns: AdviseColumn[];
}): Promise<AdviseResponse> {
  const res = await fetch('/api/advise', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`API ${res.status}${text ? `: ${text}` : ''}`);
  }
  return res.json();
}

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
};

/** POST /plan — discover more cards, or (once all known) the full solution. */
export async function plan(params: {
  suits: number;
  columns: PlanColumn[];
  stock: PlanCard[];
}): Promise<PlanResponse> {
  const res = await fetch('/api/plan', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`API ${res.status}${text ? `: ${text}` : ''}`);
  }
  return res.json();
}
