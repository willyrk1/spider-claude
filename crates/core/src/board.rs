//! Spider board state, rules, move generation, and canonical hashing.

use crate::card::*;
use crate::rng::Rng;

pub const COLS: usize = 10;
const FNV_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;

#[inline(always)]
fn fnv(h: u64, byte: u8) -> u64 {
    (h ^ byte as u64).wrapping_mul(FNV_PRIME)
}

/// A single move. `Deal` deals one card from the stock to every column.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Move {
    Tableau { from: u8, to: u8, count: u8 },
    Deal,
}

/// Records a completed K..A run that was removed, so `undo` can put it back.
/// The 13 removed cards are always K,Q,..,A of `suit`, so the suit is all we
/// need to reconstruct them.
#[derive(Clone, Copy)]
pub struct Completion {
    col: u8,
    suit: u8,
    flipped: bool, // whether removing the run flipped a face-down card up
}

/// Everything needed to reverse one `make`, so the search can backtrack in
/// place instead of cloning the board per move.
pub enum Undo {
    Tableau {
        from: u8,
        to: u8,
        count: u8,
        flipped_from: bool,
        completion: Option<Completion>,
    },
    Deal {
        // completions[c] is set if column c completed a run during the deal.
        completions: [Option<Completion>; COLS],
    },
}

#[derive(Clone)]
pub struct Board {
    /// Each column, bottom of the pile at index 0, top (playable end) at the back.
    pub cols: [Vec<Card>; COLS],
    /// Number of face-down cards at the *bottom* of each column.
    pub face_down: [u8; COLS],
    /// Remaining stock; a `Deal` pops 10 cards from the back.
    pub stock: Vec<Card>,
    /// Count of completed K..A suit runs removed from play (win at 8).
    pub completed: u8,
}

impl Board {
    /// Deal a fresh game. `suits` must be 1, 2, or 4.
    pub fn deal(suits: u8, seed: u64) -> Board {
        assert!(matches!(suits, 1 | 2 | 4), "suits must be 1, 2, or 4");
        let copies_per_suit = 8 / suits; // 1->8, 2->4, 4->2  (always 104 cards total)

        let mut deck: Vec<Card> = Vec::with_capacity(104);
        for s in 0..suits {
            for _ in 0..copies_per_suit {
                for r in 1..=13u8 {
                    deck.push(make_card(r, s));
                }
            }
        }
        assert_eq!(deck.len(), 104);

        let mut rng = Rng::new(seed);
        rng.shuffle(&mut deck);

        let mut cols: [Vec<Card>; COLS] = std::array::from_fn(|_| Vec::new());
        let mut face_down = [0u8; COLS];
        let mut idx = 0usize;
        // First 4 columns get 6 cards, remaining 6 columns get 5 cards (54 total).
        for (c, col) in cols.iter_mut().enumerate() {
            let target = if c < 4 { 6 } else { 5 };
            for _ in 0..target {
                col.push(deck[idx]);
                idx += 1;
            }
            face_down[c] = (target - 1) as u8; // only the top card starts face up
        }
        let stock = deck[idx..].to_vec(); // remaining 50 cards
        debug_assert_eq!(stock.len(), 50);

        Board { cols, face_down, stock, completed: 0 }
    }

    #[inline]
    pub fn is_won(&self) -> bool {
        self.completed == 8
    }

    /// Build a partially-known board from what a player can see: for each of the
    /// 10 columns, its face-down count and its face-up cards in bottom→top order.
    /// Face-down cards become `UNKNOWN` sentinels and the stock is left empty (a
    /// partial-information advisor never deals). Validates card codes.
    pub fn from_visible(columns: &[(u8, Vec<Card>)]) -> Result<Board, String> {
        if columns.len() != COLS {
            return Err(format!("expected {COLS} columns, got {}", columns.len()));
        }
        let mut cols: [Vec<Card>; COLS] = std::array::from_fn(|_| Vec::new());
        let mut face_down = [0u8; COLS];
        for (i, (fd, up)) in columns.iter().enumerate() {
            let mut v = Vec::with_capacity(*fd as usize + up.len());
            for _ in 0..*fd {
                v.push(UNKNOWN);
            }
            for &card in up {
                let (r, s) = (rank(card), suit(card));
                if !(1..=13).contains(&r) || s > 3 {
                    return Err(format!("column {i}: invalid card code {card}"));
                }
                v.push(card);
            }
            cols[i] = v;
            face_down[i] = *fd;
        }
        Ok(Board { cols, face_down, stock: Vec::new(), completed: 0 })
    }

    /// Total face-down (unknown) cards remaining — the advisor tries to reduce it.
    pub fn face_down_total(&self) -> u32 {
        self.face_down.iter().map(|&f| f as u32).sum()
    }

    /// Number of empty columns (powerful — they accept any card).
    pub fn empty_columns(&self) -> u32 {
        self.cols.iter().filter(|c| c.is_empty()).count() as u32
    }

    /// Sum of (movable same-suit run length − 1) across columns; rewards
    /// consolidating cards into ordered runs.
    pub fn run_bonus(&self) -> u32 {
        (0..COLS)
            .map(|c| self.movable_run_len(c).saturating_sub(1) as u32)
            .sum()
    }

    /// Length of the maximal same-suit descending run at the top (playable end)
    /// of a column, considering only face-up cards.
    fn movable_run_len(&self, c: usize) -> usize {
        let col = &self.cols[c];
        let n = col.len();
        let fd = self.face_down[c] as usize;
        if n == 0 {
            return 0;
        }
        // An unknown (not-yet-revealed) card can't be moved — it must be turned
        // up in real life first. Never happens in a fully-dealt game.
        if is_unknown(col[n - 1]) {
            return 0;
        }
        let mut len = 1;
        while n - len > fd {
            let upper = col[n - len - 1];
            let lower = col[n - len];
            if suit(upper) == suit(lower) && rank(upper) == rank(lower) + 1 {
                len += 1;
            } else {
                break;
            }
        }
        len
    }

    /// Append all legal moves from this state to `out`.
    pub fn gen_moves(&self, out: &mut Vec<Move>) {
        let first_empty = (0..COLS).find(|&c| self.cols[c].is_empty());

        for from in 0..COLS {
            let n = self.cols[from].len();
            if n == 0 {
                continue;
            }
            let run = self.movable_run_len(from);
            for k in 1..=run {
                let moving_bottom_rank = rank(self.cols[from][n - k]);

                // Onto a non-empty column whose top is one rank higher (any suit).
                for to in 0..COLS {
                    if to == from || self.cols[to].is_empty() {
                        continue;
                    }
                    let top = *self.cols[to].last().unwrap();
                    if rank(top) == moving_bottom_rank + 1 {
                        out.push(Move::Tableau {
                            from: from as u8,
                            to: to as u8,
                            count: k as u8,
                        });
                    }
                }

                // Onto an empty column: consider only ONE empty target (they're
                // interchangeable), and never relocate a whole already-clean pile.
                if let Some(e) = first_empty {
                    if e != from && k != n {
                        out.push(Move::Tableau {
                            from: from as u8,
                            to: e as u8,
                            count: k as u8,
                        });
                    }
                }
            }
        }

        // Dealing is only legal when no column is empty.
        if !self.stock.is_empty() && self.cols.iter().all(|c| !c.is_empty()) {
            out.push(Move::Deal);
        }
    }

    /// Apply a move in place, returning an `Undo` that exactly reverses it.
    /// Assumes the move came from `gen_moves`.
    pub fn make(&mut self, m: Move) -> Undo {
        match m {
            Move::Tableau { from, to, count } => {
                let (f, t, k) = (from as usize, to as usize, count as usize);
                let n = self.cols[f].len();
                // Move the top `k` cards f -> t via a stack buffer (no aliasing,
                // no heap; a run is at most 13 cards).
                let mut buf = [0u8; 13];
                buf[..k].copy_from_slice(&self.cols[f][n - k..n]);
                self.cols[f].truncate(n - k);
                for &card in &buf[..k] {
                    self.cols[t].push(card);
                }
                let flipped_from = self.flip_if_needed(f);
                let completion = self.try_complete(t);
                Undo::Tableau {
                    from,
                    to,
                    count,
                    flipped_from,
                    completion,
                }
            }
            Move::Deal => {
                for c in 0..COLS {
                    let card = self.stock.pop().expect("stock non-empty");
                    self.cols[c].push(card);
                }
                let mut completions = [None; COLS];
                for c in 0..COLS {
                    completions[c] = self.try_complete(c);
                }
                Undo::Deal { completions }
            }
        }
    }

    /// Reverse a previously `make`d move, restoring the exact prior state.
    pub fn undo(&mut self, u: &Undo) {
        match *u {
            Undo::Tableau {
                from,
                to,
                count,
                flipped_from,
                completion,
            } => {
                let (f, t, k) = (from as usize, to as usize, count as usize);
                // Reverse in the opposite order to `make`: completion, then the
                // source flip, then the card transfer.
                if let Some(comp) = completion {
                    self.uncomplete(comp);
                }
                if flipped_from {
                    self.face_down[f] += 1;
                }
                let n = self.cols[t].len();
                let mut buf = [0u8; 13];
                buf[..k].copy_from_slice(&self.cols[t][n - k..n]);
                self.cols[t].truncate(n - k);
                for &card in &buf[..k] {
                    self.cols[f].push(card);
                }
            }
            Undo::Deal { completions } => {
                // Undo completions first (they may have consumed dealt cards),
                // then return one card per column to the stock. Reverse column
                // order so the stock's original order is restored exactly.
                for c in (0..COLS).rev() {
                    if let Some(comp) = completions[c] {
                        self.uncomplete(comp);
                    }
                }
                for c in (0..COLS).rev() {
                    let card = self.cols[c].pop().expect("dealt card present");
                    self.stock.push(card);
                }
            }
        }
    }

    /// If the top card of a column is now face-down, flip it face-up.
    /// Returns whether a flip happened (so `undo` can reverse it).
    #[inline]
    fn flip_if_needed(&mut self, c: usize) -> bool {
        let fd = self.face_down[c] as usize;
        if fd > 0 && self.cols[c].len() == fd {
            self.face_down[c] -= 1;
            true
        } else {
            false
        }
    }

    /// Remove a completed K..A same-suit run from the top of column `c`, if any.
    /// Returns a `Completion` record when a run was removed.
    fn try_complete(&mut self, c: usize) -> Option<Completion> {
        let n = self.cols[c].len();
        if n < 13 {
            return None;
        }
        // The 13 candidate cards must all be face up.
        if (n - 13) < self.face_down[c] as usize {
            return None;
        }
        let s = suit(self.cols[c][n - 13]);
        for i in 0..13 {
            let card = self.cols[c][n - 13 + i];
            if suit(card) != s || rank(card) != (13 - i) as u8 {
                return None;
            }
        }
        self.cols[c].truncate(n - 13);
        self.completed += 1;
        let flipped = self.flip_if_needed(c);
        Some(Completion {
            col: c as u8,
            suit: s,
            flipped,
        })
    }

    /// Reverse a `try_complete`: restore the removed K..A run and any flip.
    fn uncomplete(&mut self, comp: Completion) {
        let c = comp.col as usize;
        if comp.flipped {
            self.face_down[c] += 1;
        }
        // Push K (bottom) down to A (top) to reproduce the removed run.
        for r in (1..=13u8).rev() {
            self.cols[c].push(make_card(r, comp.suit));
        }
        self.completed -= 1;
    }

    /// Canonical hash for the transposition table.
    ///
    /// Columns are hashed independently and then sorted, so states that differ
    /// only by a permutation of columns collapse to the same key — a big win for
    /// Spider, where column identity doesn't matter.
    pub fn hash(&self) -> u64 {
        let mut keys = [0u64; COLS];
        for c in 0..COLS {
            let mut h = FNV_OFFSET;
            h = fnv(h, self.face_down[c]);
            h = fnv(h, 0xFF); // separator between face-down count and cards
            for &card in &self.cols[c] {
                h = fnv(h, card);
            }
            keys[c] = h;
        }
        keys.sort_unstable();

        let mut h = FNV_OFFSET;
        for k in keys {
            for b in k.to_le_bytes() {
                h = fnv(h, b);
            }
        }
        h = fnv(h, self.completed);
        // Remaining stock is fully determined by its length within one game.
        h = fnv(h, self.stock.len() as u8);
        h
    }

    /// A quick text dump of the tableau for the CLI.
    pub fn render(&self) -> String {
        let mut s = String::new();
        for (c, col) in self.cols.iter().enumerate() {
            s.push_str(&format!("{:>2}: ", c));
            let fd = self.face_down[c] as usize;
            for (i, &card) in col.iter().enumerate() {
                if i < fd {
                    s.push_str("[] ");
                } else {
                    s.push_str(&format!("{} ", name(card)));
                }
            }
            s.push('\n');
        }
        s.push_str(&format!(
            "stock: {} cards ({} deals left) | completed runs: {}/8\n",
            self.stock.len(),
            self.stock.len() / COLS,
            self.completed
        ));
        s
    }
}
