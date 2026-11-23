import { formatDate, parseDate } from '../shell/commands/time';

it('parses the date strings people pass to date -d', () => {
  const now = Date.UTC(2026, 10, 20, 6, 30, 0);
  expect(parseDate('1 hour ago', now)).toBe(now - 3_600_000);
  expect(parseDate('-30 minutes', now)).toBe(now - 1_800_000);
  expect(parseDate('@1700000000', now)).toBe(1_700_000_000_000);
  expect(parseDate('2026-11-19T00:00:00Z', now)).toBe(Date.UTC(2026, 10, 19));
  expect(formatDate(now, '%Y-%m-%dT%H:%M:%SZ', true)).toBe('2026-11-20T06:30:00Z');
  expect(formatDate(now, '%s', true)).toBe(String(now / 1000));
});
