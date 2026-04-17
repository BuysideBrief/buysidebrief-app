const { findCloseAt } = require('./prices');
const { addDays } = require('./util');

/**
 * Compute forward returns for a buy at entryDate. Uses the next trading day
 * if entry or exit falls on a non-trading day.
 *
 * Returns {
 *   entry: { date, close },
 *   r30: { return, excess, spyReturn, exitDate } | null,
 *   r60: { ... } | null,
 *   r90: { ... } | null,
 *   reason: ... if computation failed
 * }
 */
function computeForwardReturns(tickerBars, spyBars, entryDate, opts = {}) {
  const maxAvailable = opts.maxDate || (tickerBars.length ? tickerBars[tickerBars.length - 1].date : null);

  const entryT = findCloseAt(tickerBars, entryDate, 'next', 7);
  if (!entryT) return { error: 'no-entry-price' };

  const entryS = findCloseAt(spyBars, entryDate, 'next', 7);
  if (!entryS) return { error: 'no-spy-entry-price' };

  const out = { entry: entryT, spyEntry: entryS };

  for (const n of [30, 60, 90]) {
    const targetDate = addDays(entryT.date, n);
    if (maxAvailable && targetDate > maxAvailable) {
      out[`r${n}`] = null;
      out[`r${n}_reason`] = 'window-exceeds-available-data';
      continue;
    }
    const exitT = findCloseAt(tickerBars, targetDate, 'next', 7);
    const exitS = findCloseAt(spyBars, targetDate, 'next', 7);
    if (!exitT || !exitS) {
      out[`r${n}`] = null;
      out[`r${n}_reason`] = 'no-exit-price';
      continue;
    }
    const tickerRet = (exitT.close / entryT.close) - 1;
    const spyRet = (exitS.close / entryS.close) - 1;
    out[`r${n}`] = {
      return: tickerRet,
      spyReturn: spyRet,
      excess: tickerRet - spyRet,
      exitDate: exitT.date,
      exitClose: exitT.close,
    };
  }

  return out;
}

module.exports = { computeForwardReturns };
