//! Card encoding.
//!
//! A card is packed into a single byte: `(suit << 4) | rank`.
//! - rank: 1..=13  (Ace = 1, Jack = 11, Queen = 12, King = 13) — fits in 4 bits.
//! - suit: 0..=3   — fits in the next 2 bits.
//!
//! Spider uses two full decks (104 cards). In the 1-suit game every card is the
//! same suit; in the 2-suit game two suits are used; in the 4-suit game all four.
//! Duplicate cards are fine — cards are never distinguished by which deck they
//! came from.

pub type Card = u8;

#[inline(always)]
pub const fn make_card(rank: u8, suit: u8) -> Card {
    (suit << 4) | rank
}

#[inline(always)]
pub const fn rank(c: Card) -> u8 {
    c & 0x0F
}

#[inline(always)]
pub const fn suit(c: Card) -> u8 {
    c >> 4
}

const RANK_NAMES: [&str; 14] = [
    "?", "A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K",
];
const SUIT_NAMES: [&str; 4] = ["♠", "♥", "♣", "♦"];

/// Human-readable card, e.g. "K♠" or "10♥".
pub fn name(c: Card) -> String {
    let r = rank(c) as usize;
    let s = suit(c) as usize;
    format!("{}{}", RANK_NAMES[r], SUIT_NAMES[s])
}
