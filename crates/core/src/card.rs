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

/// Sentinel for a face-down, not-yet-revealed card in a partially-known board
/// (see `Board::from_visible`). It never equals a real card (which are at most
/// `(3 << 4) | 13 = 61`) and the engine treats it as immovable.
pub const UNKNOWN: Card = 0xFF;

#[inline(always)]
pub const fn is_unknown(c: Card) -> bool {
    c == UNKNOWN
}

const RANK_NAMES: [&str; 14] = [
    "?", "A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K",
];
const SUIT_NAMES: [&str; 4] = ["♠", "♥", "♣", "♦"];

/// Human-readable card, e.g. "K♠" or "10♥"; "??" for an unknown card.
pub fn name(c: Card) -> String {
    if is_unknown(c) {
        return "??".to_string();
    }
    let r = rank(c) as usize;
    let s = suit(c) as usize;
    format!("{}{}", RANK_NAMES[r], SUIT_NAMES[s])
}
