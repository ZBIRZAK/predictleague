export type StatusFilter = '' | 'LIVE' | 'SCHEDULED' | 'FINISHED';

export type MatchForFiltering = {
  status: string;
  area?: { name?: string };
  competition?: { area?: { name?: string }; name?: string };
};

export function getTodayLocalDateInputValue(now: Date = new Date()) {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function toLocalDateInputValue(utcValue: string) {
  const date = new Date(utcValue);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function shiftLocalDate(base: string, days: number) {
  const [yearStr, monthStr, dayStr] = base.split('-');
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);
  const date = new Date(year, month - 1, day + days);
  return getTodayLocalDateInputValue(date);
}

export function filterMatches<T extends MatchForFiltering>(
  matches: T[],
  selectedCountry: string,
  selectedStatus: StatusFilter
) {
  return matches.filter((match) => {
    const country = match.area?.name ?? match.competition?.area?.name ?? '';

    if (selectedCountry && country !== selectedCountry) {
      return false;
    }

    if (!selectedStatus) {
      return true;
    }

    if (selectedStatus === 'LIVE') {
      return ['LIVE', 'IN_PLAY', 'PAUSED'].includes(match.status);
    }

    if (selectedStatus === 'SCHEDULED') {
      return ['SCHEDULED', 'TIMED'].includes(match.status);
    }

    return match.status === 'FINISHED';
  });
}

export function getStatusClass(status: string) {
  if (status === 'FINISHED') return 'status-finished';
  if (['LIVE', 'IN_PLAY', 'PAUSED'].includes(status)) return 'status-live';
  return 'status-scheduled';
}

export function kickoffTime(value: string) {
  return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}
