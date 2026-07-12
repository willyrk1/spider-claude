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

    /// Length of the maximal same-suit descending run at the top (playable end)
    /// of a column, considering only face-up cards.
    fn movable_run_len(&self, c: usize) -> usize {
        let col = &self.cols[c];
        let n = col.len();
        let fd = self.face_down[c] as usize;
        if n == 0 {
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

    /// Apply a move in place. Assumes the move came from `gen_moves`.
    pub fn apply(&mut self, m: Move) {
        match m {
            Move::Deal => {
                for c in 0..COLS {
                    let card = self.stock.pop().expect("stock non-empty");
                    self.cols[c].push(card);
                }
                for c in 0..COLS {
                    self.check_complete(c);
                }
            }
            Move::Tableau { from, to, count } => {
                let (from, to, count) = (from as usize, to as usize, count as usize);
                let n = self.cols[from].len();
                let moved: Vec<Card> = self.cols[from][n - count..].to_vec();
                self.cols[from].truncate(n - count);
                self.cols[to].extend_from_slice(&moved);
                self.flip_if_needed(from);
                self.check_complete(to);
            }
        }
    }

    /// If the top card of a column is now face-down, flip it face-up.
    #[inline]
    fn flip_if_needed(&mut self, c: usize) {
        let fd = self.face_down[c] as usize;
        if fd > 0 && self.cols[c].len() == fd {
            self.face_down[c] -= 1;
        }
    }

    /// Remove a completed K..A same-suit run from the top of column `c`.
    fn check_complete(&mut self, c: usize) {
        let n = self.cols[c].len();
        if n < 13 {
            return;
        }
        // The 13 candidate cards must all be face up.
        if (n - 13) < self.face_down[c] as usize {
            return;
        }
        let s = suit(self.cols[c][n - 13]);
        for i in 0..13 {
            let card = self.cols[c][n - 13 + i];
            if suit(card) != s || rank(card) != (13 - i) as u8 {
                return;
            }
        }
        self.cols[c].truncate(n - 13);
        self.completed += 1;
        self.flip_if_needed(c);
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
