import { firebaseAuth } from './firebase';

export type AppGroup = {
  id: string;
  name: string;
  competition_id: number;
  competition_name: string;
  match_selection_mode: 'competition' | 'custom';
  owner_uid: string;
  prediction_lock_minutes: number;
  bonus_enabled: boolean;
  created_at: string;
};

export type GroupInvite = {
  id: string;
  group_id: string;
  email: string;
  invited_by_uid: string;
  status: 'pending' | 'accepted';
  created_at: string;
  accepted_at: string | null;
};

export type MatchPrediction = {
  id: string;
  group_id: string;
  match_id: number;
  user_uid: string;
  match_date: string;
  ht_home: number;
  ht_away: number;
  ft_home: number;
  ft_away: number;
  goal_players: string[];
  yellow_card_players: string[];
  red_card_players: string[];
  created_at: string;
};

export type GroupMember = {
  group_id: string;
  user_uid: string;
  email: string;
  role: string;
  created_at: string;
};

export type UserProfile = {
  user_uid: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  display_name: string | null;
  country: string | null;
  favorite_team: string | null;
  bio: string | null;
  reminders_enabled: boolean;
  reminder_minutes_before: number;
  weekly_summary_enabled: boolean;
  take_break_until: string | null;
  subscription_tier: 'free' | 'pro';
  subscription_status: string;
  paypal_subscription_id: string | null;
  pro_expires_at: string | null;
  created_at: string;
  updated_at: string;
};

export type BillingStatus = {
  tier: 'free' | 'pro';
  status: string;
  proExpiresAt: string | null;
  paypalSubscriptionId: string | null;
  paypalConfigured: boolean;
  paypalClientId: string | null;
  paypalMode: 'sandbox' | 'live';
};

export type GroupBonusMatch = {
  id: string;
  group_id: string;
  match_id: number;
  label: string;
  multiplier: number;
  active: boolean;
  created_at: string;
};

export type GroupCustomMatch = {
  group_id: string;
  match_id: number;
  match_date: string;
  added_by_uid: string;
  created_at: string;
};

export type LeaderboardEntry = {
  rank: number;
  user_uid: string;
  email: string;
  points: number;
  winner_count: number;
  exact_ht_count: number;
  exact_ft_count: number;
  streak_days: number;
  earliest_submission: string | null;
};

export type GroupLeaderboard = {
  scope: 'total' | 'weekly';
  weekStart: string;
  weekEnd: string;
  leaderboard: LeaderboardEntry[];
  rounds: Array<{ round: number; total_points: number }>;
};

async function authedFetch(path: string, init: RequestInit = {}) {
  const currentUser = firebaseAuth.currentUser;
  if (!currentUser) {
    throw new Error('User is not authenticated.');
  }

  const idToken = await currentUser.getIdToken();
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${idToken}`);
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const response = await fetch(path, {
    ...init,
    headers
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(payload.error ?? `Request failed (${response.status}).`);
  }

  if (response.status === 204) {
    return null;
  }

  return response.json();
}

export async function createGroup(params: {
  ownerUid: string;
  ownerEmail: string;
  name: string;
  competitionId: number;
  competitionName: string;
  matchSelectionMode?: 'competition' | 'custom';
  customMatches?: number[];
  customMatchDate?: string;
}) {
  const payload = (await authedFetch('/internal/db/groups', {
    method: 'POST',
    body: JSON.stringify({
      name: params.name,
      competitionId: params.competitionId,
      competitionName: params.competitionName,
      matchSelectionMode: params.matchSelectionMode ?? 'competition',
      customMatches: params.customMatches ?? [],
      customMatchDate: params.customMatchDate,
      predictionLockMinutes: 5,
      bonusEnabled: false
    })
  })) as { group: AppGroup };

  return payload.group;
}

export async function inviteMember(params: {
  groupId: string;
  invitedByUid: string;
  email: string;
}) {
  await authedFetch('/internal/db/invites', {
    method: 'POST',
    body: JSON.stringify({
      groupId: params.groupId,
      email: params.email
    })
  });
}

export async function acceptPendingInvites(_: { userUid: string; userEmail: string }) {
  const payload = (await authedFetch('/internal/db/invites/accept', {
    method: 'POST'
  })) as { acceptedCount: number };
  return payload.acceptedCount ?? 0;
}

export async function loadGroupsForUser(_: string) {
  const payload = (await authedFetch('/internal/db/groups')) as { groups: AppGroup[] };
  return payload.groups ?? [];
}

export async function deleteGroup(groupId: string) {
  await authedFetch(`/internal/db/groups/${encodeURIComponent(groupId)}`, {
    method: 'DELETE'
  });
}

export async function loadInvitesForGroup(groupId: string) {
  const payload = (await authedFetch(`/internal/db/groups/${encodeURIComponent(groupId)}/invites`)) as {
    invites: GroupInvite[];
  };
  return payload.invites ?? [];
}

export async function loadPredictionsForUser(params: { groupId: string; userUid: string; matchDate: string }) {
  const query = new URLSearchParams({ mine: '1', matchDate: params.matchDate });
  const payload = (await authedFetch(
    `/internal/db/groups/${encodeURIComponent(params.groupId)}/predictions?${query.toString()}`
  )) as { predictions: MatchPrediction[] };
  return payload.predictions ?? [];
}

export async function loadPredictionsForGroup(params: { groupId: string; matchDate?: string }) {
  const query = new URLSearchParams();
  if (params.matchDate) {
    query.set('matchDate', params.matchDate);
  }

  const path = `/internal/db/groups/${encodeURIComponent(params.groupId)}/predictions${
    query.toString() ? `?${query.toString()}` : ''
  }`;
  const payload = (await authedFetch(path)) as { predictions: MatchPrediction[] };
  return payload.predictions ?? [];
}

export async function loadGroupMembers(groupId: string) {
  const payload = (await authedFetch(`/internal/db/groups/${encodeURIComponent(groupId)}/members`)) as {
    members: GroupMember[];
  };
  return payload.members ?? [];
}

export async function savePrediction(input: {
  groupId: string;
  userUid: string;
  matchId: number;
  matchDate: string;
  htHome: number;
  htAway: number;
  ftHome: number;
  ftAway: number;
  goalPlayers?: string[];
  yellowCardPlayers?: string[];
  redCardPlayers?: string[];
}) {
  await authedFetch('/internal/db/predictions', {
    method: 'POST',
    body: JSON.stringify({
      groupId: input.groupId,
      matchId: input.matchId,
      matchDate: input.matchDate,
      htHome: input.htHome,
      htAway: input.htAway,
      ftHome: input.ftHome,
      ftAway: input.ftAway,
      goalPlayers: input.goalPlayers ?? [],
      yellowCardPlayers: input.yellowCardPlayers ?? [],
      redCardPlayers: input.redCardPlayers ?? []
    })
  });
}

export async function loadUserProfile(_: string) {
  const payload = (await authedFetch('/internal/db/profile')) as { profile: UserProfile | null };
  return payload.profile;
}

export async function upsertUserProfile(input: {
  userUid: string;
  email: string;
  firstName?: string;
  lastName?: string;
  displayName?: string;
  country?: string;
  favoriteTeam?: string;
  bio?: string;
  remindersEnabled?: boolean;
  reminderMinutesBefore?: number;
  weeklySummaryEnabled?: boolean;
  takeBreakUntil?: string | null;
}) {
  await authedFetch('/internal/db/profile', {
    method: 'PUT',
    body: JSON.stringify({
      firstName: input.firstName,
      lastName: input.lastName,
      displayName: input.displayName,
      country: input.country,
      favoriteTeam: input.favoriteTeam,
      bio: input.bio,
      remindersEnabled: input.remindersEnabled,
      reminderMinutesBefore: input.reminderMinutesBefore,
      weeklySummaryEnabled: input.weeklySummaryEnabled,
      takeBreakUntil: input.takeBreakUntil
    })
  });
}

export async function updateGroupSettings(params: {
  groupId: string;
  predictionLockMinutes: number;
  bonusEnabled: boolean;
}) {
  const payload = (await authedFetch(`/internal/db/groups/${encodeURIComponent(params.groupId)}/settings`, {
    method: 'PUT',
    body: JSON.stringify({
      predictionLockMinutes: params.predictionLockMinutes,
      bonusEnabled: params.bonusEnabled
    })
  })) as { group: AppGroup };

  return payload.group;
}

export async function loadGroupBonusMatches(groupId: string) {
  const payload = (await authedFetch(`/internal/db/groups/${encodeURIComponent(groupId)}/bonus-matches`)) as {
    bonusMatches: GroupBonusMatch[];
  };
  return payload.bonusMatches ?? [];
}

export async function upsertGroupBonusMatches(
  groupId: string,
  items: Array<{ matchId: number; label?: string; multiplier?: number; active?: boolean }>
) {
  const payload = (await authedFetch(`/internal/db/groups/${encodeURIComponent(groupId)}/bonus-matches`, {
    method: 'PUT',
    body: JSON.stringify({ items })
  })) as { bonusMatches: GroupBonusMatch[] };
  return payload.bonusMatches ?? [];
}

export async function loadGroupCustomMatches(groupId: string, matchDate?: string) {
  const query = new URLSearchParams();
  if (matchDate) {
    query.set('matchDate', matchDate);
  }
  const path = `/internal/db/groups/${encodeURIComponent(groupId)}/custom-matches${query.toString() ? `?${query.toString()}` : ''}`;
  const payload = (await authedFetch(path)) as { customMatches: GroupCustomMatch[] };
  return payload.customMatches ?? [];
}

export async function updateGroupCustomMatches(groupId: string, params: { matchDate: string; matchIds: number[] }) {
  const payload = (await authedFetch(`/internal/db/groups/${encodeURIComponent(groupId)}/custom-matches`, {
    method: 'PUT',
    body: JSON.stringify({
      matchDate: params.matchDate,
      matchIds: params.matchIds
    })
  })) as { customMatches: GroupCustomMatch[] };
  return payload.customMatches ?? [];
}

export async function loadGroupLeaderboard(params: {
  groupId: string;
  scope: 'total' | 'weekly';
  referenceDate?: string;
}) {
  const query = new URLSearchParams({ scope: params.scope });
  if (params.referenceDate) {
    query.set('referenceDate', params.referenceDate);
  }

  const payload = (await authedFetch(
    `/internal/db/groups/${encodeURIComponent(params.groupId)}/leaderboard?${query.toString()}`
  )) as GroupLeaderboard;
  return payload;
}

export async function loadBillingStatus() {
  return (await authedFetch('/internal/billing/status')) as BillingStatus;
}

export async function createPayPalOrder() {
  return (await authedFetch('/internal/billing/paypal/order', { method: 'POST' })) as {
    orderId: string;
    approveUrl: string;
  };
}

export async function capturePayPalOrder(orderId: string) {
  return (await authedFetch('/internal/billing/paypal/capture', {
    method: 'POST',
    body: JSON.stringify({ orderId })
  })) as { ok: boolean; tier: 'pro'; status: string; proExpiresAt: string | null };
}
