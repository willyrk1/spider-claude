import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import type { GameState } from '../game';
import { COLS, rankName, suitClass, suitSymbol } from '../game';
import { canDrop, canPickUp } from './rules';

type Props = {
  state: GameState;
  /** Card ids of a just-finished K..A run, animating away. */
  vanishing: ReadonlySet<number>;
  /** A tap on a face-up card; returns false when it couldn't move anywhere. */
  onTap: (col: number, index: number) => boolean;
  /** A drag released over column `to` (already checked legal). */
  onDrop: (col: number, index: number, to: number) => void;
  /** The stock pile, so newly dealt cards can fly in from it. */
  stockEl: () => HTMLElement | null;
  reduceMotion: boolean;
  /** A suggested move to highlight: the stack from `from[index]`, onto `to`. */
  hint: { from: number; index: number; to: number } | null;
};

type Geometry = {
  cw: number;
  ch: number;
  pitch: number; // column-to-column distance
  left: number; // x of column 0
  up: number; // vertical step per covered face-up card
  down: number; // ...and per covered face-down card
  height: number; // total table height
};

const TOP = 6;
const BOTTOM = 18;
const DRAG_SLOP = 8; // px of movement before a press becomes a drag

/** Size the cards to the width, then squish the overlap to fit the height. */
function geometry(state: GameState, w: number, h: number): Geometry {
  const narrow = w < 520;
  const pad = narrow ? 4 : 14;
  const gap = narrow ? 3 : w < 900 ? 6 : 10;
  let cw = Math.floor((w - 2 * pad - (COLS - 1) * gap) / COLS);
  cw = Math.max(26, Math.min(cw, 96, Math.floor((h * 0.22) / 1.4)));
  const ch = Math.round(cw * 1.4);
  const pitch = cw + gap;
  const left = Math.max(pad, Math.floor((w - (COLS * cw + (COLS - 1) * gap)) / 2));

  // Roomy by default; squished below only when a column outgrows the height.
  let up = ch * 0.42;
  let down = ch * 0.14;
  const minUp = cw * 0.46; // the index must stay readable on a buried card
  const minDown = Math.max(3, ch * 0.05);
  let tallest = 0;
  for (const col of state.columns) {
    let s = 0;
    for (let i = 0; i < col.cards.length - 1; i++) s += i < col.faceDown ? down : up;
    tallest = Math.max(tallest, s);
  }
  const room = h - TOP - BOTTOM - ch;
  if (tallest > room && tallest > 0) {
    const k = room / tallest;
    up = Math.max(minUp, up * k);
    down = Math.max(minDown, down * k);
  }
  let height = 0;
  for (const col of state.columns) {
    let s = 0;
    for (let i = 0; i < col.cards.length - 1; i++) s += i < col.faceDown ? down : up;
    height = Math.max(height, s);
  }
  return { cw, ch, pitch, left, up, down, height: Math.max(h, TOP + height + ch + BOTTOM) };
}

type Placed = { id: number; col: number; index: number; x: number; y: number; faceUp: boolean };

function place(state: GameState, g: Geometry): Placed[] {
  const out: Placed[] = [];
  state.columns.forEach((col, c) => {
    let y = TOP;
    col.cards.forEach((card, i) => {
      out.push({ id: card.id ?? c * 100 + i, col: c, index: i, x: g.left + c * g.pitch, y, faceUp: i >= col.faceDown });
      y += i < col.faceDown ? g.down : g.up;
    });
  });
  // Stable DOM order (by id) so React never reorders nodes; z-index stacks them.
  return out.sort((a, b) => a.id - b.id);
}

type Drag = {
  col: number;
  index: number;
  ids: number[];
  x0: number;
  y0: number;
  dx: number;
  dy: number;
  active: boolean;
  pickable: boolean;
};

export function Table({ state, vanishing, onTap, onDrop, stockEl, reduceMotion, hint }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const els = useRef(new Map<number, HTMLDivElement>());
  const lastPos = useRef(new Map<number, { x: number; y: number; faceUp: boolean }>());
  const lastState = useRef<GameState | null>(null);
  // Where dropped cards visually were, so they glide from the drop point.
  const dropFrom = useRef(new Map<number, { x: number; y: number }>());
  const drag = useRef<Drag | null>(null);

  useLayoutEffect(() => {
    const el = wrapRef.current!;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const g = useMemo(() => (size ? geometry(state, size.w, size.h) : null), [state, size]);
  const placed = useMemo(() => (g ? place(state, g) : []), [state, g]);

  // FLIP: after each new state, play every card from where it was to where it is.
  useLayoutEffect(() => {
    if (!g) return;
    const moved = lastState.current !== null && lastState.current !== state;
    const prev = lastPos.current;
    const next = new Map<number, { x: number; y: number; faceUp: boolean }>();
    let stockAt: { x: number; y: number } | null = null;
    if (moved && !reduceMotion) {
      const s = stockEl()?.getBoundingClientRect();
      const t = tableRef.current?.getBoundingClientRect();
      if (s && t) stockAt = { x: s.left - t.left, y: s.top - t.top };
    }
    for (const p of placed) {
      next.set(p.id, { x: p.x, y: p.y, faceUp: p.faceUp });
      if (!moved || reduceMotion) continue;
      const el = els.current.get(p.id);
      if (!el) continue;
      const was = prev.get(p.id);
      const from = dropFrom.current.get(p.id) ?? was;
      if (from) {
        if (from.x !== p.x || from.y !== p.y) glide(el, from.x - p.x, from.y - p.y, 170, 0);
        if (was && !was.faceUp && p.faceUp) turnUp(el, 110);
      } else if (stockAt) {
        glide(el, stockAt.x - p.x, stockAt.y - p.y, 230, p.col * 30); // dealt from the stock
      }
    }
    dropFrom.current.clear();
    lastPos.current = next;
    lastState.current = state;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placed]);

  function glide(el: HTMLDivElement, dx: number, dy: number, duration: number, delay: number) {
    el.style.zIndex = String(600 + Number(el.dataset.z));
    const a = el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0, 0)' }], {
      duration,
      delay,
      easing: 'cubic-bezier(0.2, 0.7, 0.3, 1)',
      fill: 'backwards',
    });
    a.onfinish = a.oncancel = () => (el.style.zIndex = el.dataset.z ?? '');
  }

  function turnUp(el: HTMLDivElement, delay: number) {
    el.animate([{ transform: 'scaleX(0.05)' }, { transform: 'scaleX(1)' }], {
      duration: 160,
      delay,
      easing: 'ease-out',
      fill: 'backwards',
    });
  }

  function shake(ids: number[]) {
    try {
      navigator.vibrate?.(30);
    } catch {
      /* not allowed here — the shake alone will do */
    }
    if (reduceMotion) return;
    for (const id of ids) {
      els.current.get(id)?.animate(
        [
          { transform: 'translateX(0)' },
          { transform: 'translateX(-5px)' },
          { transform: 'translateX(5px)' },
          { transform: 'translateX(-3px)' },
          { transform: 'translateX(0)' },
        ],
        { duration: 220, easing: 'ease-out' },
      );
    }
  }

  function setLift(d: Drag, on: boolean) {
    d.ids.forEach((id, k) => {
      const el = els.current.get(id);
      if (!el) return;
      el.style.transform = on ? `translate(${d.dx}px, ${d.dy}px)` : '';
      el.style.zIndex = on ? String(1000 + k) : (el.dataset.z ?? '');
      el.classList.toggle('lifted', on);
    });
  }

  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>, col: number, index: number) {
    if (e.button !== 0 || drag.current) return;
    const c = state.columns[col];
    if (index < c.faceDown) return; // a face-down card does nothing
    try {
      e.currentTarget.setPointerCapture(e.pointerId); // keep getting moves off the card
    } catch {
      /* no active pointer to capture (e.g. a synthetic event) — taps still work */
    }
    drag.current = {
      col,
      index,
      ids: c.cards.slice(index).map((card) => card.id ?? -1),
      x0: e.clientX,
      y0: e.clientY,
      dx: 0,
      dy: 0,
      active: false,
      pickable: canPickUp(c, index),
    };
  }

  function onPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    const d = drag.current;
    if (!d || !d.pickable) return;
    d.dx = e.clientX - d.x0;
    d.dy = e.clientY - d.y0;
    if (!d.active && Math.hypot(d.dx, d.dy) < DRAG_SLOP) return;
    d.active = true;
    setLift(d, true);
  }

  function onPointerUp() {
    const d = drag.current;
    drag.current = null;
    if (!d || !g) return;
    if (!d.active) {
      if (!onTap(d.col, d.index)) shake(d.ids);
      return;
    }
    // Drop on the column nearest the dragged card's centre.
    const cx = g.left + d.col * g.pitch + g.cw / 2 + d.dx;
    const to = Math.max(0, Math.min(COLS - 1, Math.round((cx - g.left - g.cw / 2) / g.pitch)));
    if (canDrop(state, d.col, d.index, to)) {
      for (const id of d.ids) {
        const p = lastPos.current.get(id);
        if (p) dropFrom.current.set(id, { x: p.x + d.dx, y: p.y + d.dy });
      }
      setLift(d, false);
      onDrop(d.col, d.index, to);
    } else {
      snapBack(d);
    }
  }

  function snapBack(d: Drag) {
    setLift(d, false);
    if (reduceMotion) return;
    for (const id of d.ids) {
      const el = els.current.get(id);
      if (el) glide(el, d.dx, d.dy, 160, 0);
    }
  }

  function onPointerCancel() {
    const d = drag.current;
    drag.current = null;
    if (d?.active) snapBack(d);
  }

  const vars = g ? ({ '--cw': `${g.cw}px`, '--ch': `${g.ch}px`, height: g.height } as CSSProperties) : undefined;

  return (
    <div className="table-wrap" ref={wrapRef}>
      {g && (
        <div className="table" ref={tableRef} style={vars}>
          {state.columns.map((col, c) =>
            col.cards.length === 0 ? (
              <div
                key={`slot-${c}`}
                className={`slot${hint?.to === c ? ' hint-dst' : ''}`}
                style={{ left: g.left + c * g.pitch, top: TOP }}
              />
            ) : null,
          )}
          {placed.map((p) => {
            const col = state.columns[p.col];
            const card = col.cards[p.index];
            const z = p.index + 1;
            const grab = p.faceUp && canPickUp(col, p.index);
            const gone = vanishing.has(p.id);
            const hintSrc = hint !== null && p.col === hint.from && p.index >= hint.index;
            const hintDst = hint !== null && p.col === hint.to && p.index === col.cards.length - 1;
            const cls =
              `pcard${p.faceUp ? ' ' + suitClass(card.suit) : ' down'}` +
              `${grab ? ' grab' : ''}${gone ? ' vanish' : ''}` +
              `${hintSrc ? ' hint-src' : ''}${hintDst ? ' hint-dst' : ''}`;
            return (
              <div
                key={p.id}
                ref={(el) => {
                  if (el) els.current.set(p.id, el);
                  else els.current.delete(p.id);
                }}
                className={cls}
                data-z={z}
                style={{
                  left: p.x,
                  top: p.y,
                  zIndex: z,
                  animationDelay: gone ? `${(col.cards.length - 1 - p.index) * 16}ms` : undefined,
                }}
                onPointerDown={(e) => onPointerDown(e, p.col, p.index)}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerCancel}
                aria-label={p.faceUp ? `${rankName(card.rank)}${suitSymbol(card.suit)}` : 'face-down card'}
              >
                {p.faceUp && (
                  <>
                    <span className="idx">
                      {rankName(card.rank)}
                      <span className="s">{suitSymbol(card.suit)}</span>
                    </span>
                    <span className="pip">{suitSymbol(card.suit)}</span>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
