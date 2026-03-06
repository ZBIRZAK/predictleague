import { useEffect, useMemo, useState } from 'react';
import {
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
  type User
} from 'firebase/auth';
import {
  acceptPendingInvites,
  createGroup,
  loadGroupMembers,
  inviteMember,
  loadGroupsForUser,
  loadInvitesForGroup,
  loadPredictionsForGroup,
  savePrediction,
  type AppGroup,
  type GroupMember,
  type GroupInvite,
  type MatchPrediction
} from './lib/db';
import { firebaseAuth } from './lib/firebase';
import {
  filterMatches,
  getStatusClass,
  getTodayLocalDateInputValue,
  kickoffTime,
  shiftLocalDate,
  toLocalDateInputValue,
  type StatusFilter
} from './lib/match-utils';

type Competition = {
  id: number;
  name: string;
  area?: { name?: string };
};

type Team = {
  id?: number;
  name: string;
  shortName?: string;
  tla?: string;
  crest?: string;
  venue?: string;
  founded?: number;
  coach?: { name?: string; nationality?: string };
};

type Score = {
  winner?: 'HOME_TEAM' | 'AWAY_TEAM' | 'DRAW' | null;
  halfTime?: { home?: number | null; away?: number | null };
  fullTime?: { home?: number | null; away?: number | null };
};

type Match = {
  id: number;
  utcDate: string;
  status: string;
  homeTeam: Team;
  awayTeam: Team;
  score?: Score;
  competition?: Competition;
  area?: { name?: string };
  venue?: string;
  matchday?: number;
  stage?: string;
  group?: string | null;
  referees?: Array<{ id?: number; name?: string; type?: string; nationality?: string }>;
};

type CompetitionResponse = {
  competitions: Competition[];
};

type MatchListResponse = {
  matches: Match[];
};

type StandingRow = {
  position: number;
  team: { id: number; name: string; shortName?: string; tla?: string };
  playedGames: number;
  won: number;
  draw: number;
  lost: number;
  points: number;
  goalsFor: number;
  goalsAgainst: number;
  goalDifference: number;
};

type StandingsResponse = {
  standings?: Array<{
    type?: string;
    table?: StandingRow[];
  }>;
};

type TopScorer = {
  player?: { id?: number; name?: string };
  team?: { id?: number; name?: string; shortName?: string; tla?: string };
  playedMatches?: number;
  goals?: number;
  assists?: number;
  penalties?: number;
};

type TopScorersResponse = {
  scorers?: TopScorer[];
};

type TeamPlayer = {
  id?: number;
  name?: string;
  position?: string;
  nationality?: string;
  dateOfBirth?: string;
};

type TeamDetails = Team & {
  squad?: TeamPlayer[];
};

type PredictionDraft = {
  htHome: string;
  htAway: string;
  ftHome: string;
  ftAway: string;
};

type AppPage = 'home' | 'game';

const statuses: Array<{ label: string; value: StatusFilter }> = [
  { label: 'All', value: '' },
  { label: 'Live', value: 'LIVE' },
  { label: 'Scheduled', value: 'SCHEDULED' },
  { label: 'Finished', value: 'FINISHED' }
];

function getPageFromHash(hash: string): AppPage {
  return hash === '#/game' ? 'game' : 'home';
}

function formatSeasonLabel(startYear: string) {
  const start = Number(startYear);
  if (!Number.isFinite(start)) {
    return startYear;
  }

  const end = start + 1;
  const shortStart = String(start).slice(-2).padStart(2, '0');
  const shortEnd = String(end).slice(-2).padStart(2, '0');
  return `${start}/${end} (${shortStart}/${shortEnd})`;
}

function getCurrentSeasonStartYear(now: Date = new Date()) {
  const year = now.getFullYear();
  const month = now.getMonth();
  return month >= 6 ? year : year - 1;
}

function App() {
  const today = useMemo(() => getTodayLocalDateInputValue(), []);
  const [page, setPage] = useState<AppPage>(() => getPageFromHash(window.location.hash));

  const [authReady, setAuthReady] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [authLoading, setAuthLoading] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const [competitions, setCompetitions] = useState<Competition[]>([]);
  const [publicMatches, setPublicMatches] = useState<Match[]>([]);
  const [publicMatchesLoading, setPublicMatchesLoading] = useState(false);
  const [publicDate, setPublicDate] = useState(today);
  const [publicCompetitionId, setPublicCompetitionId] = useState('');
  const [publicCountry, setPublicCountry] = useState('');
  const [publicStatus, setPublicStatus] = useState<StatusFilter>('');
  const [standings, setStandings] = useState<StandingRow[]>([]);
  const [standingsLoading, setStandingsLoading] = useState(false);
  const [standingsCompetitionId, setStandingsCompetitionId] = useState('');
  const [standingsSeason, setStandingsSeason] = useState(String(getCurrentSeasonStartYear()));
  const [standingsMatchday, setStandingsMatchday] = useState('');
  const [topScorers, setTopScorers] = useState<TopScorer[]>([]);
  const [topScorersLoading, setTopScorersLoading] = useState(false);
  const [topScorersError, setTopScorersError] = useState('');
  const [topScorersLimit, setTopScorersLimit] = useState('10');
  const [activeMatchDetails, setActiveMatchDetails] = useState<Match | null>(null);
  const [matchDetailsOpen, setMatchDetailsOpen] = useState(false);
  const [matchDetailsLoading, setMatchDetailsLoading] = useState(false);
  const [matchDetailsError, setMatchDetailsError] = useState('');
  const [teamDetailsById, setTeamDetailsById] = useState<Record<number, TeamDetails>>({});
  const [teamDetailsLoading, setTeamDetailsLoading] = useState(false);

  const [groups, setGroups] = useState<AppGroup[]>([]);
  const [selectedGroupId, setSelectedGroupId] = useState('');
  const [invites, setInvites] = useState<GroupInvite[]>([]);
  const [groupMembers, setGroupMembers] = useState<GroupMember[]>([]);
  const [groupMatches, setGroupMatches] = useState<Match[]>([]);
  const [myPredictions, setMyPredictions] = useState<Record<number, MatchPrediction>>({});
  const [groupPredictionsByMatch, setGroupPredictionsByMatch] = useState<Record<number, MatchPrediction[]>>({});
  const [allGroupPredictions, setAllGroupPredictions] = useState<MatchPrediction[]>([]);
  const [matchResultsById, setMatchResultsById] = useState<Record<number, Match>>({});
  const [predictionDrafts, setPredictionDrafts] = useState<Record<number, PredictionDraft>>({});

  const [newGroupName, setNewGroupName] = useState('');
  const [newGroupCompetitionId, setNewGroupCompetitionId] = useState('');
  const [inviteEmail, setInviteEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [savingAll, setSavingAll] = useState(false);
  const [groupMatchesLoading, setGroupMatchesLoading] = useState(false);

  const selectedGroup = useMemo(
    () => groups.find((group) => group.id === selectedGroupId) ?? null,
    [groups, selectedGroupId]
  );
  const groupMatchMap = useMemo(() => new Map(groupMatches.map((match) => [match.id, match])), [groupMatches]);

  const publicCountries = useMemo(() => {
    return Array.from(
      new Set(
        publicMatches
          .map((match) => match.area?.name ?? match.competition?.area?.name)
          .filter((name): name is string => Boolean(name))
      )
    ).sort((a, b) => a.localeCompare(b));
  }, [publicMatches]);

  const filteredPublicMatches = useMemo(
    () => filterMatches(publicMatches, publicCountry, publicStatus),
    [publicMatches, publicCountry, publicStatus]
  );

  const groupedPublicMatches = useMemo(() => {
    const groupsMap = new Map<string, Match[]>();
    for (const match of filteredPublicMatches) {
      const key = `${match.competition?.name ?? 'Unknown competition'}|||${match.area?.name ??
        match.competition?.area?.name ??
        'Unknown country'}`;
      const bucket = groupsMap.get(key) ?? [];
      bucket.push(match);
      groupsMap.set(key, bucket);
    }

    return Array.from(groupsMap.entries()).map(([key, matches]) => {
      const [competitionName, countryName] = key.split('|||');
      return { competitionName, countryName, matches };
    });
  }, [filteredPublicMatches]);

  const standingsYears = useMemo(() => {
    const currentSeasonStart = getCurrentSeasonStartYear();
    return Array.from({ length: 12 }, (_, index) => String(currentSeasonStart - index));
  }, []);

  const groupLeaderboard = useMemo(() => {
    const totals: Record<string, number> = {};
    for (const member of groupMembers) {
      totals[member.user_uid] = 0;
    }

    for (const prediction of allGroupPredictions) {
      const match = matchResultsById[prediction.match_id] ?? groupMatchMap.get(prediction.match_id);
      if (!match) continue;
      const points = calculatePredictionPoints(match, prediction);
      if (!points.ready) continue;
      totals[prediction.user_uid] = (totals[prediction.user_uid] ?? 0) + points.total;
    }

    return groupMembers
      .map((member) => ({
        userUid: member.user_uid,
        email: member.email,
        points: totals[member.user_uid] ?? 0
      }))
      .sort((a, b) => b.points - a.points);
  }, [allGroupPredictions, groupMembers, groupMatchMap, matchResultsById]);

  const completedDraftCount = useMemo(() => {
    let total = 0;
    for (const match of groupMatches) {
      const draft = predictionDrafts[match.id];
      if (!draft) continue;
      if ([draft.htHome, draft.htAway, draft.ftHome, draft.ftAway].every((value) => value !== '')) {
        total += 1;
      }
    }
    return total;
  }, [groupMatches, predictionDrafts]);

  useEffect(() => {
    const onHashChange = () => {
      setPage(getPageFromHash(window.location.hash));
    };

    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  useEffect(() => {
    return onAuthStateChanged(firebaseAuth, (nextUser) => {
      setUser(nextUser);
      setAuthReady(true);
    });
  }, []);

  useEffect(() => {
    void loadCompetitions();
  }, []);

  useEffect(() => {
    if (!standingsCompetitionId && competitions.length > 0) {
      setStandingsCompetitionId(String(competitions[0].id));
    }
  }, [competitions, standingsCompetitionId]);

  useEffect(() => {
    void loadPublicMatches();
  }, [publicDate, publicCompetitionId, publicStatus]);

  useEffect(() => {
    if (!standingsCompetitionId) {
      setStandings([]);
      setTopScorers([]);
      setTopScorersError('');
      return;
    }

    void loadStandings(standingsCompetitionId, standingsSeason, standingsMatchday);
    void loadTopScorers(standingsCompetitionId, standingsSeason, topScorersLimit);
  }, [standingsCompetitionId, standingsSeason, standingsMatchday, topScorersLimit]);

  useEffect(() => {
    if (!user) {
      setGroups([]);
      setSelectedGroupId('');
      return;
    }

    void bootstrapForUser(user);
  }, [user]);

  useEffect(() => {
    if (!user || !selectedGroup) {
      setGroupMatches([]);
      setMyPredictions({});
      setGroupPredictionsByMatch({});
      setAllGroupPredictions([]);
      setMatchResultsById({});
      setGroupMembers([]);
      return;
    }

    void loadGroupData(user.uid, selectedGroup);
  }, [selectedGroup, user, today]);

  async function loadCompetitions() {
    try {
      const response = await fetch('/api/v4/competitions');
      if (!response.ok) {
        throw new Error('Failed to fetch competitions.');
      }

      const payload = (await response.json()) as CompetitionResponse;
      setCompetitions((payload.competitions ?? []).sort((a, b) => a.name.localeCompare(b.name)));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch competitions.');
    }
  }

  async function loadPublicMatches() {
    try {
      setPublicMatchesLoading(true);
      setError('');

      const query = new URLSearchParams({
        dateFrom: shiftLocalDate(publicDate, -1),
        dateTo: shiftLocalDate(publicDate, 1)
      });
      if (publicStatus === 'FINISHED') {
        query.set('status', 'FINISHED');
      }

      const path = publicCompetitionId ? `/api/v4/competitions/${publicCompetitionId}/matches` : '/api/v4/matches';
      const response = await fetch(`${path}?${query.toString()}`);
      if (!response.ok) {
        throw new Error('Failed to load home matches.');
      }

      const payload = (await response.json()) as MatchListResponse;
      setPublicMatches((payload.matches ?? []).filter((match) => toLocalDateInputValue(match.utcDate) === publicDate));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load home matches.');
    } finally {
      setPublicMatchesLoading(false);
    }
  }

  async function loadStandings(competitionId: string, season: string, matchday: string) {
    try {
      setStandingsLoading(true);
      setError('');
      const query = new URLSearchParams();
      if (season) {
        query.set('season', season);
      }
      if (matchday) {
        query.set('matchday', matchday);
      }

      const response = await fetch(
        `/api/v4/competitions/${competitionId}/standings${query.toString() ? `?${query.toString()}` : ''}`
      );
      if (!response.ok) {
        throw new Error('Failed to load standings for this competition.');
      }

      const payload = (await response.json()) as StandingsResponse;
      const totalTable = payload.standings?.find((item) => item.type === 'TOTAL')?.table;
      setStandings(totalTable ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load standings.');
      setStandings([]);
    } finally {
      setStandingsLoading(false);
    }
  }

  async function loadTopScorers(competitionId: string, season: string, limit: string) {
    try {
      setTopScorersLoading(true);
      setTopScorersError('');
      const query = new URLSearchParams();
      if (season) {
        query.set('season', season);
      }
      if (limit) {
        query.set('limit', limit);
      }

      const response = await fetch(
        `/api/v4/competitions/${competitionId}/scorers${query.toString() ? `?${query.toString()}` : ''}`
      );
      if (!response.ok) {
        throw new Error('Failed to load top scorers for this competition.');
      }

      const payload = (await response.json()) as TopScorersResponse;
      setTopScorers(payload.scorers ?? []);
    } catch (err) {
      setTopScorers([]);
      setTopScorersError(err instanceof Error ? err.message : 'Failed to load top scorers.');
    } finally {
      setTopScorersLoading(false);
    }
  }

  async function bootstrapForUser(currentUser: User) {
    try {
      setBusy(true);
      setError('');
      setMessage('');

      if (currentUser.email) {
        const acceptedCount = await acceptPendingInvites({
          userUid: currentUser.uid,
          userEmail: currentUser.email
        });
        if (acceptedCount > 0) {
          setMessage(`You joined ${acceptedCount} invited group(s).`);
        }
      }

      const nextGroups = await loadGroupsForUser(currentUser.uid);
      setGroups(nextGroups);
      setSelectedGroupId((prev) => prev || nextGroups[0]?.id || '');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to initialize user data.');
    } finally {
      setBusy(false);
    }
  }

  async function loadMatchesForCompetition(competitionId: number, targetDate: string) {
    const query = new URLSearchParams({ dateFrom: targetDate, dateTo: targetDate });
    const response = await fetch(`/api/v4/competitions/${competitionId}/matches?${query.toString()}`);
    if (!response.ok) {
      throw new Error('Failed to fetch today matches.');
    }

    const payload = (await response.json()) as MatchListResponse;
    return (payload.matches ?? []).filter((match) => toLocalDateInputValue(match.utcDate) === targetDate);
  }

  async function loadMatchById(matchId: number) {
    const response = await fetch(`/api/v4/matches/${matchId}`);
    if (!response.ok) {
      return null;
    }
    const payload = (await response.json()) as { match?: Match } & Match;
    return payload.match ?? payload;
  }

  async function loadTeamById(teamId: number) {
    const response = await fetch(`/api/v4/teams/${teamId}`);
    if (!response.ok) {
      return null;
    }
    const payload = (await response.json()) as { team?: TeamDetails } & TeamDetails;
    return payload.team ?? payload;
  }

  async function openMatchDetails(match: Match) {
    setMatchDetailsOpen(true);
    setMatchDetailsError('');
    setActiveMatchDetails(match);
    try {
      setMatchDetailsLoading(true);
      const fullMatch = await loadMatchById(match.id);
      if (!fullMatch) {
        setMatchDetailsError('Could not load full match details.');
        return;
      }
      setActiveMatchDetails(fullMatch);

      const teamIds = [fullMatch.homeTeam.id, fullMatch.awayTeam.id].filter((id): id is number => typeof id === 'number');
      const missingTeamIds = teamIds.filter((teamId) => !teamDetailsById[teamId]);
      if (missingTeamIds.length > 0) {
        setTeamDetailsLoading(true);
        const teamEntries = await Promise.all(
          missingTeamIds.map(async (teamId) => {
            const teamDetails = await loadTeamById(teamId);
            return [teamId, teamDetails] as const;
          })
        );
        const nextMap: Record<number, TeamDetails> = {};
        for (const [teamId, teamDetails] of teamEntries) {
          if (teamDetails) {
            nextMap[teamId] = teamDetails;
          }
        }
        setTeamDetailsById((prev) => ({ ...prev, ...nextMap }));
      }
    } catch (err) {
      setMatchDetailsError(err instanceof Error ? err.message : 'Failed to load match details.');
    } finally {
      setMatchDetailsLoading(false);
      setTeamDetailsLoading(false);
    }
  }

  function closeMatchDetails() {
    setMatchDetailsOpen(false);
    setMatchDetailsLoading(false);
    setMatchDetailsError('');
  }

  async function refreshTotalLeaderboardData(groupId: string) {
    const allPredictions = await loadPredictionsForGroup({ groupId });
    setAllGroupPredictions(allPredictions);

    const matchIds = Array.from(new Set(allPredictions.map((item) => item.match_id)));
    if (matchIds.length === 0) {
      setMatchResultsById({});
      return;
    }

    const entries = await Promise.all(
      matchIds.map(async (matchId) => {
        const match = await loadMatchById(matchId);
        return [matchId, match] as const;
      })
    );

    const map: Record<number, Match> = {};
    for (const [matchId, match] of entries) {
      if (match) {
        map[matchId] = match;
      }
    }
    setMatchResultsById(map);
  }

  async function loadGroupData(userUid: string, group: AppGroup) {
    try {
      setGroupMatchesLoading(true);
      setError('');

      const [inviteRows, predictionRows, memberRows, matchRows] = await Promise.all([
        loadInvitesForGroup(group.id),
        loadPredictionsForGroup({ groupId: group.id, matchDate: today }),
        loadGroupMembers(group.id),
        loadMatchesForCompetition(group.competition_id, today)
      ]);

      setInvites(inviteRows);
      setGroupMembers(memberRows);
      setGroupMatches(matchRows);

      const mine = predictionRows.filter((row) => row.user_uid === userUid);
      const mineMap = Object.fromEntries(mine.map((row) => [row.match_id, row]));
      setMyPredictions(mineMap);

      const byMatch: Record<number, MatchPrediction[]> = {};
      for (const row of predictionRows) {
        byMatch[row.match_id] = byMatch[row.match_id] ?? [];
        byMatch[row.match_id].push(row);
      }
      setGroupPredictionsByMatch(byMatch);

      const nextDrafts: Record<number, PredictionDraft> = {};
      for (const match of matchRows) {
        const prediction = mineMap[match.id];
        nextDrafts[match.id] = {
          htHome: prediction ? String(prediction.ht_home) : '',
          htAway: prediction ? String(prediction.ht_away) : '',
          ftHome: prediction ? String(prediction.ft_home) : '',
          ftAway: prediction ? String(prediction.ft_away) : ''
        };
      }
      setPredictionDrafts(nextDrafts);
      await refreshTotalLeaderboardData(group.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load group data.');
    } finally {
      setGroupMatchesLoading(false);
    }
  }

  async function handleRegister() {
    try {
      setAuthLoading(true);
      setError('');
      setMessage('');
      await createUserWithEmailAndPassword(firebaseAuth, email.trim(), password);
      setMessage('Account created. You are signed in.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Registration failed.');
    } finally {
      setAuthLoading(false);
    }
  }

  async function handleLogin() {
    try {
      setAuthLoading(true);
      setError('');
      setMessage('');
      await signInWithEmailAndPassword(firebaseAuth, email.trim(), password);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed.');
    } finally {
      setAuthLoading(false);
    }
  }

  async function handleLogout() {
    try {
      setError('');
      setMessage('');
      await signOut(firebaseAuth);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Logout failed.');
    }
  }

  async function handleCreateGroup() {
    if (!user?.email) {
      setError('Login with a valid email account.');
      return;
    }

    const selectedCompetition = competitions.find((item) => String(item.id) === newGroupCompetitionId);
    if (!newGroupName.trim() || !selectedCompetition) {
      setError('Group name and competition are required.');
      return;
    }

    try {
      setBusy(true);
      setError('');
      const group = await createGroup({
        ownerUid: user.uid,
        ownerEmail: user.email,
        name: newGroupName,
        competitionId: selectedCompetition.id,
        competitionName: selectedCompetition.name
      });

      setGroups((prev) => [group, ...prev]);
      setSelectedGroupId(group.id);
      setNewGroupName('');
      setNewGroupCompetitionId('');
      setMessage('Group created.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create group.');
    } finally {
      setBusy(false);
    }
  }

  async function handleInvite() {
    if (!user || !selectedGroup) {
      return;
    }

    if (!inviteEmail.trim()) {
      setError('Email is required.');
      return;
    }

    try {
      setBusy(true);
      setError('');
      await inviteMember({
        groupId: selectedGroup.id,
        invitedByUid: user.uid,
        email: inviteEmail
      });

      const emailResponse = await fetch('/internal/invite-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          toEmail: inviteEmail.trim(),
          groupName: selectedGroup.name,
          inviterEmail: user.email ?? ''
        })
      });
      if (!emailResponse.ok) {
        const payload = (await emailResponse.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error ?? 'Invite was saved, but failed to send email.');
      }
      const emailPayload = (await emailResponse.json().catch(() => ({}))) as {
        accepted?: string[];
        rejected?: string[];
      };

      setInviteEmail('');
      const acceptedCount = emailPayload.accepted?.length ?? 0;
      const rejectedCount = emailPayload.rejected?.length ?? 0;
      setMessage(
        `Invite saved. Email status: accepted ${acceptedCount}, rejected ${rejectedCount}. User joins automatically when signing in with that email.`
      );
      const nextInvites = await loadInvitesForGroup(selectedGroup.id);
      setInvites(nextInvites);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to invite member.');
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveAllPredictions() {
    if (!user || !selectedGroup) {
      return;
    }

    const payloads: Array<{
      groupId: string;
      userUid: string;
      matchId: number;
      matchDate: string;
      htHome: number;
      htAway: number;
      ftHome: number;
      ftAway: number;
    }> = [];

    for (const match of groupMatches) {
      const draft = predictionDrafts[match.id];
      if (!draft) continue;

      const values = [draft.htHome, draft.htAway, draft.ftHome, draft.ftAway];
      if (values.some((value) => value === '')) {
        continue;
      }

      const numeric = values.map((value) => Number(value));
      if (numeric.some((value) => Number.isNaN(value) || value < 0)) {
        setError('One or more predictions are invalid. Use numbers >= 0.');
        return;
      }

      payloads.push({
        groupId: selectedGroup.id,
        userUid: user.uid,
        matchId: match.id,
        matchDate: today,
        htHome: numeric[0],
        htAway: numeric[1],
        ftHome: numeric[2],
        ftAway: numeric[3]
      });
    }

    if (payloads.length === 0) {
      setError('No completed predictions to save. Fill HT and FT first.');
      return;
    }

    try {
      setSavingAll(true);
      setError('');

      await Promise.all(payloads.map((payload) => savePrediction(payload)));

      const latest = await loadPredictionsForGroup({
        groupId: selectedGroup.id,
        matchDate: today
      });

      const mine = latest.filter((row) => row.user_uid === user.uid);
      setMyPredictions(Object.fromEntries(mine.map((row) => [row.match_id, row])));

      const byMatch: Record<number, MatchPrediction[]> = {};
      for (const row of latest) {
        byMatch[row.match_id] = byMatch[row.match_id] ?? [];
        byMatch[row.match_id].push(row);
      }
      setGroupPredictionsByMatch(byMatch);
      await refreshTotalLeaderboardData(selectedGroup.id);
      setMessage(`Saved ${payloads.length} prediction(s).`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save all predictions.');
    } finally {
      setSavingAll(false);
    }
  }

  function goToPage(nextPage: AppPage) {
    const nextHash = nextPage === 'game' ? '#/game' : '#/';
    if (window.location.hash !== nextHash) {
      window.location.hash = nextHash;
    }
    setPage(nextPage);
  }

  if (!authReady) {
    return (
      <div className="app">
        <main className="layout">
          <p>Loading authentication...</p>
        </main>
      </div>
    );
  }

  const headerContextLabel = page === 'home' ? 'Home Matches' : 'Game';

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-inner">
          <div className="topbar-brand">
            <span className="brand-mark" aria-hidden="true">
              PL
            </span>
            <div className="topbar-meta">
              <h1 className="topbar-title">PredictLeague</h1>
              <span className="topbar-sub">{headerContextLabel}</span>
            </div>
          </div>

          <nav className="topbar-nav" aria-label="Primary">
            <button
              type="button"
              className={`chip ${page === 'home' ? 'chip-active' : ''}`}
              onClick={() => goToPage('home')}
            >
              Home Matches
            </button>
            <button
              type="button"
              className={`chip ${page === 'game' ? 'chip-active' : ''}`}
              onClick={() => goToPage('game')}
            >
              Game
            </button>
          </nav>

          <div className="topbar-action">
            <span className="topbar-context">{user ? user.email : 'Guest mode'}</span>
            {user ? (
              <button type="button" className="details-btn" onClick={() => void handleLogout()}>
                Logout
              </button>
            ) : null}
          </div>
        </div>
      </header>

      <main className="layout">
        {page === 'home' ? (
          <section className="home-grid">
            <div className="home-main">
              <section className="filter-panel">
                <h2>Home Matches</h2>
                <div className="date-box">
                  <span className="box-label">Date</span>
                  <input type="date" value={publicDate} onChange={(e) => setPublicDate(e.target.value)} />
                </div>
                <div className="quick-status">
                  {statuses.map((status) => (
                    <button
                      type="button"
                      key={status.value || 'all'}
                      className={`chip ${publicStatus === status.value ? 'chip-active' : ''}`}
                      onClick={() => setPublicStatus(status.value)}
                    >
                      {status.label}
                    </button>
                  ))}
                </div>
                <div className="selectors">
                  <label>
                    Competition
                    <select value={publicCompetitionId} onChange={(e) => setPublicCompetitionId(e.target.value)}>
                      <option value="">All competitions</option>
                      {competitions.map((competition) => (
                        <option key={competition.id} value={competition.id}>
                          {competition.name} ({competition.area?.name ?? 'Unknown'})
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Country
                    <select value={publicCountry} onChange={(e) => setPublicCountry(e.target.value)}>
                      <option value="">All countries</option>
                      {publicCountries.map((country) => (
                        <option key={country} value={country}>
                          {country}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button type="button" className="refresh" onClick={() => void loadPublicMatches()}>
                    Refresh
                  </button>
                </div>
              </section>

              <section className="scoreboard">
                <div className="scoreboard-head">
                  <strong>{filteredPublicMatches.length} Matches</strong>
                  <span>{publicMatchesLoading ? 'Loading...' : 'Updated'}</span>
                </div>
                {groupedPublicMatches.length === 0 && !publicMatchesLoading ? (
                  <article className="league-card empty">No matches found for these filters.</article>
                ) : null}
                {groupedPublicMatches.map((group) => (
                  <article className="league-card" key={`${group.competitionName}-${group.countryName}`}>
                    <header className="league-head">
                      <div>
                        <h2>{group.competitionName}</h2>
                        <p>{group.countryName}</p>
                      </div>
                    </header>
                    <div className="match-list">
                      {group.matches.map((match) => (
                        <div
                          className="match-row match-row-clickable"
                          key={match.id}
                          role="button"
                          tabIndex={0}
                          onClick={() => void openMatchDetails(match)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault();
                              void openMatchDetails(match);
                            }
                          }}
                        >
                          <div className="match-time">
                            <span className={`status-dot ${getStatusClass(match.status)}`} />
                            <span>{match.status === 'TIMED' ? kickoffTime(match.utcDate) : match.status}</span>
                          </div>
                          <div
                            className="teams-col match-row-clickable"
                            role="button"
                            tabIndex={0}
                            onClick={() => void openMatchDetails(match)}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter' || event.key === ' ') {
                                event.preventDefault();
                                void openMatchDetails(match);
                              }
                            }}
                          >
                            <div className="team-line">
                              <span className="team-name">{match.homeTeam.name}</span>
                              <strong className="team-score">{match.score?.fullTime?.home ?? '-'}</strong>
                            </div>
                            <div className="team-line">
                              <span className="team-name">{match.awayTeam.name}</span>
                              <strong className="team-score">{match.score?.fullTime?.away ?? '-'}</strong>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </article>
                ))}
              </section>
            </div>

            <aside className="home-side">
              <section className="filter-panel">
                <h2>Classification</h2>
                <div className="selectors">
                  <label>
                    Competition
                    <select value={standingsCompetitionId} onChange={(e) => setStandingsCompetitionId(e.target.value)}>
                      <option value="">Select competition</option>
                      {competitions.map((competition) => (
                        <option key={competition.id} value={competition.id}>
                          {competition.name} ({competition.area?.name ?? 'Unknown'})
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Season
                    <select value={standingsSeason} onChange={(e) => setStandingsSeason(e.target.value)}>
                      {standingsYears.map((year) => (
                        <option key={year} value={year}>
                          {formatSeasonLabel(year)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Matchday
                    <input
                      type="number"
                      min={1}
                      value={standingsMatchday}
                      onChange={(e) => setStandingsMatchday(e.target.value)}
                      placeholder="All"
                    />
                  </label>
                </div>
                {!standingsCompetitionId ? (
                  <p className="muted">Select a competition to view standings.</p>
                ) : null}
                {standingsCompetitionId && standingsLoading ? <p className="muted">Loading standings...</p> : null}
                {standingsCompetitionId && !standingsLoading && standings.length === 0 ? (
                  <p className="muted">No standings available for this competition and season.</p>
                ) : null}
                {standings.length > 0 ? (
                  <div className="standings-wrap">
                    <table className="standings-table">
                      <thead>
                        <tr>
                          <th>#</th>
                          <th>Team</th>
                          <th>P</th>
                          <th>W</th>
                          <th>D</th>
                          <th>L</th>
                          <th>GF</th>
                          <th>GA</th>
                          <th>GD</th>
                          <th>Pts</th>
                        </tr>
                      </thead>
                      <tbody>
                        {standings.map((row) => (
                          <tr key={row.team.id}>
                            <td>{row.position}</td>
                            <td>{row.team.shortName ?? row.team.name}</td>
                            <td>{row.playedGames}</td>
                            <td>{row.won}</td>
                            <td>{row.draw}</td>
                            <td>{row.lost}</td>
                            <td>{row.goalsFor}</td>
                            <td>{row.goalsAgainst}</td>
                            <td>{row.goalDifference}</td>
                            <td>
                              <strong>{row.points}</strong>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : null}

                <div className="scorers-block">
                  <h3>Top Scorers</h3>
                  <p className="muted">List top scorers for this competition.</p>
                  <div className="selectors compact-selectors">
                    <label>
                      Limit
                      <select value={topScorersLimit} onChange={(e) => setTopScorersLimit(e.target.value)}>
                        <option value="10">Top 10</option>
                        <option value="20">Top 20</option>
                        <option value="30">Top 30</option>
                      </select>
                    </label>
                  </div>
                  {!standingsCompetitionId ? <p className="muted">Select a competition to view top scorers.</p> : null}
                  {standingsCompetitionId && topScorersLoading ? <p className="muted">Loading top scorers...</p> : null}
                  {standingsCompetitionId && !topScorersLoading && topScorersError ? (
                    <p className="muted">{topScorersError}</p>
                  ) : null}
                  {standingsCompetitionId && !topScorersLoading && !topScorersError && topScorers.length === 0 ? (
                    <p className="muted">No top scorers available for this competition and season.</p>
                  ) : null}
                  {topScorers.length > 0 ? (
                    <div className="scorers-list">
                      {topScorers.map((scorer, index) => (
                        <article
                          className="scorer-row"
                          key={`${scorer.player?.id ?? scorer.player?.name ?? 'player'}-${scorer.team?.id ?? scorer.team?.name ?? 'team'}-${index}`}
                        >
                          <span className="scorer-rank">#{index + 1}</span>
                          <div className="scorer-meta">
                            <strong>{scorer.player?.name ?? 'Unknown player'}</strong>
                            <span>
                              {scorer.team?.shortName ?? scorer.team?.name ?? 'Unknown team'}
                              {typeof scorer.assists === 'number' ? ` | ${scorer.assists} assists` : ''}
                            </span>
                          </div>
                          <span className="scorer-goals">{scorer.goals ?? 0} goals</span>
                        </article>
                      ))}
                    </div>
                  ) : null}
                </div>
              </section>
            </aside>
          </section>
        ) : null}

        {page === 'game' && !user ? (
          <section className="filter-panel auth-box">
            <h2>Login To Play Predictions</h2>
            <label>
              Email
              <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" />
            </label>
            <label>
              Password
              <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" />
            </label>
            <div className="auth-actions">
              <button type="button" className="refresh" onClick={() => void handleLogin()} disabled={authLoading}>
                Login
              </button>
              <button type="button" className="details-btn" onClick={() => void handleRegister()} disabled={authLoading}>
                Register
              </button>
            </div>
          </section>
        ) : null}

        {page === 'game' && user ? (
          <section className="game-grid">
            <div className="game-side">
              <section className="filter-panel">
                <h2>Create Group</h2>
                <div className="selectors">
                  <label>
                    Group Name
                    <input value={newGroupName} onChange={(e) => setNewGroupName(e.target.value)} placeholder="Weekend League" />
                  </label>
                  <label>
                    Competition
                    <select value={newGroupCompetitionId} onChange={(e) => setNewGroupCompetitionId(e.target.value)}>
                      <option value="">Select competition</option>
                      {competitions.map((competition) => (
                        <option key={competition.id} value={competition.id}>
                          {competition.name} ({competition.area?.name ?? 'Unknown'})
                        </option>
                      ))}
                    </select>
                  </label>
                  <button type="button" className="refresh" disabled={busy} onClick={() => void handleCreateGroup()}>
                    Create
                  </button>
                </div>
              </section>

              <section className="filter-panel">
                <h2>Your Groups</h2>
                <div className="group-list">
                  {groups.length === 0 ? <p className="muted">No groups yet. Create one above or accept an invite.</p> : null}
                  {groups.map((group) => (
                    <button
                      type="button"
                      key={group.id}
                      className={`group-chip ${group.id === selectedGroupId ? 'group-chip-active' : ''}`}
                      onClick={() => setSelectedGroupId(group.id)}
                    >
                      {group.name} - {group.competition_name}
                    </button>
                  ))}
                </div>
              </section>

              {selectedGroup ? (
                <section className="filter-panel">
                  <h2>Invite Friends</h2>
                  <div className="selectors">
                    <label>
                      Friend Email
                      <input value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} type="email" />
                    </label>
                    <button type="button" className="refresh" disabled={busy} onClick={() => void handleInvite()}>
                      Invite
                    </button>
                  </div>
                  <div className="invite-list">
                    {invites.length === 0 ? <p className="muted">No invites yet.</p> : null}
                    {invites.map((invite) => (
                      <p key={invite.id}>
                        {invite.email} - <strong>{invite.status}</strong>
                      </p>
                    ))}
                  </div>
                </section>
              ) : null}

              {selectedGroup ? (
                <section className="filter-panel">
                  <h2>Leaderboard (Total)</h2>
                  {groupLeaderboard.length === 0 ? <p className="muted">No members in this group.</p> : null}
                  <div className="leaderboard-list">
                    {groupLeaderboard.map((row, index) => (
                      <article className="leaderboard-card" key={row.userUid}>
                        <div className="leaderboard-rank">#{index + 1}</div>
                        <div className="leaderboard-user">
                          <strong>{row.email}</strong>
                        </div>
                        <div className="leaderboard-points">{row.points} pts</div>
                      </article>
                    ))}
                  </div>
                </section>
              ) : null}
            </div>

            <div className="game-main">
              {!selectedGroup ? (
                <article className="league-card empty">Select a group to start predicting matches.</article>
              ) : null}

              {selectedGroup ? (
                <section className="filter-panel game-summary">
                  <h2>Prediction Board - {selectedGroup.competition_name}</h2>
                  <div className="quick-status">
                    <span className="group-chip">Matches: {groupMatches.length}</span>
                    <span className="group-chip">Completed Drafts: {completedDraftCount}</span>
                    <span className="group-chip">Saved: {Object.keys(myPredictions).length}</span>
                  </div>
                  <button
                    type="button"
                    className="refresh"
                    disabled={savingAll || busy || groupMatchesLoading}
                    onClick={() => void handleSaveAllPredictions()}
                  >
                    {savingAll ? 'Saving...' : 'Save All Predictions'}
                  </button>
                </section>
              ) : null}

              {selectedGroup ? (
                <section className="scoreboard">
                  <div className="scoreboard-head">
                    <strong>Today Matches - {selectedGroup.competition_name}</strong>
                    <span>{groupMatchesLoading ? 'Loading...' : `${groupMatches.length} match(es)`}</span>
                  </div>

                  {groupMatches.map((match) => {
                    const draft = predictionDrafts[match.id] ?? { htHome: '', htAway: '', ftHome: '', ftAway: '' };
                    const saved = myPredictions[match.id];
                    const matchPredictions = groupPredictionsByMatch[match.id] ?? [];
                    const submittedUserCount = new Set(matchPredictions.map((item) => item.user_uid)).size;
                    const shouldReveal = groupMembers.length > 0 && submittedUserCount >= groupMembers.length;
                    const memberEmailByUid = Object.fromEntries(groupMembers.map((member) => [member.user_uid, member.email]));
                    const matchResult = getMatchResult(match);
                    const matchLabel = `${match.homeTeam.name} vs ${match.awayTeam.name}`;

                    return (
                      <article className="league-card prediction-card" key={match.id}>
                        <div className="match-row prediction-row">
                          <div className="match-time">
                            <span className={`status-dot ${getStatusClass(match.status)}`} />
                            <span>{match.status === 'TIMED' ? kickoffTime(match.utcDate) : match.status}</span>
                          </div>

                          <div className="teams-col">
                            <div className="team-line">
                              <span className="team-name">{match.homeTeam.name}</span>
                              <strong className="team-score">{match.score?.fullTime?.home ?? '-'}</strong>
                            </div>
                            <div className="team-line">
                              <span className="team-name">{match.awayTeam.name}</span>
                              <strong className="team-score">{match.score?.fullTime?.away ?? '-'}</strong>
                            </div>
                          </div>

                          <div className="prediction-inputs">
                            <label>
                              HT
                              <div className="inline-score">
                                <input
                                  type="number"
                                  min={0}
                                  value={draft.htHome}
                                  onChange={(e) =>
                                    setPredictionDrafts((prev) => ({
                                      ...prev,
                                      [match.id]: { ...draft, htHome: e.target.value }
                                    }))
                                  }
                                />
                                <span>-</span>
                                <input
                                  type="number"
                                  min={0}
                                  value={draft.htAway}
                                  onChange={(e) =>
                                    setPredictionDrafts((prev) => ({
                                      ...prev,
                                      [match.id]: { ...draft, htAway: e.target.value }
                                    }))
                                  }
                                />
                              </div>
                            </label>

                            <label>
                              FT
                              <div className="inline-score">
                                <input
                                  type="number"
                                  min={0}
                                  value={draft.ftHome}
                                  onChange={(e) =>
                                    setPredictionDrafts((prev) => ({
                                      ...prev,
                                      [match.id]: { ...draft, ftHome: e.target.value }
                                    }))
                                  }
                                />
                                <span>-</span>
                                <input
                                  type="number"
                                  min={0}
                                  value={draft.ftAway}
                                  onChange={(e) =>
                                    setPredictionDrafts((prev) => ({
                                      ...prev,
                                      [match.id]: { ...draft, ftAway: e.target.value }
                                    }))
                                  }
                                />
                              </div>
                            </label>
                          </div>
                        </div>
                        {saved ? (
                          <p className="saved-line">
                            Saved: HT {saved.ht_home}-{saved.ht_away} | FT {saved.ft_home}-{saved.ft_away}
                          </p>
                        ) : null}
                        {saved && !shouldReveal ? (
                          <p className="saved-line">
                            Waiting for others: {submittedUserCount}/{groupMembers.length} submitted for this match.
                          </p>
                        ) : null}
                        {matchResult ? (
                          <p className="saved-line">
                            Result: HT {matchResult.htHome}-{matchResult.htAway} | FT {matchResult.ftHome}-{matchResult.ftAway}
                          </p>
                        ) : null}
                        {shouldReveal ? (
                          <div className="reveal-list">
                            {matchPredictions.map((item) => {
                              const points = calculatePredictionPoints(match, item);
                              return (
                                <article className="reveal-card" key={item.id}>
                                  <div className="reveal-card-head">
                                    <strong>{memberEmailByUid[item.user_uid] ?? item.user_uid}</strong>
                                    {points.ready ? <span className="reveal-points">{points.total}/3 pts</span> : null}
                                  </div>
                                  <p className="reveal-match">{matchLabel}</p>
                                  <div className="reveal-scores">
                                    <p>
                                      <strong>HT:</strong> {item.ht_home} - {item.ht_away}
                                    </p>
                                    <p>
                                      <strong>FT:</strong> {item.ft_home} - {item.ft_away}
                                    </p>
                                  </div>
                                </article>
                              );
                            })}
                          </div>
                        ) : null}
                      </article>
                    );
                  })}

                  {groupMatches.length === 0 && !groupMatchesLoading ? (
                    <article className="league-card empty">No matches today.</article>
                  ) : null}
                </section>
              ) : null}
            </div>
          </section>
        ) : null}

        {matchDetailsOpen ? (
          <div className="modal-overlay" onClick={closeMatchDetails}>
            <section className="modal" onClick={(event) => event.stopPropagation()}>
              <header className="modal-header">
                <h3>
                  {activeMatchDetails ? `${activeMatchDetails.homeTeam.name} vs ${activeMatchDetails.awayTeam.name}` : 'Match Details'}
                </h3>
                <button type="button" onClick={closeMatchDetails}>
                  Close
                </button>
              </header>

              {matchDetailsLoading ? <p className="muted">Loading details...</p> : null}
              {matchDetailsError ? <p className="error">{matchDetailsError}</p> : null}

              {activeMatchDetails ? (
                <>
                  {teamDetailsLoading ? <p className="muted">Loading team squads...</p> : null}
                  <div className="detail-grid">
                    <p>
                      <strong>Competition:</strong> {activeMatchDetails.competition?.name ?? 'Unknown'}
                    </p>
                    <p>
                      <strong>Date:</strong> {formatMatchDateTime(activeMatchDetails.utcDate)}
                    </p>
                    <p>
                      <strong>Status:</strong> {activeMatchDetails.status}
                    </p>
                    <p>
                      <strong>Venue:</strong> {activeMatchDetails.venue ?? activeMatchDetails.homeTeam.venue ?? 'Unknown'}
                    </p>
                    <p>
                      <strong>Stage:</strong> {activeMatchDetails.stage ?? 'N/A'}
                    </p>
                    <p>
                      <strong>Matchday:</strong> {activeMatchDetails.matchday ?? 'N/A'}
                    </p>
                  </div>

                  <div className="events-grid">
                    <article className="league-card">
                      <header className="league-head">
                        <h4>Home Team</h4>
                      </header>
                      <div className="filter-panel">
                        {(() => {
                          const homeDetails =
                            activeMatchDetails.homeTeam.id !== undefined ? teamDetailsById[activeMatchDetails.homeTeam.id] : null;
                          const homePlayers = homeDetails?.squad ?? [];
                          return (
                            <>
                              <p>
                                <strong>{activeMatchDetails.homeTeam.name}</strong>
                              </p>
                              <p className="muted">Coach: {homeDetails?.coach?.name ?? activeMatchDetails.homeTeam.coach?.name ?? 'N/A'}</p>
                              {homePlayers.length === 0 ? <p className="muted">No squad data available.</p> : null}
                              {homePlayers.length > 0 ? <HalfFieldPlayers players={homePlayers} side="home" /> : null}
                            </>
                          );
                        })()}
                      </div>
                    </article>

                    <article className="league-card">
                      <header className="league-head">
                        <h4>Away Team</h4>
                      </header>
                      <div className="filter-panel">
                        {(() => {
                          const awayDetails =
                            activeMatchDetails.awayTeam.id !== undefined ? teamDetailsById[activeMatchDetails.awayTeam.id] : null;
                          const awayPlayers = awayDetails?.squad ?? [];
                          return (
                            <>
                              <p>
                                <strong>{activeMatchDetails.awayTeam.name}</strong>
                              </p>
                              <p className="muted">Coach: {awayDetails?.coach?.name ?? activeMatchDetails.awayTeam.coach?.name ?? 'N/A'}</p>
                              {awayPlayers.length === 0 ? <p className="muted">No squad data available.</p> : null}
                              {awayPlayers.length > 0 ? <HalfFieldPlayers players={awayPlayers} side="away" /> : null}
                            </>
                          );
                        })()}
                      </div>
                    </article>
                  </div>

                  <div className="detail-grid">
                    <p>
                      <strong>Half-time:</strong> {activeMatchDetails.score?.halfTime?.home ?? '-'} -{' '}
                      {activeMatchDetails.score?.halfTime?.away ?? '-'}
                    </p>
                    <p>
                      <strong>Full-time:</strong> {activeMatchDetails.score?.fullTime?.home ?? '-'} -{' '}
                      {activeMatchDetails.score?.fullTime?.away ?? '-'}
                    </p>
                    <p>
                      <strong>Winner:</strong> {activeMatchDetails.score?.winner ?? 'N/A'}
                    </p>
                    <p>
                      <strong>Referees:</strong>{' '}
                      {activeMatchDetails.referees?.length
                        ? activeMatchDetails.referees
                            .map((referee) => `${referee.name ?? 'Unknown'}${referee.type ? ` (${referee.type})` : ''}`)
                            .join(', ')
                        : 'N/A'}
                    </p>
                  </div>
                </>
              ) : null}
            </section>
          </div>
        ) : null}

        {error ? <p className="error">{error}</p> : null}
        {message ? <p className="muted">{message}</p> : null}
        {busy ? <p className="muted">Working...</p> : null}
      </main>
    </div>
  );
}

type MatchScoreResult = {
  htHome: number;
  htAway: number;
  ftHome: number;
  ftAway: number;
  winner: 'HOME_TEAM' | 'AWAY_TEAM' | 'DRAW';
};

type PlayerLane = 'GK' | 'DEF' | 'MID' | 'ATT';

function detectPlayerLane(position?: string): PlayerLane {
  const value = (position ?? '').toUpperCase();
  if (value.includes('KEEPER') || value === 'GK' || value === 'GOALKEEPER') return 'GK';
  if (
    value.includes('BACK') ||
    value.includes('DEF') ||
    value.includes('CENTRE-BACK') ||
    value.includes('CENTER-BACK') ||
    value.includes('SWEEPER')
  ) {
    return 'DEF';
  }
  if (
    value.includes('MID') ||
    value.includes('WING') ||
    value.includes('WIDE') ||
    value.includes('DM') ||
    value.includes('CM') ||
    value.includes('AM')
  ) {
    return 'MID';
  }
  return 'ATT';
}

function groupPlayersByLane(players: TeamPlayer[]) {
  const lanes: Record<PlayerLane, TeamPlayer[]> = { GK: [], DEF: [], MID: [], ATT: [] };
  for (const player of players) {
    if ((player.position ?? '').toUpperCase() === 'COACH') {
      continue;
    }
    const lane = detectPlayerLane(player.position);
    lanes[lane].push(player);
  }
  return lanes;
}

function HalfFieldPlayers({ players, side }: { players: TeamPlayer[]; side: 'home' | 'away' }) {
  const lanes = groupPlayersByLane(players);
  const orderedRows: Array<{ key: PlayerLane; label: string }> =
    side === 'home'
      ? [
          { key: 'GK', label: 'Goalkeeper' },
          { key: 'DEF', label: 'Defenders' },
          { key: 'MID', label: 'Midfielders' },
          { key: 'ATT', label: 'Attackers' }
        ]
      : [
          { key: 'ATT', label: 'Attackers' },
          { key: 'MID', label: 'Midfielders' },
          { key: 'DEF', label: 'Defenders' },
          { key: 'GK', label: 'Goalkeeper' }
        ];

  return (
    <div className={`pitch-half pitch-half-${side}`}>
      {orderedRows.map((row) => (
        <div className="pitch-row" key={`${side}-${row.key}`}>
          <span className="pitch-row-label">{row.label}</span>
          <div className="pitch-row-players">
            {lanes[row.key].map((player) => (
              <span className="pitch-player" key={player.id ?? `${player.name}-${row.key}`}>
                {player.name ?? 'Unknown'}
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

type PredictionPoints = {
  ready: boolean;
  winner: number;
  ht: number;
  ft: number;
  total: number;
};

function getWinner(home: number, away: number): 'HOME_TEAM' | 'AWAY_TEAM' | 'DRAW' {
  if (home > away) return 'HOME_TEAM';
  if (away > home) return 'AWAY_TEAM';
  return 'DRAW';
}

function getMatchResult(match: Match): MatchScoreResult | null {
  if (match.status !== 'FINISHED') {
    return null;
  }

  const htHome = match.score?.halfTime?.home;
  const htAway = match.score?.halfTime?.away;
  const ftHome = match.score?.fullTime?.home;
  const ftAway = match.score?.fullTime?.away;

  if (
    htHome === undefined ||
    htHome === null ||
    htAway === undefined ||
    htAway === null ||
    ftHome === undefined ||
    ftHome === null ||
    ftAway === undefined ||
    ftAway === null
  ) {
    return null;
  }

  return {
    htHome,
    htAway,
    ftHome,
    ftAway,
    winner: match.score?.winner ?? getWinner(ftHome, ftAway)
  };
}

function calculatePredictionPoints(match: Match, prediction: MatchPrediction): PredictionPoints {
  const result = getMatchResult(match);
  if (!result) {
    return { ready: false, winner: 0, ht: 0, ft: 0, total: 0 };
  }

  const predictedWinner = getWinner(prediction.ft_home, prediction.ft_away);
  const winner = predictedWinner === result.winner ? 1 : 0;
  const ht = prediction.ht_home === result.htHome && prediction.ht_away === result.htAway ? 1 : 0;
  const ft = prediction.ft_home === result.ftHome && prediction.ft_away === result.ftAway ? 1 : 0;

  return { ready: true, winner, ht, ft, total: winner + ht + ft };
}

function formatMatchDateTime(utcDate: string) {
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(utcDate));
}

export default App;
