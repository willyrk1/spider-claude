import { useEffect, useState } from 'react';
import {
  cardToShort,
  parseCards,
  TABLEAU_SIZES,
  type Card,
  type InitialDeal,
} from './game';

const key = (c: Card) => `${c.rank},${c.suit}`;

type CellProps = {
  card: Card | null;
  bad: boolean;
  onSet: (card: Card | null) => void;
  refCb?: (el: HTMLInputElement | null) => void;
};

/**
 * One editable card box. Backed by local text so partial typing (e.g. "1" on the
 * way to "10h") never clobbers storage; it writes to the deal only when the text
 * parses to a single card, or clears it when emptied. Syncs from the deal when
 * it isn't the one being edited (so an external change — like the auto-deduced
 * last card — shows up). Focus selects all, so typing overwrites the whole cell.
 */
function CardCell({ card, bad, onSet, refCb }: CellProps) {
  const canonical = card ? cardToShort(card) : '';
  const [text, setText] = useState(canonical);
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (!focused) setText(canonical);
  }, [canonical, focused]);

  const trimmed = text.trim();
  const { cards, error } = trimmed ? parseCards(trimmed) : { cards: [], error: undefined };
  const parseBad = trimmed !== '' && (!!error || cards.length !== 1);

  function commit(t: string) {
    const s = t.trim();
    if (s === '') {
      onSet(null);
      return;
    }
    const { cards: c, error: e } = parseCards(s);
    if (!e && c.length === 1) onSet(c[0]);
  }

  const cls = `cell${parseBad || bad ? ' bad' : ''}${card ? ' filled' : ''}`;
  return (
    <input
      ref={refCb}
      className={cls}
      value={text}
      placeholder="?"
      spellCheck={false}
      autoComplete="off"
      onChange={(e) => {
        setText(e.target.value);
        commit(e.target.value);
      }}
      onFocus={(e) => {
        setFocused(true);
        e.target.select();
      }}
      onBlur={() => {
        setFocused(false);
        if (parseBad) setText(canonical); // drop unparseable text on the way out
      }}
    />
  );
}

type Props = {
  suits: number;
  deal: InitialDeal;
  onSuits: (suits: number) => void;
  onDeal: (update: (d: InitialDeal) => InitialDeal) => void;
  onClose: () => void;
};

/**
 * Blown-up editor for the whole initial deck: 50 stock boxes (5 rows of 10) and
 * the 10 tableau columns (54 boxes), so a real game's known cards can be typed
 * in up front. Reads and writes the same `deal` as the rest of the UI. Tab moves
 * left-to-right (DOM order is row-major); clicking a cell selects its text.
 */
export default function PreFill({ suits, deal, onSuits, onDeal, onClose }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  function setTableau(col: number, pos: number, card: Card | null) {
    onDeal((d) => {
      const tableau = d.tableau.map((c, i) => (i === col ? c.slice() : c));
      tableau[col][pos] = card;
      return { ...d, tableau };
    });
  }
  function setStock(idx: number, card: Card | null) {
    onDeal((d) => {
      const stock = d.stock.slice();
      stock[idx] = card;
      return { ...d, stock };
    });
  }
  function clearAll() {
    onDeal((d) => ({
      tableau: d.tableau.map((c) => c.map(() => null)),
      stock: d.stock.map(() => null),
    }));
  }

  // A card is "bad" if its suit isn't part of this deck, or it appears more often
  // than the deck allows (4-suit → 2 copies, 2-suit → 4, 1-suit → 8).
  const copies = 8 / suits;
  const counts = new Map<string, number>();
  for (const c of deal.tableau.flat()) if (c) counts.set(key(c), (counts.get(key(c)) ?? 0) + 1);
  for (const c of deal.stock) if (c) counts.set(key(c), (counts.get(key(c)) ?? 0) + 1);
  const isBad = (c: Card | null) => !!c && (c.suit >= suits || (counts.get(key(c)) ?? 0) > copies);

  const filled =
    deal.tableau.reduce((n, c) => n + c.filter(Boolean).length, 0) +
    deal.stock.filter(Boolean).length;

  return (
    <div className="prefill-backdrop" onMouseDown={onClose}>
      <div className="prefill" onMouseDown={(e) => e.stopPropagation()}>
        <div className="prefill-head">
          <h2>Pre-fill the deck</h2>
          <label className="suits">
            Suits
            <select value={suits} onChange={(e) => onSuits(Number(e.target.value))}>
              <option value={1}>1</option>
              <option value={2}>2</option>
              <option value={4}>4</option>
            </select>
          </label>
          <span className="prefill-count">{filled}/104 cards</span>
          <span className="prefill-spacer" />
          <button onClick={clearAll}>Clear all</button>
          <button className="primary" onClick={onClose}>
            Done
          </button>
        </div>

        <p className="hint prefill-hint">
          Type each card as rank + suit — e.g. <code>Kh</code>, <code>10c</code>,{' '}
          <code>As</code> (suits: <b>s</b>♠ <b>h</b>♥ <b>c</b>♣ <b>d</b>♦). Leave a box
          blank for cards you can't see yet. Tab moves left to right.
        </p>

        <div className="prefill-section">
          <div className="prefill-label">Stock — 50 cards, dealt in 5 rows of 10</div>
          <div className="prefill-grid stock-grid">
            {Array.from({ length: 5 }, (_, row) =>
              Array.from({ length: 10 }, (_, col) => {
                const idx = row * 10 + col;
                return (
                  <CardCell
                    key={idx}
                    card={deal.stock[idx]}
                    bad={isBad(deal.stock[idx])}
                    onSet={(c) => setStock(idx, c)}
                  />
                );
              }),
            )}
          </div>
        </div>

        <div className="prefill-section">
          <div className="prefill-label">
            Tableau — 10 columns (the top row is the deepest, face-down card)
          </div>
          <div className="prefill-grid tableau-grid">
            {Array.from({ length: 10 }, (_, col) => (
              <div
                key={`h${col}`}
                className="tableau-col-label"
                style={{ gridColumn: col + 1, gridRow: 1 }}
              >
                {col}
              </div>
            ))}
            {Array.from({ length: 6 }, (_, row) =>
              TABLEAU_SIZES.map((size, col) =>
                row < size ? (
                  <div
                    key={`${col}-${row}`}
                    className="tableau-cell"
                    style={{ gridColumn: col + 1, gridRow: row + 2 }}
                  >
                    <CardCell
                      card={deal.tableau[col][row]}
                      bad={isBad(deal.tableau[col][row])}
                      onSet={(c) => setTableau(col, row, c)}
                    />
                  </div>
                ) : null,
              ),
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
