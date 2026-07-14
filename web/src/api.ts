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
};

/** POST /plan — discover more cards, or (once all known) the full solution. */
export async function plan(params: {
  suits: number;
  columns: PlanColumn[];
  stock: PlanCard[];
  allow_deal_with_empty?: boolean;
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
