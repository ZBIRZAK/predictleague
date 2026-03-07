import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  createUserWithEmailAndPassword,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
  type User
} from 'firebase/auth';
import {
  acceptPendingInvites,
  createGroup,
  loadGroupBonusMatches,
  loadGroupLeaderboard,
  loadGroupMembers,
  loadUserProfile,
  inviteMember,
  loadGroupsForUser,
  loadInvitesForGroup,
  loadPredictionsForGroup,
  savePrediction,
  updateGroupSettings,
  upsertUserProfile,
  upsertGroupBonusMatches,
  type AppGroup,
  type GroupBonusMatch,
  type GroupMember,
  type GroupLeaderboard,
  type GroupInvite,
  type MatchPrediction,
  type UserProfile
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

type ProfileForm = {
  firstName: string;
  lastName: string;
  displayName: string;
  country: string;
  favoriteTeam: string;
  bio: string;
};

type ResponsiblePlayForm = {
  remindersEnabled: boolean;
  reminderMinutesBefore: string;
  weeklySummaryEnabled: boolean;
  takeBreakUntil: string;
};

type AppPage = 'home' | 'game' | 'profile';

const statuses: Array<{ label: string; value: StatusFilter }> = [
  { label: 'All', value: '' },
  { label: 'Live', value: 'LIVE' },
  { label: 'Scheduled', value: 'SCHEDULED' },
  { label: 'Finished', value: 'FINISHED' }
];

function getPageFromHash(hash: string): AppPage {
  if (hash === '#/game') return 'game';
  if (hash === '#/profile') return 'profile';
  return 'home';
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

function formatCountdown(ms: number) {
  if (ms <= 0) return '00:00:00';
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function colorFromText(input: string, saturation = 70, lightness = 48) {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash << 5) - hash + input.charCodeAt(i);
    hash |= 0;
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue} ${saturation}% ${lightness}%)`;
}

function getTeamAccentColor(team: Team) {
  const key = (team.tla ?? team.shortName ?? team.name ?? '').toUpperCase().trim();
  const preset: Record<string, string> = {
    RMA: '#f2c94c',
    FCB: '#a50044',
    ATM: '#d71920',
    LIV: '#c8102e',
    MCI: '#6cabdd',
    ARS: '#ef0107',
    MUN: '#da291c',
    CHE: '#034694',
    TOT: '#132257',
    PSG: '#004170',
    JUV: '#111111',
    INT: '#00529f',
    MIL: '#c0002b',
    BAY: '#dc052d',
    DOR: '#fdeb00',
    AJAX: '#d2122e'
  };
  if (key && preset[key]) {
    return preset[key];
  }
  return colorFromText(key || team.name || 'team');
}

function profileToForm(profile: UserProfile | null): ProfileForm {
  return {
    firstName: profile?.first_name ?? '',
    lastName: profile?.last_name ?? '',
    displayName: profile?.display_name ?? '',
    country: profile?.country ?? '',
    favoriteTeam: profile?.favorite_team ?? '',
    bio: profile?.bio ?? ''
  };
}

function toLocalDateTimeInput(value: string | null | undefined) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

function fromLocalDateTimeInput(value: string) {
  if (!value.trim()) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function profileToResponsibleForm(profile: UserProfile | null): ResponsiblePlayForm {
  return {
    remindersEnabled: profile?.reminders_enabled ?? true,
    reminderMinutesBefore: String(profile?.reminder_minutes_before ?? 30),
    weeklySummaryEnabled: profile?.weekly_summary_enabled ?? true,
    takeBreakUntil: toLocalDateTimeInput(profile?.take_break_until)
  };
}

function splitDisplayName(name: string | null | undefined) {
  const full = (name ?? '').trim();
  if (!full) {
    return { firstName: '', lastName: '' };
  }
  const [firstName, ...rest] = full.split(/\s+/);
  return { firstName, lastName: rest.join(' ') };
}

function isValidEmailAddress(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function mapFirebaseAuthError(error: unknown, fallback: string) {
  const message = error instanceof Error ? error.message : fallback;
  if (!(error instanceof Error)) return message;
  if (message.includes('auth/invalid-email')) return 'Enter a valid email address.';
  if (message.includes('auth/email-already-in-use')) return 'This email is already registered. Try login instead.';
  if (message.includes('auth/weak-password')) return 'Password is too weak. Use at least 8 characters.';
  if (message.includes('auth/invalid-credential')) return 'Invalid email or password.';
  if (message.includes('auth/too-many-requests')) return 'Too many attempts. Please try again later.';
  if (message.includes('auth/popup-closed-by-user')) return 'Google sign-in popup was closed.';
  return message;
}

function ImportantMatchCard({ match, onOpen }: { match: Match; onOpen: (match: Match) => Promise<void> }) {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const kickoffMs = Date.parse(match.utcDate);
  const isUpcoming = ['SCHEDULED', 'TIMED'].includes(match.status) && !Number.isNaN(kickoffMs) && kickoffMs > nowMs;
  const countdown = isUpcoming ? formatCountdown(kickoffMs - nowMs) : match.status;

  return (
    <button
      type="button"
      className="important-feature-card"
      onClick={() => void onOpen(match)}
      style={
        {
          '--left-accent': getTeamAccentColor(match.homeTeam),
          '--right-accent': getTeamAccentColor(match.awayTeam)
        } as CSSProperties
      }
    >
      <span className="important-feature-head">
        <span className="important-feature-meta">
          <strong>{match.competition?.name ?? 'Competition'}</strong>
          <span className="muted">{formatMatchDateTime(match.utcDate)}</span>
        </span>
        <strong className={`important-feature-countdown ${isUpcoming ? '' : 'important-live'}`}>{countdown}</strong>
      </span>
      <span className="important-feature-teams">
        <span className="team-name-wrap">
          {match.homeTeam.crest ? <img className="team-crest team-crest-large" src={match.homeTeam.crest} alt="" loading="lazy" /> : null}
          <span className="team-name important-team-name">{match.homeTeam.name}</span>
        </span>
        <span className="important-vs">VS</span>
        <span className="team-name-wrap">
          {match.awayTeam.crest ? <img className="team-crest team-crest-large" src={match.awayTeam.crest} alt="" loading="lazy" /> : null}
          <span className="team-name important-team-name">{match.awayTeam.name}</span>
        </span>
      </span>
    </button>
  );
}

function App() {
  const today = useMemo(() => getTodayLocalDateInputValue(), []);
  const [page, setPage] = useState<AppPage>(() => getPageFromHash(window.location.hash));

  const [authReady, setAuthReady] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [authLoading, setAuthLoading] = useState(false);
  const [authMode, setAuthMode] = useState<'login' | 'signup'>('login');
  const [signupProfile, setSignupProfile] = useState<ProfileForm>({
    firstName: '',
    lastName: '',
    displayName: '',
    country: '',
    favoriteTeam: '',
    bio: ''
  });
  const [profileForm, setProfileForm] = useState<ProfileForm>({
    firstName: '',
    lastName: '',
    displayName: '',
    country: '',
    favoriteTeam: '',
    bio: ''
  });
  const [profileRecord, setProfileRecord] = useState<UserProfile | null>(null);
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileSaving, setProfileSaving] = useState(false);
  const [responsibleForm, setResponsibleForm] = useState<ResponsiblePlayForm>({
    remindersEnabled: true,
    reminderMinutesBefore: '30',
    weeklySummaryEnabled: true,
    takeBreakUntil: ''
  });
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
  const [predictionDrafts, setPredictionDrafts] = useState<Record<number, PredictionDraft>>({});
  const [leaderboardScope, setLeaderboardScope] = useState<'total' | 'weekly'>('total');
  const [groupLeaderboardData, setGroupLeaderboardData] = useState<GroupLeaderboard | null>(null);
  const [groupLeaderboardLoading, setGroupLeaderboardLoading] = useState(false);
  const [groupBonusMatches, setGroupBonusMatches] = useState<GroupBonusMatch[]>([]);
  const [groupSettingsBusy, setGroupSettingsBusy] = useState(false);
  const [lockMinutesInput, setLockMinutesInput] = useState('0');
  const [bonusEnabledInput, setBonusEnabledInput] = useState(false);
  const [bonusMatchIdInput, setBonusMatchIdInput] = useState('');
  const [bonusMultiplierInput, setBonusMultiplierInput] = useState('1.5');
  const [bonusLabelInput, setBonusLabelInput] = useState('Derby');

  const [newGroupName, setNewGroupName] = useState('');
  const [newGroupCompetitionId, setNewGroupCompetitionId] = useState('');
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteSending, setInviteSending] = useState(false);
  const [busy, setBusy] = useState(false);
  const [savingAll, setSavingAll] = useState(false);
  const [groupMatchesLoading, setGroupMatchesLoading] = useState(false);
  const [perfectCongratsMatch, setPerfectCongratsMatch] = useState<string | null>(null);
  const shownPerfectCongratsRef = useRef<Set<string>>(new Set());

  const selectedGroup = useMemo(
    () => groups.find((group) => group.id === selectedGroupId) ?? null,
    [groups, selectedGroupId]
  );
  const normalizedAuthEmail = email.trim().toLowerCase();
  const normalizedInviteEmail = inviteEmail.trim().toLowerCase();
  const isAuthEmailValid = isValidEmailAddress(normalizedAuthEmail);
  const isSignupMode = authMode === 'signup';
  const isSignupPasswordValid = password.length >= 8;
  const doesPasswordMatch = password === confirmPassword;
  const canSubmitAuth =
    authMode === 'login'
      ? isAuthEmailValid && password.length > 0
      : isAuthEmailValid && isSignupPasswordValid && doesPasswordMatch;
  const yesterdayDate = useMemo(() => shiftLocalDate(today, -1), [today]);
  const tomorrowDate = useMemo(() => shiftLocalDate(today, 1), [today]);

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

  const importantMatch = useMemo(() => {
    const liveStatuses = new Set(['LIVE', 'IN_PLAY', 'PAUSED']);
    const scheduleStatuses = new Set(['SCHEDULED', 'TIMED']);

    const live = filteredPublicMatches.filter((match) => liveStatuses.has(match.status));
    const upcoming = filteredPublicMatches
      .filter((match) => scheduleStatuses.has(match.status))
      .map((match) => ({ match, kickoffMs: Date.parse(match.utcDate) }))
      .filter((row) => !Number.isNaN(row.kickoffMs))
      .sort((a, b) => a.kickoffMs - b.kickoffMs)
      .map((row) => row.match);

    return [...live, ...upcoming][0] ?? null;
  }, [filteredPublicMatches]);

  const standingsYears = useMemo(() => {
    const currentSeasonStart = getCurrentSeasonStartYear();
    return Array.from({ length: 12 }, (_, index) => String(currentSeasonStart - index));
  }, []);

  const groupLeaderboard = groupLeaderboardData?.leaderboard ?? [];

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
      setProfileRecord(null);
      setProfileForm({
        firstName: '',
        lastName: '',
        displayName: '',
        country: '',
        favoriteTeam: '',
        bio: ''
      });
      setResponsibleForm(profileToResponsibleForm(null));
      return;
    }

    void bootstrapForUser(user);
    void loadProfileForUser(user);
  }, [user]);

  useEffect(() => {
    if (!user || !selectedGroup) {
      setGroupMatches([]);
      setMyPredictions({});
      setGroupPredictionsByMatch({});
      setGroupMembers([]);
      setGroupLeaderboardData(null);
      setGroupBonusMatches([]);
      return;
    }

    setLockMinutesInput(String(selectedGroup.prediction_lock_minutes ?? 0));
    setBonusEnabledInput(Boolean(selectedGroup.bonus_enabled));
    void loadGroupData(user.uid, selectedGroup);
  }, [selectedGroup, user, today]);

  useEffect(() => {
    if (!selectedGroup) {
      setGroupLeaderboardData(null);
      return;
    }

    void loadGroupLeaderboardData(selectedGroup.id, leaderboardScope);
  }, [leaderboardScope, selectedGroup?.id]);

  useEffect(() => {
    if (!selectedGroup || !user) return;
    for (const match of groupMatches) {
      const mine = myPredictions[match.id];
      if (!mine) continue;
      const points = calculatePredictionPoints(match, mine);
      const isPerfect = points.ready && points.winner === 1 && points.ht === 1 && points.ft === 1;
      if (!isPerfect) continue;
      const key = `${selectedGroup.id}:${user.uid}:${match.id}`;
      if (shownPerfectCongratsRef.current.has(key)) continue;
      shownPerfectCongratsRef.current.add(key);
      setPerfectCongratsMatch(`${match.homeTeam.name} vs ${match.awayTeam.name}`);
      break;
    }
  }, [groupMatches, myPredictions, selectedGroup, user]);

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

  async function loadProfileForUser(currentUser: User) {
    try {
      setProfileLoading(true);
      const profile = await loadUserProfile(currentUser.uid);
      setProfileRecord(profile);
      if (profile) {
        setProfileForm(profileToForm(profile));
        setResponsibleForm(profileToResponsibleForm(profile));
        return;
      }

      const inferred = splitDisplayName(currentUser.displayName);
      setProfileForm({
        firstName: inferred.firstName,
        lastName: inferred.lastName,
        displayName: currentUser.displayName ?? '',
        country: '',
        favoriteTeam: '',
        bio: ''
      });
      setResponsibleForm(profileToResponsibleForm(null));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load profile.');
    } finally {
      setProfileLoading(false);
    }
  }

  async function handleSaveProfile() {
    if (!user) {
      setError('You need to be logged in to save profile.');
      return;
    }

    try {
      setProfileSaving(true);
      setError('');
      const reminderMinutes = Number(responsibleForm.reminderMinutesBefore);
      if (Number.isNaN(reminderMinutes) || reminderMinutes < 5 || reminderMinutes > 180) {
        setError('Reminder minutes must be between 5 and 180.');
        return;
      }
      await upsertUserProfile({
        userUid: user.uid,
        email: user.email ?? email,
        firstName: profileForm.firstName,
        lastName: profileForm.lastName,
        displayName: profileForm.displayName,
        country: profileForm.country,
        favoriteTeam: profileForm.favoriteTeam,
        bio: profileForm.bio,
        remindersEnabled: responsibleForm.remindersEnabled,
        reminderMinutesBefore: Math.floor(reminderMinutes),
        weeklySummaryEnabled: responsibleForm.weeklySummaryEnabled,
        takeBreakUntil: fromLocalDateTimeInput(responsibleForm.takeBreakUntil)
      });
      const refreshed = await loadUserProfile(user.uid);
      setProfileRecord(refreshed);
      if (refreshed) {
        setProfileForm(profileToForm(refreshed));
        setResponsibleForm(profileToResponsibleForm(refreshed));
      }
      setMessage('Profile saved.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save profile.');
    } finally {
      setProfileSaving(false);
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

  async function loadGroupLeaderboardData(groupId: string, scope: 'total' | 'weekly') {
    try {
      setGroupLeaderboardLoading(true);
      const data = await loadGroupLeaderboard({
        groupId,
        scope,
        referenceDate: `${today}T00:00:00.000Z`
      });
      setGroupLeaderboardData(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load leaderboard.');
    } finally {
      setGroupLeaderboardLoading(false);
    }
  }

  async function loadGroupBonusData(groupId: string) {
    try {
      const data = await loadGroupBonusMatches(groupId);
      setGroupBonusMatches(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load bonus matches.');
    }
  }

  async function handleSaveGroupSettings() {
    if (!selectedGroup) return;
    if (!isGroupOwner) {
      setError('Only group owner can update fair-play settings.');
      return;
    }
    const lock = Number(lockMinutesInput);
    if (Number.isNaN(lock) || lock < 0 || lock > 180) {
      setError('Prediction lock must be between 0 and 180 minutes.');
      return;
    }

    try {
      setGroupSettingsBusy(true);
      setError('');
      const updated = await updateGroupSettings({
        groupId: selectedGroup.id,
        predictionLockMinutes: lock,
        bonusEnabled: bonusEnabledInput
      });
      setGroups((prev) => prev.map((group) => (group.id === updated.id ? updated : group)));
      setMessage('Group fair-play settings updated.');
      await loadGroupLeaderboardData(selectedGroup.id, leaderboardScope);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save group settings.');
    } finally {
      setGroupSettingsBusy(false);
    }
  }

  async function handleAddBonusRule() {
    if (!selectedGroup) return;
    if (!isGroupOwner) {
      setError('Only group owner can update bonus rules.');
      return;
    }
    const matchId = Number(bonusMatchIdInput);
    const multiplier = Number(bonusMultiplierInput);
    if (!matchId || Number.isNaN(matchId)) {
      setError('Select a valid match for bonus rule.');
      return;
    }
    if (Number.isNaN(multiplier) || multiplier < 1 || multiplier > 5) {
      setError('Bonus multiplier must be between 1.0 and 5.0.');
      return;
    }

    try {
      setGroupSettingsBusy(true);
      setError('');
      const data = await upsertGroupBonusMatches(selectedGroup.id, [
        {
          matchId,
          multiplier,
          label: bonusLabelInput.trim() || 'custom',
          active: true
        }
      ]);
      setGroupBonusMatches(data);
      setMessage('Bonus rule saved.');
      await loadGroupLeaderboardData(selectedGroup.id, leaderboardScope);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save bonus rule.');
    } finally {
      setGroupSettingsBusy(false);
    }
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
      await Promise.all([loadGroupLeaderboardData(group.id, leaderboardScope), loadGroupBonusData(group.id)]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load group data.');
    } finally {
      setGroupMatchesLoading(false);
    }
  }

  async function handleRegister() {
    if (!isValidEmailAddress(email.trim().toLowerCase())) {
      setError('Enter a valid email address.');
      return;
    }
    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    try {
      setAuthLoading(true);
      setError('');
      setMessage('');
      const credential = await createUserWithEmailAndPassword(firebaseAuth, email.trim().toLowerCase(), password);
      await upsertUserProfile({
        userUid: credential.user.uid,
        email: credential.user.email ?? email.trim().toLowerCase(),
        firstName: signupProfile.firstName,
        lastName: signupProfile.lastName,
        displayName: signupProfile.displayName,
        country: signupProfile.country,
        favoriteTeam: signupProfile.favoriteTeam,
        bio: signupProfile.bio
      });
      setConfirmPassword('');
      setPassword('');
      setMessage('Account created. You are signed in.');
    } catch (err) {
      setError(mapFirebaseAuthError(err, 'Registration failed.'));
    } finally {
      setAuthLoading(false);
    }
  }

  async function handleLogin() {
    if (!isValidEmailAddress(email.trim().toLowerCase())) {
      setError('Enter a valid email address.');
      return;
    }
    if (!password) {
      setError('Password is required.');
      return;
    }

    try {
      setAuthLoading(true);
      setError('');
      setMessage('');
      await signInWithEmailAndPassword(firebaseAuth, email.trim().toLowerCase(), password);
    } catch (err) {
      setError(mapFirebaseAuthError(err, 'Login failed.'));
    } finally {
      setAuthLoading(false);
    }
  }

  async function handleGoogleAuth() {
    try {
      setAuthLoading(true);
      setError('');
      setMessage('');
      const provider = new GoogleAuthProvider();
      const credential = await signInWithPopup(firebaseAuth, provider);
      const existing = await loadUserProfile(credential.user.uid);
      if (!existing) {
        const inferred = splitDisplayName(credential.user.displayName);
        await upsertUserProfile({
          userUid: credential.user.uid,
          email: credential.user.email ?? '',
          firstName: inferred.firstName,
          lastName: inferred.lastName,
          displayName: credential.user.displayName ?? '',
          country: '',
          favoriteTeam: '',
          bio: ''
        });
      }
      setMessage('Signed in with Google.');
    } catch (err) {
      setError(mapFirebaseAuthError(err, 'Google sign-in failed.'));
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

    if (!normalizedInviteEmail) {
      setError('Email is required.');
      return;
    }
    if (!isValidEmailAddress(normalizedInviteEmail)) {
      setError('Enter a valid email address.');
      return;
    }
    if (normalizedInviteEmail === (user.email ?? '').trim().toLowerCase()) {
      setError('You cannot invite your own email.');
      return;
    }
    if (invites.some((invite) => invite.email.trim().toLowerCase() === normalizedInviteEmail && invite.status === 'pending')) {
      setError('This email already has a pending invite.');
      return;
    }

    try {
      setInviteSending(true);
      setError('');
      const idToken = await user.getIdToken();
      await inviteMember({
        groupId: selectedGroup.id,
        invitedByUid: user.uid,
        email: normalizedInviteEmail
      });

      const emailResponse = await fetch('/internal/invite-email', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${idToken}`
        },
        body: JSON.stringify({
          toEmail: normalizedInviteEmail,
          groupName: selectedGroup.name,
          inviterEmail: user.email ?? '',
          groupId: selectedGroup.id
        })
      });
      let emailErrorMessage = '';
      let emailPayload: { accepted?: string[]; rejected?: string[] } = {};
      if (!emailResponse.ok) {
        const payload = (await emailResponse.json().catch(() => ({}))) as { error?: string };
        emailErrorMessage = payload.error ?? 'Invite saved, but email delivery failed.';
      } else {
        emailPayload = (await emailResponse.json().catch(() => ({}))) as {
          accepted?: string[];
          rejected?: string[];
        };
      }

      setInviteEmail('');
      const acceptedCount = emailPayload.accepted?.length ?? 0;
      const rejectedCount = emailPayload.rejected?.length ?? 0;
      if (emailErrorMessage) {
        setMessage(`Invite saved in app. ${emailErrorMessage}`);
      } else {
        setMessage(
          `Invite saved. Email status: accepted ${acceptedCount}, rejected ${rejectedCount}. User joins automatically when signing in with that email.`
        );
      }
      const nextInvites = await loadInvitesForGroup(selectedGroup.id);
      setInvites(nextInvites);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to invite member.');
    } finally {
      setInviteSending(false);
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
    let lockedMatches = 0;

    for (const match of groupMatches) {
      if (!isMatchOpenForPrediction(match, selectedGroup.prediction_lock_minutes)) {
        lockedMatches += 1;
        continue;
      }

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
      setError(
        lockedMatches > 0
          ? `No predictions saved. ${lockedMatches} match(es) are locked (kickoff already started).`
          : 'No completed predictions to save. Fill HT and FT first.'
      );
      return;
    }

    try {
      setSavingAll(true);
      setError('');

      const results = await Promise.allSettled(payloads.map((payload) => savePrediction(payload)));
      const successCount = results.filter((result) => result.status === 'fulfilled').length;
      const failCount = results.length - successCount;
      if (successCount === 0) {
        const firstError = results.find((result) => result.status === 'rejected');
        const message =
          firstError && firstError.status === 'rejected' && firstError.reason instanceof Error
            ? firstError.reason.message
            : 'Failed to save predictions.';
        throw new Error(message);
      }

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
      await loadGroupLeaderboardData(selectedGroup.id, leaderboardScope);
      setMessage(
        lockedMatches > 0 || failCount > 0
          ? `Saved ${successCount} prediction(s). Skipped/failed: ${lockedMatches + failCount}.`
          : `Saved ${successCount} prediction(s).`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save all predictions.');
    } finally {
      setSavingAll(false);
    }
  }

  function goToPage(nextPage: AppPage) {
    const nextHash = nextPage === 'game' ? '#/game' : nextPage === 'profile' ? '#/profile' : '#/';
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

  const headerContextLabel =
    page === 'home' ? 'Home Matches' : page === 'game' ? 'Game' : user ? 'Your Profile' : 'Profile';
  const isGroupOwner = Boolean(user && selectedGroup && selectedGroup.owner_uid === user.uid);

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
            <button
              type="button"
              className={`chip ${page === 'profile' ? 'chip-active' : ''}`}
              onClick={() => goToPage('profile')}
            >
              Profile
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
                  <div className="date-box-head">
                    <span className="box-label">Date</span>
                    <input type="date" value={publicDate} onChange={(e) => setPublicDate(e.target.value)} />
                  </div>
                  <div className="date-shortcuts">
                    <button
                      type="button"
                      className={`chip ${publicDate === yesterdayDate ? 'chip-active' : ''}`}
                      onClick={() => setPublicDate(yesterdayDate)}
                    >
                      Yesterday
                    </button>
                    <button
                      type="button"
                      className={`chip ${publicDate === today ? 'chip-active' : ''}`}
                      onClick={() => setPublicDate(today)}
                    >
                      Today
                    </button>
                    <button
                      type="button"
                      className={`chip ${publicDate === tomorrowDate ? 'chip-active' : ''}`}
                      onClick={() => setPublicDate(tomorrowDate)}
                    >
                      Tomorrow
                    </button>
                  </div>
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

              <section className="filter-panel important-panel">
                {!importantMatch ? <p className="muted">No live/upcoming important match.</p> : null}
                {importantMatch ? (
                  <ImportantMatchCard match={importantMatch} onOpen={openMatchDetails} />
                ) : null}
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
                              <span className="team-name-wrap">
                                {match.homeTeam.crest ? <img className="team-crest" src={match.homeTeam.crest} alt="" loading="lazy" /> : null}
                                <span className="team-name">{match.homeTeam.name}</span>
                              </span>
                              <strong className="team-score">{match.score?.fullTime?.home ?? '-'}</strong>
                            </div>
                            <div className="team-line">
                              <span className="team-name-wrap">
                                {match.awayTeam.crest ? <img className="team-crest" src={match.awayTeam.crest} alt="" loading="lazy" /> : null}
                                <span className="team-name">{match.awayTeam.name}</span>
                              </span>
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
          <section className="auth-shell">
            <article className="auth-hero">
              <p className="box-label">PredictLeague</p>
              <h2>Join The Game Room</h2>
              <p className="muted">Create private groups, invite friends, and submit your HT/FT predictions every day.</p>
            </article>
            <div className="filter-panel auth-box auth-card">
              <div className="auth-switch">
                <button
                  type="button"
                  className={`chip ${authMode === 'login' ? 'chip-active' : ''}`}
                  onClick={() => {
                    setAuthMode('login');
                    setConfirmPassword('');
                    setError('');
                    setMessage('');
                  }}
                >
                  Login
                </button>
                <button
                  type="button"
                  className={`chip ${authMode === 'signup' ? 'chip-active' : ''}`}
                  onClick={() => {
                    setAuthMode('signup');
                    setConfirmPassword('');
                    setError('');
                    setMessage('');
                  }}
                >
                  Sign up
                </button>
              </div>

              <h3>{authMode === 'login' ? 'Welcome back' : 'Create your account'}</h3>
              <label>
                Email
                <input
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  type="email"
                  autoComplete="email"
                  placeholder="name@example.com"
                />
              </label>
              <label>
                Password
                <input
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  type="password"
                  autoComplete={authMode === 'login' ? 'current-password' : 'new-password'}
                  placeholder={authMode === 'login' ? 'Your password' : 'At least 8 characters'}
                />
              </label>
              {isSignupMode ? (
                <>
                  <label>
                    Confirm Password
                    <input
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      type="password"
                      autoComplete="new-password"
                      placeholder="Re-enter password"
                    />
                  </label>
                  <p className="muted auth-hint">Use 8+ characters and keep your password secure.</p>
                </>
              ) : null}
              {authMode === 'signup' ? (
                <div className="selectors auth-signup-grid">
                  <label>
                    First Name
                    <input
                      value={signupProfile.firstName}
                      onChange={(e) => setSignupProfile((prev) => ({ ...prev, firstName: e.target.value }))}
                      type="text"
                      autoComplete="given-name"
                    />
                  </label>
                  <label>
                    Last Name
                    <input
                      value={signupProfile.lastName}
                      onChange={(e) => setSignupProfile((prev) => ({ ...prev, lastName: e.target.value }))}
                      type="text"
                      autoComplete="family-name"
                    />
                  </label>
                  <label>
                    Display Name
                    <input
                      value={signupProfile.displayName}
                      onChange={(e) => setSignupProfile((prev) => ({ ...prev, displayName: e.target.value }))}
                      type="text"
                    />
                  </label>
                  <label>
                    Country
                    <input
                      value={signupProfile.country}
                      onChange={(e) => setSignupProfile((prev) => ({ ...prev, country: e.target.value }))}
                      type="text"
                      autoComplete="country-name"
                    />
                  </label>
                  <label>
                    Favorite Team
                    <input
                      value={signupProfile.favoriteTeam}
                      onChange={(e) => setSignupProfile((prev) => ({ ...prev, favoriteTeam: e.target.value }))}
                      type="text"
                    />
                  </label>
                  <label className="auth-bio">
                    Bio
                    <textarea
                      value={signupProfile.bio}
                      onChange={(e) => setSignupProfile((prev) => ({ ...prev, bio: e.target.value }))}
                      rows={3}
                    />
                  </label>
                </div>
              ) : null}

              <div className="auth-actions">
                <button
                  type="button"
                  className="refresh"
                  onClick={() => void (authMode === 'login' ? handleLogin() : handleRegister())}
                  disabled={authLoading || !canSubmitAuth}
                >
                  {authLoading ? 'Please wait...' : authMode === 'login' ? 'Login' : 'Create account'}
                </button>
                <button
                  type="button"
                  className="details-btn"
                  onClick={() => {
                    setAuthMode((prev) => (prev === 'login' ? 'signup' : 'login'));
                    setConfirmPassword('');
                    setError('');
                    setMessage('');
                  }}
                  disabled={authLoading}
                >
                  {authMode === 'login' ? 'Need account?' : 'Have account?'}
                </button>
              </div>

              <div className="auth-divider">or</div>
              <button type="button" className="details-btn auth-google" onClick={() => void handleGoogleAuth()} disabled={authLoading}>
                Continue with Google
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
                    <input
                      value={inviteEmail}
                      onChange={(e) => setInviteEmail(e.target.value)}
                      type="email"
                      placeholder="friend@email.com"
                    />
                  </label>
                    <button
                      type="button"
                      className="refresh"
                      disabled={inviteSending || !normalizedInviteEmail}
                      onClick={() => void handleInvite()}
                    >
                      {inviteSending ? 'Sending...' : 'Invite'}
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
                  <h2>Fair Play Rules</h2>
                  <p className="muted">
                    Lock minutes before kickoff: <strong>{selectedGroup.prediction_lock_minutes}</strong> | Bonus rules:{' '}
                    <strong>{selectedGroup.bonus_enabled ? 'On' : 'Off'}</strong>
                  </p>
                  {isGroupOwner ? (
                    <>
                      <div className="selectors">
                        <label>
                          Lock Minutes
                          <input
                            type="number"
                            min={0}
                            max={180}
                            value={lockMinutesInput}
                            onChange={(e) => setLockMinutesInput(e.target.value)}
                          />
                        </label>
                        <label>
                          Bonus Enabled
                          <select
                            value={bonusEnabledInput ? 'on' : 'off'}
                            onChange={(e) => setBonusEnabledInput(e.target.value === 'on')}
                          >
                            <option value="off">Off</option>
                            <option value="on">On</option>
                          </select>
                        </label>
                        <button type="button" className="refresh" disabled={groupSettingsBusy} onClick={() => void handleSaveGroupSettings()}>
                          Save Rules
                        </button>
                      </div>

                      <div className="selectors">
                        <label>
                          Bonus Match
                          <select value={bonusMatchIdInput} onChange={(e) => setBonusMatchIdInput(e.target.value)}>
                            <option value="">Select today match</option>
                            {groupMatches.map((match) => (
                              <option key={match.id} value={match.id}>
                                {match.homeTeam.name} vs {match.awayTeam.name}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label>
                          Multiplier
                          <input
                            type="number"
                            step="0.1"
                            min={1}
                            max={5}
                            value={bonusMultiplierInput}
                            onChange={(e) => setBonusMultiplierInput(e.target.value)}
                          />
                        </label>
                        <label>
                          Label
                          <input value={bonusLabelInput} onChange={(e) => setBonusLabelInput(e.target.value)} />
                        </label>
                        <button type="button" className="refresh" disabled={groupSettingsBusy} onClick={() => void handleAddBonusRule()}>
                          Add Bonus
                        </button>
                      </div>
                    </>
                  ) : (
                    <p className="muted">Only group owner can update fair-play settings.</p>
                  )}

                  <div className="invite-list">
                    {groupBonusMatches.length === 0 ? <p className="muted">No bonus matches yet.</p> : null}
                    {groupBonusMatches.map((bonus) => (
                      <p key={bonus.id}>
                        Match #{bonus.match_id} - {bonus.label} x{bonus.multiplier}
                      </p>
                    ))}
                  </div>
                </section>
              ) : null}

              {selectedGroup ? (
                <section className="filter-panel">
                  <h2>Leaderboard ({leaderboardScope === 'weekly' ? 'Weekly' : 'Total'})</h2>
                  <div className="quick-status">
                    <button
                      type="button"
                      className={`chip ${leaderboardScope === 'total' ? 'chip-active' : ''}`}
                      onClick={() => setLeaderboardScope('total')}
                    >
                      Total
                    </button>
                    <button
                      type="button"
                      className={`chip ${leaderboardScope === 'weekly' ? 'chip-active' : ''}`}
                      onClick={() => setLeaderboardScope('weekly')}
                    >
                      Weekly
                    </button>
                  </div>
                  {groupLeaderboardLoading ? <p className="muted">Loading leaderboard...</p> : null}
                  {groupLeaderboard.length === 0 ? <p className="muted">No members in this group.</p> : null}
                  <div className="leaderboard-list">
                    {groupLeaderboard.map((row) => (
                      <article className="leaderboard-card" key={row.user_uid}>
                        <div className="leaderboard-rank">#{row.rank}</div>
                        <div className="leaderboard-user">
                          <strong>{row.email}</strong>
                          <p className="muted">
                            FT:{row.exact_ft_count} | HT:{row.exact_ht_count} | W:{row.winner_count} | Streak:{row.streak_days}
                          </p>
                        </div>
                        <div className="leaderboard-points">{row.points} pts</div>
                      </article>
                    ))}
                  </div>
                  {groupLeaderboardData?.rounds?.length ? (
                    <div className="invite-list">
                      <p>
                        <strong>Round History</strong>
                      </p>
                      {groupLeaderboardData.rounds.map((round) => (
                        <p key={round.round}>
                          Round {round.round}: {round.total_points} pts
                        </p>
                      ))}
                    </div>
                  ) : null}
                </section>
              ) : null}

              <section className="filter-panel points-guide">
                <h2>How Points Work</h2>
                <div className="points-list">
                  <p>Winner correct: <strong>+1</strong></p>
                  <p>Half-time exact score: <strong>+1</strong></p>
                  <p>Full-time exact score: <strong>+1</strong></p>
                  <p>Perfect prediction (winner + HT + FT all correct): <strong>+2 bonus</strong></p>
                  <p className="muted">Max normal score per match: 5 pts (group bonus multipliers can increase it).</p>
                </div>
              </section>
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
                    const isOpenForPrediction = isMatchOpenForPrediction(match, selectedGroup.prediction_lock_minutes);
                    const shouldReveal = isMatchStarted(match);
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
                              <span className="team-name-wrap">
                                {match.homeTeam.crest ? <img className="team-crest" src={match.homeTeam.crest} alt="" loading="lazy" /> : null}
                                <span className="team-name">{match.homeTeam.name}</span>
                              </span>
                              <strong className="team-score">{match.score?.fullTime?.home ?? '-'}</strong>
                            </div>
                            <div className="team-line">
                              <span className="team-name-wrap">
                                {match.awayTeam.crest ? <img className="team-crest" src={match.awayTeam.crest} alt="" loading="lazy" /> : null}
                                <span className="team-name">{match.awayTeam.name}</span>
                              </span>
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
                                  disabled={!isOpenForPrediction}
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
                                  disabled={!isOpenForPrediction}
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
                                  disabled={!isOpenForPrediction}
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
                                  disabled={!isOpenForPrediction}
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
                        {!isOpenForPrediction ? <p className="saved-line">Predictions locked for this match.</p> : null}
                        {saved && !shouldReveal ? (
                          <p className="saved-line">Predictions are private until kickoff starts.</p>
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
                                    {points.ready ? <span className="reveal-points">{points.total} pts</span> : null}
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

        {page === 'profile' ? (
          <section className="profile-shell">
            {!user ? (
              <article className="league-card empty">
                Login first to view your profile.
                <div className="auth-actions">
                  <button type="button" className="refresh" onClick={() => goToPage('game')}>
                    Go To Login
                  </button>
                </div>
              </article>
            ) : (
              <section className="filter-panel profile-card">
                <h2>Your Profile</h2>
                {profileLoading ? <p className="muted">Loading profile...</p> : null}
                <div className="selectors profile-grid">
                  <label>
                    Email
                    <input value={user.email ?? ''} type="email" disabled />
                  </label>
                  <label>
                    Display Name
                    <input
                      value={profileForm.displayName}
                      onChange={(e) => setProfileForm((prev) => ({ ...prev, displayName: e.target.value }))}
                      type="text"
                    />
                  </label>
                  <label>
                    First Name
                    <input
                      value={profileForm.firstName}
                      onChange={(e) => setProfileForm((prev) => ({ ...prev, firstName: e.target.value }))}
                      type="text"
                      autoComplete="given-name"
                    />
                  </label>
                  <label>
                    Last Name
                    <input
                      value={profileForm.lastName}
                      onChange={(e) => setProfileForm((prev) => ({ ...prev, lastName: e.target.value }))}
                      type="text"
                      autoComplete="family-name"
                    />
                  </label>
                  <label>
                    Country
                    <input
                      value={profileForm.country}
                      onChange={(e) => setProfileForm((prev) => ({ ...prev, country: e.target.value }))}
                      type="text"
                      autoComplete="country-name"
                    />
                  </label>
                  <label>
                    Favorite Team
                    <input
                      value={profileForm.favoriteTeam}
                      onChange={(e) => setProfileForm((prev) => ({ ...prev, favoriteTeam: e.target.value }))}
                      type="text"
                    />
                  </label>
                  <label className="profile-bio">
                    Bio
                    <textarea
                      value={profileForm.bio}
                      onChange={(e) => setProfileForm((prev) => ({ ...prev, bio: e.target.value }))}
                      rows={5}
                    />
                  </label>
                  <label>
                    Match Reminders
                    <select
                      value={responsibleForm.remindersEnabled ? 'on' : 'off'}
                      onChange={(e) =>
                        setResponsibleForm((prev) => ({ ...prev, remindersEnabled: e.target.value === 'on' }))
                      }
                    >
                      <option value="on">On</option>
                      <option value="off">Off</option>
                    </select>
                  </label>
                  <label>
                    Reminder Minutes Before Kickoff
                    <input
                      type="number"
                      min={5}
                      max={180}
                      value={responsibleForm.reminderMinutesBefore}
                      onChange={(e) =>
                        setResponsibleForm((prev) => ({ ...prev, reminderMinutesBefore: e.target.value }))
                      }
                    />
                  </label>
                  <label>
                    Weekly Summary
                    <select
                      value={responsibleForm.weeklySummaryEnabled ? 'on' : 'off'}
                      onChange={(e) =>
                        setResponsibleForm((prev) => ({ ...prev, weeklySummaryEnabled: e.target.value === 'on' }))
                      }
                    >
                      <option value="on">On</option>
                      <option value="off">Off</option>
                    </select>
                  </label>
                  <label>
                    Take A Break Until
                    <input
                      type="datetime-local"
                      value={responsibleForm.takeBreakUntil}
                      onChange={(e) =>
                        setResponsibleForm((prev) => ({ ...prev, takeBreakUntil: e.target.value }))
                      }
                    />
                  </label>
                </div>
                <div className="auth-actions">
                  <button type="button" className="refresh" disabled={profileSaving} onClick={() => void handleSaveProfile()}>
                    {profileSaving ? 'Saving...' : 'Save Profile'}
                  </button>
                  <button
                    type="button"
                    className="details-btn"
                    onClick={() => {
                      setProfileForm(profileToForm(profileRecord));
                      setResponsibleForm(profileToResponsibleForm(profileRecord));
                    }}
                    disabled={profileSaving}
                  >
                    Reset
                  </button>
                </div>
              </section>
            )}
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
                                <span className="team-name-wrap">
                                  {activeMatchDetails.homeTeam.crest ? (
                                    <img className="team-crest" src={activeMatchDetails.homeTeam.crest} alt="" loading="lazy" />
                                  ) : null}
                                  <strong>{activeMatchDetails.homeTeam.name}</strong>
                                </span>
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
                                <span className="team-name-wrap">
                                  {activeMatchDetails.awayTeam.crest ? (
                                    <img className="team-crest" src={activeMatchDetails.awayTeam.crest} alt="" loading="lazy" />
                                  ) : null}
                                  <strong>{activeMatchDetails.awayTeam.name}</strong>
                                </span>
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

        {perfectCongratsMatch ? (
          <div className="modal-overlay" onClick={() => setPerfectCongratsMatch(null)}>
            <section className="modal congrats-modal" onClick={(event) => event.stopPropagation()}>
              <header className="modal-header">
                <h3>Perfect Prediction!</h3>
                <button type="button" onClick={() => setPerfectCongratsMatch(null)}>
                  Close
                </button>
              </header>
              <p className="congrats-text">
                Congratulations! You nailed all picks for <strong>{perfectCongratsMatch}</strong> and earned the +2 perfect bonus.
              </p>
            </section>
          </div>
        ) : null}

        {error ? <p className="error">{error}</p> : null}
        {message ? <p className="muted">{message}</p> : null}
        {busy ? <p className="muted">Working...</p> : null}
      </main>
      <footer className="app-footer">
        <div className="app-footer-inner">
          <p>Copyright © {new Date().getFullYear()} PredictLeague. All rights reserved.</p>
        </div>
      </footer>
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

function isMatchOpenForPrediction(match: Match, lockMinutes = 0, now = new Date()) {
  if (!['SCHEDULED', 'TIMED'].includes(match.status)) {
    return false;
  }

  const kickoffMs = Date.parse(match.utcDate);
  if (Number.isNaN(kickoffMs)) {
    return false;
  }

  const normalizedLockMinutes = Number.isFinite(lockMinutes) ? Math.max(0, lockMinutes) : 0;
  const lockAt = kickoffMs - normalizedLockMinutes * 60_000;
  return lockAt > now.getTime();
}

function isMatchStarted(match: Match, now = new Date()) {
  if (!['SCHEDULED', 'TIMED'].includes(match.status)) {
    return true;
  }

  const kickoffMs = Date.parse(match.utcDate);
  if (Number.isNaN(kickoffMs)) {
    return false;
  }

  return now.getTime() >= kickoffMs;
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
  const perfectBonus = winner === 1 && ht === 1 && ft === 1 ? 2 : 0;

  return { ready: true, winner, ht, ft, total: winner + ht + ft + perfectBonus };
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
