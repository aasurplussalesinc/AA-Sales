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

// ---- staging as a pick source (AA Surplus Sales, Alan 2026-10-14) ----------
//
// For AA every pick line can also come from STAGING: units received but not yet
// put on a shelf. Staging is offered as an extra choice, never as a reason to
// demand one, and an item with nothing on any shelf picks from staging on its own.

export const STAGING = 'STAGING';

// The dropdown options with STAGING added (at whatever it holds, else 0).
export function withStagingOption(options) {
  const opts = Array.isArray(options) ? options.slice() : [];
  if (!opts.some(o => String(o.code || '').toUpperCase() === STAGING)) opts.push({ code: STAGING, qty: 0 });
  return opts;
}

// Whether the picker has to choose: more than one place actually holds stock.
// A staging entry at 0 doesn't count, so adding it never blocks a single-shelf pick.
export function needsLocationChoice(options) {
  return (Array.isArray(options) ? options : []).filter(o => (Number(o.qty) || 0) > 0).length > 1;
}

// Where an AA line is picked from: the picker's choice, else the one shelf that
// holds it, else STAGING when no shelf holds any (0 in stock but on the order).
export function resolveStagingAwarePick(item, options) {
  if (item && item.pickLocation) return item.pickLocation;
  const stocked = (Array.isArray(options) ? options : []).filter(o => (Number(o.qty) || 0) > 0);
  if (stocked.length === 1) return stocked[0].code;
  if (stocked.length === 0) return STAGING;
  return (item && item.location) || '';
}
