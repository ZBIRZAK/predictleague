import { describe, expect, it } from 'vitest';
import {
  SERVER_REWARD_TIERS,
  countCorrectPlayerPicks,
  getBonusPickLimitForPoints,
  isCorrectPlayerPick
} from '../../server/reward-system';
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
    [20, 2],
    [55, 2],
    [100, 2],
    [170, 2]
  ])('allows %i points to save %i picks per team', (points, expectedLimit) => {
    expect(getBonusPickLimitForPoints(points)).toBe(expectedLimit);
  });
});

describe('player-pick scoring', () => {
  const match = {
    homeTeam: { name: 'Mexico', tla: 'MEX' },
    awayTeam: { name: 'South Africa', tla: 'RSA' }
  };

  it('awards one point for every unique correct player pick', () => {
    expect(
      countCorrectPlayerPicks(
        ['HOME::Raúl Jiménez', 'HOME::Julián Quiñones', 'AWAY::Lyle Foster'],
        [
          { player: 'Raul Jimenez', team: 'MEX' },
          { player: 'Julián Quiñones', team: 'Mexico' }
        ],
        match
      )
    ).toBe(2);

    expect(
      countCorrectPlayerPicks(
        ['HOME::Edson Álvarez', 'HOME::César Montes', 'AWAY::Lyle Foster', 'AWAY::Teboho Mokoena'],
        [{ player: 'Teboho Mokoena', team: 'South Africa' }],
        match
      )
    ).toBe(1);

    const totalPoints = 1 + 1 + 2 + 1;
    expect(totalPoints).toBe(5);
  });

  it('does not double-count duplicate picks or repeated incidents for one player', () => {
    expect(
      countCorrectPlayerPicks(
        ['HOME::Raúl Jiménez', 'HOME::Raul Jimenez'],
        [
          { player: 'Raúl Jiménez', team: 'Mexico' },
          { player: 'Raúl Jiménez', team: 'Mexico' }
        ],
        match
      )
    ).toBe(1);
  });

  it('does not award a side-specific pick to the wrong team', () => {
    expect(
      isCorrectPlayerPick(
        'AWAY::Raúl Jiménez',
        [{ player: 'Raúl Jiménez', team: 'Mexico' }],
        match
      )
    ).toBe(false);
  });
});
