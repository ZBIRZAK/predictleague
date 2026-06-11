export const SERVER_REWARD_TIERS = [
  { id: 'rookie', minPoints: 0, maxBonusPicksPerTeam: 2 },
  { id: 'tactician', minPoints: 20, maxBonusPicksPerTeam: 3 },
  { id: 'strategist', minPoints: 55, maxBonusPicksPerTeam: 4 },
  { id: 'elite', minPoints: 100, maxBonusPicksPerTeam: 5 },
  { id: 'legend', minPoints: 170, maxBonusPicksPerTeam: 5 }
] as const;

export function getBonusPickLimitForPoints(totalPoints: number) {
  const safePoints = Number.isFinite(totalPoints) ? Math.max(0, Math.floor(totalPoints)) : 0;
  for (let i = SERVER_REWARD_TIERS.length - 1; i >= 0; i -= 1) {
    if (safePoints >= SERVER_REWARD_TIERS[i].minPoints) {
      return SERVER_REWARD_TIERS[i].maxBonusPicksPerTeam;
    }
  }
  return SERVER_REWARD_TIERS[0].maxBonusPicksPerTeam;
}
