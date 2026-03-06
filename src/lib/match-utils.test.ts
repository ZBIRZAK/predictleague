import { describe, expect, it } from 'vitest';
import {
  filterMatches,
  getStatusClass,
  getTodayLocalDateInputValue,
  shiftLocalDate,
  type MatchForFiltering
} from './match-utils';

describe('match-utils', () => {
  it('returns local date string for date input', () => {
    const date = new Date(2026, 2, 6, 15, 30, 0);
    expect(getTodayLocalDateInputValue(date)).toBe('2026-03-06');
  });

  it('shifts local date without UTC drift', () => {
    expect(shiftLocalDate('2026-03-06', 1)).toBe('2026-03-07');
    expect(shiftLocalDate('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('filters matches by country and status buckets', () => {
    const matches: MatchForFiltering[] = [
      { status: 'FINISHED', area: { name: 'England' } },
      { status: 'IN_PLAY', area: { name: 'England' } },
      { status: 'TIMED', area: { name: 'Spain' } },
      { status: 'SCHEDULED', area: { name: 'Spain' } }
    ];

    expect(filterMatches(matches, '', 'FINISHED')).toHaveLength(1);
    expect(filterMatches(matches, '', 'LIVE')).toHaveLength(1);
    expect(filterMatches(matches, 'Spain', 'SCHEDULED')).toHaveLength(2);
  });

  it('maps statuses to the correct UI classes', () => {
    expect(getStatusClass('FINISHED')).toBe('status-finished');
    expect(getStatusClass('PAUSED')).toBe('status-live');
    expect(getStatusClass('TIMED')).toBe('status-scheduled');
  });
});
