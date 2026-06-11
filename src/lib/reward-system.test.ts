import { describe, expect, it } from 'vitest';
import { SERVER_REWARD_TIERS, getBonusPickLimitForPoints } from '../../server/reward-system';
import { REWARD_TIERS } from './reward-system';

describe('reward tier limits', () => {
  it('keeps browser and API bonus-pick limits aligned', () => {
    expect(
      SERVER_REWARD_TIERS.map(({ id, minPoints, maxBonusPicksPerTeam }) => ({
        id,
        minPoints,
        maxBonusPicksPerTeam
      }))
    ).toEqual(
      REWARD_TIERS.map(({ id, minPoints, maxBonusPicksPerTeam }) => ({
        id,
        minPoints,
        maxBonusPicksPerTeam
      }))
    );
  });

  it.each([
    [0, 2],
    [20, 3],
    [55, 4],
    [100, 5],
    [170, 5]
  ])('allows %i points to save %i picks per team', (points, expectedLimit) => {
    expect(getBonusPickLimitForPoints(points)).toBe(expectedLimit);
  });
});
