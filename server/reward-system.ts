export const SERVER_REWARD_TIERS = [
  { id: 'rookie', minPoints: 0, maxBonusPicksPerTeam: 2 },
  { id: 'tactician', minPoints: 20, maxBonusPicksPerTeam: 2 },
  { id: 'strategist', minPoints: 55, maxBonusPicksPerTeam: 2 },
  { id: 'elite', minPoints: 100, maxBonusPicksPerTeam: 2 },
  { id: 'legend', minPoints: 170, maxBonusPicksPerTeam: 2 }
] as const;

export type PlayerPickIncident = {
  player?: string;
  team?: string;
};

export type PlayerPickMatch = {
  homeTeam?: { name?: string; shortName?: string; tla?: string };
  awayTeam?: { name?: string; shortName?: string; tla?: string };
};

function normalizePlayerPickValue(value: string) {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s'-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parsePlayerPick(value: string) {
  if (value.startsWith('HOME::')) return { side: 'home' as const, name: value.slice('HOME::'.length) };
  if (value.startsWith('AWAY::')) return { side: 'away' as const, name: value.slice('AWAY::'.length) };
  return { side: null as 'home' | 'away' | null, name: value };
}

export function isCorrectPlayerPick(
  rawPick: string,
  incidents: PlayerPickIncident[],
  match: PlayerPickMatch
) {
  const parsed = parsePlayerPick(String(rawPick ?? ''));
  const targetPlayer = normalizePlayerPickValue(parsed.name);
  if (!targetPlayer || incidents.length === 0) return false;

  const teamCandidates = (team: PlayerPickMatch['homeTeam']) =>
    [team?.name, team?.shortName, team?.tla]
      .map((value) => normalizePlayerPickValue(String(value ?? '')))
      .filter(Boolean);
  const homeTeams = teamCandidates(match.homeTeam);
  const awayTeams = teamCandidates(match.awayTeam);
  const matchesTeam = (incidentTeam: string, candidates: string[]) =>
    !incidentTeam ||
    candidates.length === 0 ||
    candidates.some(
      (candidate) =>
        incidentTeam === candidate ||
        incidentTeam.includes(candidate) ||
        candidate.includes(incidentTeam)
    );

  return incidents.some((incident) => {
    if (normalizePlayerPickValue(String(incident.player ?? '')) !== targetPlayer) return false;
    const incidentTeam = normalizePlayerPickValue(String(incident.team ?? ''));
    if (parsed.side === 'home' && !matchesTeam(incidentTeam, homeTeams)) return false;
    if (parsed.side === 'away' && !matchesTeam(incidentTeam, awayTeams)) return false;
    return true;
  });
}

export function countCorrectPlayerPicks(
  predicted: string[],
  incidents: PlayerPickIncident[],
  match: PlayerPickMatch
) {
  const matchedPicks = new Set<string>();
  for (const raw of predicted) {
    const parsed = parsePlayerPick(String(raw ?? ''));
    const normalizedName = normalizePlayerPickValue(parsed.name);
    if (!normalizedName || !isCorrectPlayerPick(raw, incidents, match)) continue;
    matchedPicks.add(`${parsed.side ?? 'any'}:${normalizedName}`);
  }
  return matchedPicks.size;
}

export function getBonusPickLimitForPoints(totalPoints: number) {
  const safePoints = Number.isFinite(totalPoints) ? Math.max(0, Math.floor(totalPoints)) : 0;
  for (let i = SERVER_REWARD_TIERS.length - 1; i >= 0; i -= 1) {
    if (safePoints >= SERVER_REWARD_TIERS[i].minPoints) {
      return SERVER_REWARD_TIERS[i].maxBonusPicksPerTeam;
    }
  }
  return SERVER_REWARD_TIERS[0].maxBonusPicksPerTeam;
}
