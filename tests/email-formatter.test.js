const { getTimingPhrase } = require('../lib/email-formatter');

// Helper: create a filing with a given transaction date
function filing(dateStr) {
  return { transactions: [{ transactionDate: dateStr }] };
}

// Helper: get a Date for a specific day of week relative to a reference
// dayOffset: negative = days before ref
function daysAgo(n, ref) {
  const d = new Date(ref);
  d.setDate(d.getDate() - n);
  return d.toISOString().split('T')[0];
}

describe('getTimingPhrase', () => {
  // Fix "today" to Wednesday 2026-03-25 for deterministic tests
  const wednesday = new Date('2026-03-25T12:00:00');

  test('same day returns "bought"', () => {
    expect(getTimingPhrase(filing('2026-03-25'), wednesday)).toBe('bought');
  });

  test('yesterday returns "bought yesterday"', () => {
    expect(getTimingPhrase(filing('2026-03-24'), wednesday)).toBe('bought yesterday');
  });

  test('Friday trade on Monday email returns "bought on Friday"', () => {
    const monday = new Date('2026-03-23T12:00:00'); // Monday
    // 2026-03-20 is a Friday (3 days before Monday)
    expect(getTimingPhrase(filing('2026-03-20'), monday)).toBe('bought on Friday');
  });

  test('3 days ago on a weekday returns day name', () => {
    // wednesday - 3 = Sunday 2026-03-22
    expect(getTimingPhrase(filing('2026-03-22'), wednesday)).toBe('bought on Sunday');
  });

  test('10 days ago returns "bought on Mon DD"', () => {
    // 10 days before 2026-03-25 = 2026-03-15
    expect(getTimingPhrase(filing('2026-03-15'), wednesday)).toBe('bought on Mar 15');
  });

  test('no transaction date returns "bought"', () => {
    expect(getTimingPhrase({}, wednesday)).toBe('bought');
    expect(getTimingPhrase({ transactions: [] }, wednesday)).toBe('bought');
    expect(getTimingPhrase({ transactions: null }, wednesday)).toBe('bought');
  });

  test('6 days ago returns month format', () => {
    // 6 days before 2026-03-25 = 2026-03-19
    expect(getTimingPhrase(filing('2026-03-19'), wednesday)).toBe('bought on Mar 19');
  });

  test('5 days ago returns day name', () => {
    // 5 days before 2026-03-25 = 2026-03-20 (Friday)
    expect(getTimingPhrase(filing('2026-03-20'), wednesday)).toBe('bought on Friday');
  });
});
