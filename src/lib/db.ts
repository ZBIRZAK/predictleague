import { supabase } from './supabase';

export type AppGroup = {
  id: string;
  name: string;
  competition_id: number;
  competition_name: string;
  owner_uid: string;
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
  created_at: string;
};

export type GroupMember = {
  group_id: string;
  user_uid: string;
  email: string;
  role: string;
  created_at: string;
};

function toLowerTrim(value: string) {
  return value.trim().toLowerCase();
}

export async function createGroup(params: {
  ownerUid: string;
  ownerEmail: string;
  name: string;
  competitionId: number;
  competitionName: string;
}) {
  const { data: group, error: groupError } = await supabase
    .from('groups')
    .insert({
      owner_uid: params.ownerUid,
      name: params.name.trim(),
      competition_id: params.competitionId,
      competition_name: params.competitionName
    })
    .select('*')
    .single<AppGroup>();

  if (groupError || !group) {
    throw new Error(groupError?.message ?? 'Failed to create group.');
  }

  const { error: memberError } = await supabase.from('group_members').insert({
    group_id: group.id,
    user_uid: params.ownerUid,
    email: toLowerTrim(params.ownerEmail),
    role: 'owner'
  });

  if (memberError) {
    throw new Error(memberError.message);
  }

  return group;
}

export async function inviteMember(params: {
  groupId: string;
  invitedByUid: string;
  email: string;
}) {
  const normalizedEmail = toLowerTrim(params.email);
  const { error } = await supabase.from('group_invites').upsert(
    {
      group_id: params.groupId,
      invited_by_uid: params.invitedByUid,
      email: normalizedEmail,
      status: 'pending'
    },
    { onConflict: 'group_id,email' }
  );

  if (error) {
    throw new Error(error.message);
  }
}

export async function acceptPendingInvites(params: { userUid: string; userEmail: string }) {
  const normalizedEmail = toLowerTrim(params.userEmail);
  const { data: invites, error: inviteError } = await supabase
    .from('group_invites')
    .select('*')
    .eq('email', normalizedEmail)
    .eq('status', 'pending')
    .returns<GroupInvite[]>();

  if (inviteError) {
    throw new Error(inviteError.message);
  }

  if (!invites || invites.length === 0) {
    return 0;
  }

  for (const invite of invites) {
    const { error: memberError } = await supabase.from('group_members').upsert(
      {
        group_id: invite.group_id,
        user_uid: params.userUid,
        email: normalizedEmail,
        role: 'member'
      },
      { onConflict: 'group_id,user_uid' }
    );

    if (memberError) {
      throw new Error(memberError.message);
    }
  }

  const inviteIds = invites.map((invite) => invite.id);
  const { error: updateError } = await supabase
    .from('group_invites')
    .update({ status: 'accepted', accepted_at: new Date().toISOString() })
    .in('id', inviteIds);

  if (updateError) {
    throw new Error(updateError.message);
  }

  return invites.length;
}

export async function loadGroupsForUser(userUid: string) {
  const { data: memberships, error: membershipError } = await supabase
    .from('group_members')
    .select('group_id')
    .eq('user_uid', userUid);

  if (membershipError) {
    throw new Error(membershipError.message);
  }

  const groupIds = Array.from(new Set((memberships ?? []).map((row) => row.group_id)));
  if (groupIds.length === 0) {
    return [];
  }

  const { data: groups, error: groupError } = await supabase
    .from('groups')
    .select('*')
    .in('id', groupIds)
    .order('created_at', { ascending: false })
    .returns<AppGroup[]>();

  if (groupError) {
    throw new Error(groupError.message);
  }

  return groups ?? [];
}

export async function loadInvitesForGroup(groupId: string) {
  const { data, error } = await supabase
    .from('group_invites')
    .select('*')
    .eq('group_id', groupId)
    .order('created_at', { ascending: false })
    .returns<GroupInvite[]>();

  if (error) {
    throw new Error(error.message);
  }

  return data ?? [];
}

export async function loadPredictionsForUser(params: { groupId: string; userUid: string; matchDate: string }) {
  const { data, error } = await supabase
    .from('predictions')
    .select('*')
    .eq('group_id', params.groupId)
    .eq('user_uid', params.userUid)
    .eq('match_date', params.matchDate)
    .returns<MatchPrediction[]>();

  if (error) {
    throw new Error(error.message);
  }

  return data ?? [];
}

export async function loadPredictionsForGroup(params: { groupId: string; matchDate?: string }) {
  let query = supabase.from('predictions').select('*').eq('group_id', params.groupId);
  if (params.matchDate) {
    query = query.eq('match_date', params.matchDate);
  }

  const { data, error } = await query.returns<MatchPrediction[]>();

  if (error) {
    throw new Error(error.message);
  }

  return data ?? [];
}

export async function loadGroupMembers(groupId: string) {
  const { data, error } = await supabase
    .from('group_members')
    .select('*')
    .eq('group_id', groupId)
    .returns<GroupMember[]>();

  if (error) {
    throw new Error(error.message);
  }

  return data ?? [];
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
}) {
  const { error } = await supabase.from('predictions').upsert(
    {
      group_id: input.groupId,
      user_uid: input.userUid,
      match_id: input.matchId,
      match_date: input.matchDate,
      ht_home: input.htHome,
      ht_away: input.htAway,
      ft_home: input.ftHome,
      ft_away: input.ftAway
    },
    { onConflict: 'group_id,match_id,user_uid' }
  );

  if (error) {
    throw new Error(error.message);
  }
}
