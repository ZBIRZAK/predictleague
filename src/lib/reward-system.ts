export type RewardTierId = 'rookie' | 'tactician' | 'strategist' | 'elite' | 'legend';

export type RewardTier = {
  id: RewardTierId;
  title: string;
  minPoints: number;
  maxBonusPicksPerTeam: number;
  highlights: string[];
};

export const REWARD_TIERS: RewardTier[] = [
  {
    id: 'rookie',
    title: 'Rookie',
    minPoints: 0,
    maxBonusPicksPerTeam: 2,
    highlights: ['Core HT/FT predictions', '2 bonus picks per team (goals/cards)']
  },
  {
    id: 'tactician',
    title: 'Tactician',
    minPoints: 20,
    maxBonusPicksPerTeam: 3,
    highlights: ['3 bonus picks per team', 'Higher chance to hit event bonuses']
  },
  {
    id: 'strategist',
    title: 'Strategist',
    minPoints: 55,
    maxBonusPicksPerTeam: 4,
    highlights: ['4 bonus picks per team', 'More flexible event prediction combinations']
  },
  {
    id: 'elite',
    title: 'Elite',
    minPoints: 100,
    maxBonusPicksPerTeam: 5,
    highlights: ['5 bonus picks per team', 'Advanced bonus-pick depth']
  },
  {
    id: 'legend',
    title: 'Legend',
    minPoints: 170,
    maxBonusPicksPerTeam: 5,
    highlights: ['Max 5 bonus picks per team', 'Full prediction depth unlocked']
  }
];

export function getRewardTier(totalPoints: number) {
  const safePoints = Number.isFinite(totalPoints) ? Math.max(0, Math.floor(totalPoints)) : 0;
  for (let i = REWARD_TIERS.length - 1; i >= 0; i -= 1) {
    if (safePoints >= REWARD_TIERS[i].minPoints) {
      return REWARD_TIERS[i];
    }
  }
  return REWARD_TIERS[0];
}

export function getRewardProgress(totalPoints: number) {
  const tier = getRewardTier(totalPoints);
  const tierIndex = REWARD_TIERS.findIndex((item) => item.id === tier.id);
  const nextTier = tierIndex >= 0 && tierIndex < REWARD_TIERS.length - 1 ? REWARD_TIERS[tierIndex + 1] : null;
  const safePoints = Number.isFinite(totalPoints) ? Math.max(0, Math.floor(totalPoints)) : 0;
  const pointsIntoTier = safePoints - tier.minPoints;
  const pointsToNext = nextTier ? Math.max(0, nextTier.minPoints - safePoints) : 0;
  const tierSpan = nextTier ? Math.max(1, nextTier.minPoints - tier.minPoints) : 1;
  const progressPct = nextTier ? Math.min(100, Math.max(0, Math.round((pointsIntoTier / tierSpan) * 100))) : 100;

  return {
    tier,
    nextTier,
    totalPoints: safePoints,
    pointsIntoTier,
    pointsToNext,
    progressPct,
    maxBonusPicksPerTeam: tier.maxBonusPicksPerTeam
  };
}
