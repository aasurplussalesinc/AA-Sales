// The two decisions that made AA6645 ship eight lines without moving a number.
//
// Pure, so they can be tested. The failure had no error and no log - the counts
// simply stayed where they were - which is exactly the kind of bug that needs a
// test rather than a careful reading.

// Which shelf the units came off: the picker's explicit choice, else the only
// shelf the item is on, else the item's primary location. Empty means "let the
// caller decide", and removeStockAtLocation falls back to the largest holding.
export function resolvePickLocation(item, options) {
  const opts = Array.isArray(options) ? options : [];
  return (item && item.pickLocation) || (opts.length === 1 ? opts[0].code : (item && item.location)) || '';
}

// Whether the linked order may be stamped stockDeducted.
//
// The flag exists so marking an order shipped cannot deduct the same units a
// second time. It used to be set unconditionally at the end of completing a
// pick list - so a list completed with nothing picked deducted nothing, stamped
// the order anyway, and deductOrderStock then declined to run because the flag
// said the work was done. A guard against double-deduction became a guarantee
// of zero deduction.
//
// Now it is only set when every line that had a picked quantity actually came
// off a shelf. Anything less leaves the order unflagged so the shipping step
// can still deduct it.
export function shouldFlagStockDeducted(linesAttempted, linesDeducted) {
  return linesAttempted > 0 && linesDeducted === linesAttempted;
}
