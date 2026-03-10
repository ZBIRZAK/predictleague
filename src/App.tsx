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
  deleteGroup,
  loadGroupBonusMatches,
  loadGroupCustomMatches,
  loadGroupLeaderboard,
  loadGroupMembers,
  loadUserProfile,
  inviteMember,
  loadGroupsForUser,
  loadInvitesForGroup,
  loadPredictionsForGroup,
  savePrediction,
  sendSignupVerificationCode,
  updateGroupSettings,
  updateGroupCustomMatches,
  upsertUserProfile,
  upsertGroupBonusMatches,
  verifySignupVerificationCode,
  type AppGroup,
  type GroupBonusMatch,
  type GroupMember,
  type GroupLeaderboard,
  type GroupInvite,
  type GroupCustomMatch,
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
  footballDataSupported?: boolean;
};

type Team = {
  id?: number;
  name: string;
  shortName?: string;
  tla?: string;
  crest?: string;
  venue?: string;
  nickname?: string;
  color?: string;
  alternateColor?: string;
  form?: string;
  founded?: number;
  coach?: { name?: string; nationality?: string };
};

type Score = {
  winner?: 'HOME_TEAM' | 'AWAY_TEAM' | 'DRAW' | null;
  halfTime?: { home?: number | null; away?: number | null };
  fullTime?: { home?: number | null; away?: number | null };
};

type MatchIncident = {
  minute?: string;
  team?: string;
  player?: string;
  text?: string;
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
  incidents?: {
    goals?: MatchIncident[];
    yellowCards?: MatchIncident[];
    redCards?: MatchIncident[];
  };
};

type CompetitionResponse = {
  competitions: Competition[];
};

type MatchListResponse = {
  matches: Match[];
};

type StandingRow = {
  position: number;
  team: { id: number; name: string; shortName?: string; tla?: string; crest?: string };
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
  team?: { id?: number; name?: string; shortName?: string; tla?: string; crest?: string };
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
  goalPlayersHome: string;
  goalPlayersAway: string;
  yellowCardPlayersHome: string;
  yellowCardPlayersAway: string;
  redCardPlayersHome: string;
  redCardPlayersAway: string;
};

type PredictionSavePayload = {
  groupId: string;
  userUid: string;
  matchId: number;
  matchDate: string;
  htHome: number;
  htAway: number;
  ftHome: number;
  ftAway: number;
  goalPlayers: string[];
  yellowCardPlayers: string[];
  redCardPlayers: string[];
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
type ThemeMode = 'light' | 'dark';
const SIGNUP_CODE_RESEND_SECONDS = 45;

const statuses: Array<{ label: string; value: StatusFilter }> = [
  { label: 'All', value: '' },
  { label: 'Live', value: 'LIVE' },
  { label: 'Scheduled', value: 'SCHEDULED' },
  { label: 'Finished', value: 'FINISHED' }
];

const LIVE_MATCH_STATUSES = new Set([
  'LIVE',
  'IN_PLAY',
  'PAUSED',
  'HALF_TIME',
  'EXTRA_TIME',
  'PENALTY_SHOOTOUT',
  'SUSPENDED'
]);

const NON_SELECTABLE_CUSTOM_MATCH_STATUSES = new Set([
  'FINISHED',
  'FINAL',
  'FT',
  'FULL_TIME',
  'POSTPONED',
  'CANCELLED',
  'CANCELED',
  'AWARDED'
]);


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

function pickDefaultCompetitionId(competitions: Competition[]) {
  const preferredOrder = [2021, 2014, 2019, 2002, 2015, 2001];
  for (const id of preferredOrder) {
    const found = competitions.find((competition) => competition.id === id);
    if (found) return String(found.id);
  }
  return competitions[0] ? String(competitions[0].id) : '';
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

function parsePlayersInput(value: string) {
  return Array.from(
    new Set(
      value
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item.length > 0)
        .slice(0, 5)
    )
  );
}

const HOME_PICK_PREFIX = 'HOME::';
const AWAY_PICK_PREFIX = 'AWAY::';

function encodeTeamPlayerPicks(homeCsv: string, awayCsv: string) {
  const home = parsePlayersInput(homeCsv).map((name) => `${HOME_PICK_PREFIX}${name}`);
  const away = parsePlayersInput(awayCsv).map((name) => `${AWAY_PICK_PREFIX}${name}`);
  return [...home, ...away];
}

function splitTeamPlayerPicks(picks: string[] | undefined) {
  const home: string[] = [];
  const away: string[] = [];
  for (const raw of picks ?? []) {
    const value = String(raw ?? '').trim();
    if (!value) continue;
    if (value.startsWith(HOME_PICK_PREFIX)) {
      home.push(value.slice(HOME_PICK_PREFIX.length));
      continue;
    }
    if (value.startsWith(AWAY_PICK_PREFIX)) {
      away.push(value.slice(AWAY_PICK_PREFIX.length));
      continue;
    }
    home.push(value);
  }
  return {
    home: home.join(', '),
    away: away.join(', ')
  };
}

function normalizePlayerToken(value: string) {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s'-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function incidentPlayersForTeam(incidents: MatchIncident[] | undefined, team: Team) {
  if (!incidents?.length) return [] as string[];
  const candidates = [team.name, team.shortName, team.tla]
    .map((value) => normalizePlayerToken(String(value ?? '')))
    .filter(Boolean);
  const matchesTeam = (incidentTeam: string) => {
    const normalizedIncidentTeam = normalizePlayerToken(incidentTeam);
    if (!normalizedIncidentTeam) return true;
    return candidates.some(
      (candidate) =>
        normalizedIncidentTeam === candidate ||
        normalizedIncidentTeam.includes(candidate) ||
        candidate.includes(normalizedIncidentTeam)
    );
  };
  return incidents
    .filter((item) => matchesTeam(String(item.team ?? '')))
    .map((item) => String(item.player ?? '').trim())
    .filter(Boolean);
}

function normalizePlayerPicksCsv(value: string) {
  return parsePlayersInput(value)
    .map((item) => normalizePlayerToken(item))
    .filter(Boolean)
    .sort();
}

function areStringArraysEqual(left: string[], right: string[]) {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

function isPredictionDraftDirty(draft: PredictionDraft, saved: MatchPrediction | undefined) {
  const hasAnyDraftValue = [
    draft.htHome,
    draft.htAway,
    draft.ftHome,
    draft.ftAway,
    draft.goalPlayersHome,
    draft.goalPlayersAway,
    draft.yellowCardPlayersHome,
    draft.yellowCardPlayersAway,
    draft.redCardPlayersHome,
    draft.redCardPlayersAway
  ].some((value) => value.trim() !== '');

  if (!saved) return hasAnyDraftValue;

  const draftHtHome = draft.htHome.trim() === '' ? null : Number(draft.htHome);
  const draftHtAway = draft.htAway.trim() === '' ? null : Number(draft.htAway);
  const draftFtHome = draft.ftHome.trim() === '' ? null : Number(draft.ftHome);
  const draftFtAway = draft.ftAway.trim() === '' ? null : Number(draft.ftAway);

  if (
    !Number.isFinite(draftHtHome) ||
    !Number.isFinite(draftHtAway) ||
    !Number.isFinite(draftFtHome) ||
    !Number.isFinite(draftFtAway)
  ) {
    return true;
  }

  if (
    draftHtHome !== saved.ht_home ||
    draftHtAway !== saved.ht_away ||
    draftFtHome !== saved.ft_home ||
    draftFtAway !== saved.ft_away
  ) {
    return true;
  }

  const savedGoal = splitTeamPlayerPicks(saved.goal_players);
  const savedYellow = splitTeamPlayerPicks(saved.yellow_card_players);
  const savedRed = splitTeamPlayerPicks(saved.red_card_players);

  return (
    !areStringArraysEqual(normalizePlayerPicksCsv(draft.goalPlayersHome), normalizePlayerPicksCsv(savedGoal.home)) ||
    !areStringArraysEqual(normalizePlayerPicksCsv(draft.goalPlayersAway), normalizePlayerPicksCsv(savedGoal.away)) ||
    !areStringArraysEqual(normalizePlayerPicksCsv(draft.yellowCardPlayersHome), normalizePlayerPicksCsv(savedYellow.home)) ||
    !areStringArraysEqual(normalizePlayerPicksCsv(draft.yellowCardPlayersAway), normalizePlayerPicksCsv(savedYellow.away)) ||
    !areStringArraysEqual(normalizePlayerPicksCsv(draft.redCardPlayersHome), normalizePlayerPicksCsv(savedRed.home)) ||
    !areStringArraysEqual(normalizePlayerPicksCsv(draft.redCardPlayersAway), normalizePlayerPicksCsv(savedRed.away))
  );
}

function isSelectableCustomMatch(match: Match) {
  const status = String(match.status ?? '').trim().toUpperCase();
  return !NON_SELECTABLE_CUSTOM_MATCH_STATUSES.has(status);
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

function PlayerPicksInput({
  label,
  title,
  value,
  options,
  actualPlayers,
  showResultState = false,
  disabled,
  onChange,
  compact = false
}: {
  label: string;
  title: string;
  value: string;
  options: string[];
  actualPlayers?: string[];
  showResultState?: boolean;
  disabled: boolean;
  onChange: (next: string) => void;
  compact?: boolean;
}) {
  const [selected, setSelected] = useState('');
  const picks = useMemo(() => parsePlayersInput(value), [value]);
  const available = useMemo(
    () => options.filter((name) => !picks.some((pick) => pick.toLowerCase() === name.toLowerCase())),
    [options, picks]
  );
  const actualSet = useMemo(
    () => new Set((actualPlayers ?? []).map((name) => normalizePlayerToken(String(name ?? ''))).filter(Boolean)),
    [actualPlayers]
  );

  const addSelected = () => {
    if (disabled) return;
    const candidate = selected.trim();
    if (!candidate) return;
    const next = parsePlayersInput([...picks, candidate].join(', '));
    onChange(next.join(', '));
    setSelected('');
  };

  const removePick = (item: string) => {
    if (disabled) return;
    const next = picks.filter((pick) => pick !== item);
    onChange(next.join(', '));
  };

  return (
    <div className={`player-picks ${compact ? 'player-picks-compact' : ''}`}>
      {!compact ? (
        <span className="player-picks-head" title={title} aria-label={title}>
          {label}
        </span>
      ) : null}
      <div className={`player-picks-box ${disabled ? 'player-picks-box-disabled' : ''}`}>
        {!disabled ? (
          <div className="player-picker-actions">
            <select value={selected} onChange={(e) => setSelected(e.target.value)} aria-label={title}>
              <option value="">{available.length > 0 ? 'Select player' : 'No players available'}</option>
              {available.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
            <button type="button" className="details-btn" disabled={!selected} onClick={addSelected}>
              Add
            </button>
          </div>
        ) : null}
        <div className="player-picks-chips">
          {picks.length === 0 && !compact ? <span className="player-picks-empty">No players selected</span> : null}
          {picks.map((pick) => (
            <span
              key={pick}
              className={`player-pick-chip ${
                showResultState ? (actualSet.has(normalizePlayerToken(pick)) ? 'player-pick-chip-hit' : 'player-pick-chip-miss') : ''
              }`}
            >
              {pick}
              {!disabled ? (
                <button type="button" onClick={() => removePick(pick)} aria-label={`Remove ${pick}`}>
                  ×
                </button>
              ) : null}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

function App() {
  const today = useMemo(() => getTodayLocalDateInputValue(), []);
  const [page, setPage] = useState<AppPage>(() => getPageFromHash(window.location.hash));
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => {
    const saved = window.localStorage.getItem('predileague-theme');
    return saved === 'dark' ? 'dark' : 'light';
  });

  const [authReady, setAuthReady] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [authLoading, setAuthLoading] = useState(false);
  const [authMode, setAuthMode] = useState<'login' | 'signup'>('login');
  const [signupVerificationCode, setSignupVerificationCode] = useState('');
  const [signupCodeSent, setSignupCodeSent] = useState(false);
  const [signupCodeEmail, setSignupCodeEmail] = useState('');
  const [signupCodeCooldownEndsAt, setSignupCodeCooldownEndsAt] = useState(0);
  const [signupCodeCooldownLeft, setSignupCodeCooldownLeft] = useState(0);
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
  const [newGroupMatchMode, setNewGroupMatchMode] = useState<'competition' | 'custom'>('competition');
  const [newGroupCustomMatchDate, setNewGroupCustomMatchDate] = useState(today);
  const [newGroupCustomPool, setNewGroupCustomPool] = useState<Match[]>([]);
  const [newGroupCustomPoolLoading, setNewGroupCustomPoolLoading] = useState(false);
  const [newGroupCustomCompetitionFilter, setNewGroupCustomCompetitionFilter] = useState('');
  const [newGroupCustomCountryFilter, setNewGroupCustomCountryFilter] = useState('');
  const [newGroupCustomMatchIds, setNewGroupCustomMatchIds] = useState<number[]>([]);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteSending, setInviteSending] = useState(false);
  const [groupDeleting, setGroupDeleting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [savingAll, setSavingAll] = useState(false);
  const [groupMatchesLoading, setGroupMatchesLoading] = useState(false);
  const [selectedGroupCustomMatches, setSelectedGroupCustomMatches] = useState<GroupCustomMatch[]>([]);
  const [selectedGroupCustomPool, setSelectedGroupCustomPool] = useState<Match[]>([]);
  const [selectedGroupCustomPoolLoading, setSelectedGroupCustomPoolLoading] = useState(false);
  const [selectedGroupCustomCompetitionFilter, setSelectedGroupCustomCompetitionFilter] = useState('');
  const [selectedGroupCustomCountryFilter, setSelectedGroupCustomCountryFilter] = useState('');
  const [customSelectionSaving, setCustomSelectionSaving] = useState(false);
  const [perfectCongratsMatch, setPerfectCongratsMatch] = useState<string | null>(null);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const shownPerfectCongratsRef = useRef<Set<string>>(new Set());
  const profileMenuRef = useRef<HTMLDivElement | null>(null);

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
  const footballDataCompetitions = useMemo(
    () => competitions.filter((competition) => competition.footballDataSupported),
    [competitions]
  );
  const standingsCompetitions = useMemo(() => footballDataCompetitions, [footballDataCompetitions]);

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

  const unsavedDraftCount = useMemo(() => {
    let total = 0;
    for (const match of groupMatches) {
      const draft = predictionDrafts[match.id];
      if (!draft) continue;
      if (isPredictionDraftDirty(draft, myPredictions[match.id])) {
        total += 1;
      }
    }
    return total;
  }, [groupMatches, myPredictions, predictionDrafts]);

  const selectableSelectedGroupCustomPool = useMemo(
    () => selectedGroupCustomPool.filter(isSelectableCustomMatch),
    [selectedGroupCustomPool]
  );

  const selectedGroupCustomCompetitionOptions = useMemo(() => {
    return Array.from(
      new Set(
        selectableSelectedGroupCustomPool
          .map((match) => match.competition?.name?.trim())
          .filter((value): value is string => Boolean(value))
      )
    ).sort((a, b) => a.localeCompare(b));
  }, [selectableSelectedGroupCustomPool]);

  const selectedGroupCustomCountryOptions = useMemo(() => {
    return Array.from(
      new Set(
        selectableSelectedGroupCustomPool
          .map((match) => (match.competition?.area?.name ?? match.area?.name ?? '').trim())
          .filter((value): value is string => Boolean(value))
      )
    ).sort((a, b) => a.localeCompare(b));
  }, [selectableSelectedGroupCustomPool]);

  const filteredSelectedGroupCustomPool = useMemo(() => {
    return selectableSelectedGroupCustomPool.filter((match) => {
      const competitionName = (match.competition?.name ?? '').trim();
      const countryName = (match.competition?.area?.name ?? match.area?.name ?? '').trim();
      if (selectedGroupCustomCompetitionFilter && competitionName !== selectedGroupCustomCompetitionFilter) {
        return false;
      }
      if (selectedGroupCustomCountryFilter && countryName !== selectedGroupCustomCountryFilter) {
        return false;
      }
      return true;
    });
  }, [
    selectableSelectedGroupCustomPool,
    selectedGroupCustomCompetitionFilter,
    selectedGroupCustomCountryFilter
  ]);

  const newGroupCustomCompetitionOptions = useMemo(() => {
    return Array.from(
      new Set(newGroupCustomPool.map((match) => match.competition?.name?.trim()).filter((value): value is string => Boolean(value)))
    ).sort((a, b) => a.localeCompare(b));
  }, [newGroupCustomPool]);

  const newGroupCustomCountryOptions = useMemo(() => {
    return Array.from(
      new Set(
        newGroupCustomPool
          .map((match) => (match.competition?.area?.name ?? match.area?.name ?? '').trim())
          .filter((value): value is string => Boolean(value))
      )
    ).sort((a, b) => a.localeCompare(b));
  }, [newGroupCustomPool]);

  const filteredNewGroupCustomPool = useMemo(() => {
    return newGroupCustomPool.filter((match) => {
      const competitionName = (match.competition?.name ?? '').trim();
      const countryName = (match.competition?.area?.name ?? match.area?.name ?? '').trim();
      if (newGroupCustomCompetitionFilter && competitionName !== newGroupCustomCompetitionFilter) {
        return false;
      }
      if (newGroupCustomCountryFilter && countryName !== newGroupCustomCountryFilter) {
        return false;
      }
      return true;
    });
  }, [newGroupCustomCompetitionFilter, newGroupCustomCountryFilter, newGroupCustomPool]);

  useEffect(() => {
    const onHashChange = () => {
      setPage(getPageFromHash(window.location.hash));
    };

    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', themeMode);
    window.localStorage.setItem('predileague-theme', themeMode);
  }, [themeMode]);

  useEffect(() => {
    return onAuthStateChanged(firebaseAuth, (nextUser) => {
      setUser(nextUser);
      setAuthReady(true);
    });
  }, []);

  useEffect(() => {
    if (authMode !== 'signup') {
      setSignupVerificationCode('');
      setSignupCodeSent(false);
      setSignupCodeEmail('');
      setSignupCodeCooldownEndsAt(0);
      setSignupCodeCooldownLeft(0);
    }
  }, [authMode]);

  useEffect(() => {
    if (signupCodeCooldownEndsAt <= Date.now()) {
      setSignupCodeCooldownLeft(0);
      return;
    }

    const tick = () => {
      const remainingMs = Math.max(0, signupCodeCooldownEndsAt - Date.now());
      setSignupCodeCooldownLeft(Math.ceil(remainingMs / 1000));
    };

    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [signupCodeCooldownEndsAt]);

  useEffect(() => {
    void loadCompetitions();
  }, []);

  useEffect(() => {
    if (newGroupMatchMode !== 'custom') {
      setNewGroupCustomPool([]);
      setNewGroupCustomMatchIds([]);
      setNewGroupCustomCompetitionFilter('');
      setNewGroupCustomCountryFilter('');
      return;
    }
    let cancelled = false;
    const load = async () => {
      try {
        setNewGroupCustomPoolLoading(true);
        const matches = (await loadAllMatchesForDate(newGroupCustomMatchDate)).filter(isSelectableCustomMatch);
        if (cancelled) return;
        setNewGroupCustomPool(matches);
        const validIds = new Set(matches.map((item) => item.id));
        setNewGroupCustomMatchIds((prev) => prev.filter((id) => validIds.has(id)));
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load matches for custom selection.');
        }
      } finally {
        if (!cancelled) {
          setNewGroupCustomPoolLoading(false);
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [newGroupMatchMode, newGroupCustomMatchDate]);

  useEffect(() => {
    if (!standingsCompetitionId && standingsCompetitions.length > 0) {
      setStandingsCompetitionId(String(standingsCompetitions[0].id));
      return;
    }
    if (standingsCompetitionId && !standingsCompetitions.some((competition) => String(competition.id) === standingsCompetitionId)) {
      setStandingsCompetitionId(standingsCompetitions[0] ? String(standingsCompetitions[0].id) : '');
    }
  }, [standingsCompetitionId, standingsCompetitions]);

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
      setProfileMenuOpen(false);
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
    if (!profileMenuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (profileMenuRef.current?.contains(target)) return;
      setProfileMenuOpen(false);
    };
    window.addEventListener('pointerdown', onPointerDown);
    return () => window.removeEventListener('pointerdown', onPointerDown);
  }, [profileMenuOpen]);

  useEffect(() => {
    if (!user || !selectedGroup) {
      setGroupMatches([]);
      setSelectedGroupCustomMatches([]);
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
    if (page !== 'game' || !selectedGroup || !user) return;

    const tick = () => {
      if (document.visibilityState !== 'visible') return;
      void refreshGroupMatchesOnly(selectedGroup);
      void refreshGroupRealtimeData(selectedGroup, user.uid, leaderboardScope);
    };

    tick();

    const intervalId = window.setInterval(() => {
      tick();
    }, 15000);

    const onVisibilityChange = () => tick();
    const onFocus = () => tick();
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('focus', onFocus);

    return () => {
      window.clearInterval(intervalId);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('focus', onFocus);
    };
  }, [page, selectedGroup, user, today, leaderboardScope]);

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

  useEffect(() => {
    if (!selectedGroup || selectedGroup.match_selection_mode !== 'custom') {
      setSelectedGroupCustomPool([]);
      setSelectedGroupCustomCompetitionFilter('');
      setSelectedGroupCustomCountryFilter('');
      return;
    }
    let cancelled = false;
    const load = async () => {
      try {
        setSelectedGroupCustomPoolLoading(true);
        const matches = (await loadAllMatchesForDate(today)).filter(isSelectableCustomMatch);
        if (cancelled) return;
        setSelectedGroupCustomPool(matches);
      } catch {
        if (!cancelled) {
          setSelectedGroupCustomPool([]);
        }
      } finally {
        if (!cancelled) {
          setSelectedGroupCustomPoolLoading(false);
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [selectedGroup?.id, selectedGroup?.match_selection_mode, today]);

  useEffect(() => {
    if (groupMatches.length === 0) return;
    const teamIds = Array.from(
      new Set(
        groupMatches
          .flatMap((match) => [match.homeTeam.id, match.awayTeam.id])
          .filter((id): id is number => typeof id === 'number')
      )
    );
    const missingTeamIds = teamIds.filter((teamId) => !teamDetailsById[teamId]);
    if (missingTeamIds.length === 0) return;

    let cancelled = false;
    const load = async () => {
      try {
        setTeamDetailsLoading(true);
        const entries = await Promise.all(
          missingTeamIds.map(async (teamId) => {
            const teamDetails = await loadTeamById(teamId);
            return [teamId, teamDetails] as const;
          })
        );
        if (cancelled) return;
        const nextMap: Record<number, TeamDetails> = {};
        for (const [teamId, teamDetails] of entries) {
          if (teamDetails) nextMap[teamId] = teamDetails;
        }
        setTeamDetailsById((prev) => ({ ...prev, ...nextMap }));
      } finally {
        if (!cancelled) setTeamDetailsLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [groupMatches, teamDetailsById]);

  async function loadCompetitions() {
    try {
      const response = await fetch('/api/v4/competitions');
      if (!response.ok) {
        throw new Error('Failed to fetch competitions.');
      }

      const payload = (await response.json()) as CompetitionResponse;
      const sorted = (payload.competitions ?? []).sort((a, b) => a.name.localeCompare(b.name));
      setCompetitions(sorted);
      const supported = sorted.filter((competition) => competition.footballDataSupported);
      setStandingsCompetitionId((prev) => {
        if (prev && supported.some((competition) => String(competition.id) === prev)) {
          return prev;
        }
        return pickDefaultCompetitionId(supported);
      });
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
    const response = await fetch(`/api/v4/competitions/${competitionId}/matches?${query.toString()}`, { cache: 'no-store' });
    if (!response.ok) {
      throw new Error('Failed to fetch today matches.');
    }

    const payload = (await response.json()) as MatchListResponse;
    return (payload.matches ?? []).filter((match) => toLocalDateInputValue(match.utcDate) === targetDate);
  }

  async function loadAllMatchesForDate(targetDate: string) {
    const query = new URLSearchParams({ dateFrom: targetDate, dateTo: targetDate });
    const response = await fetch(`/api/v4/matches?${query.toString()}`, { cache: 'no-store' });
    if (!response.ok) {
      throw new Error('Failed to fetch matches.');
    }
    const payload = (await response.json()) as MatchListResponse;
    return (payload.matches ?? []).filter((match) => toLocalDateInputValue(match.utcDate) === targetDate);
  }

  async function loadMatchById(matchId: number) {
    const response = await fetch(`/api/v4/matches/${matchId}`, { cache: 'no-store' });
    if (!response.ok) {
      return null;
    }
    const payload = (await response.json()) as { match?: Match } & Match;
    return payload.match ?? payload;
  }

  async function loadMatchesByIds(matchIds: number[]) {
    const uniqueIds = Array.from(new Set(matchIds.filter((value) => Number.isFinite(value) && value > 0)));
    const rows = await Promise.all(
      uniqueIds.map(async (matchId) => {
        const match = await loadMatchById(matchId);
        return match;
      })
    );
    return rows.filter((row): row is Match => Boolean(row));
  }

  async function loadMatchesForGroupSelection(group: AppGroup, targetDate: string) {
    if (group.match_selection_mode === 'custom') {
      const selected = await loadGroupCustomMatches(group.id, targetDate);
      setSelectedGroupCustomMatches(selected);
      const matches = await loadMatchesByIds(selected.map((item) => item.match_id));
      return matches
        .filter((match) => toLocalDateInputValue(match.utcDate) === targetDate)
        .sort((a, b) => Date.parse(a.utcDate) - Date.parse(b.utcDate));
    }
    setSelectedGroupCustomMatches([]);
    return loadMatchesForCompetition(group.competition_id, targetDate);
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

  async function handleSaveCustomSelection() {
    if (!selectedGroup) return;
    if (!isGroupOwner) {
      setError('Only group owner can update custom match selection.');
      return;
    }
    if (selectedGroup.match_selection_mode !== 'custom') {
      setError('This group uses competition mode.');
      return;
    }

    const matchIds = groupMatches.map((match) => match.id);
    try {
      setCustomSelectionSaving(true);
      setError('');
      const rows = await updateGroupCustomMatches(selectedGroup.id, {
        matchDate: today,
        matchIds
      });
      setSelectedGroupCustomMatches(rows);
      setMessage('Custom match selection updated.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save custom match selection.');
    } finally {
      setCustomSelectionSaving(false);
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
        loadMatchesForGroupSelection(group, today)
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
        const goalSplit = splitTeamPlayerPicks(prediction?.goal_players);
        const yellowSplit = splitTeamPlayerPicks(prediction?.yellow_card_players);
        const redSplit = splitTeamPlayerPicks(prediction?.red_card_players);
        nextDrafts[match.id] = {
          htHome: prediction ? String(prediction.ht_home) : '',
          htAway: prediction ? String(prediction.ht_away) : '',
          ftHome: prediction ? String(prediction.ft_home) : '',
          ftAway: prediction ? String(prediction.ft_away) : '',
          goalPlayersHome: goalSplit.home,
          goalPlayersAway: goalSplit.away,
          yellowCardPlayersHome: yellowSplit.home,
          yellowCardPlayersAway: yellowSplit.away,
          redCardPlayersHome: redSplit.home,
          redCardPlayersAway: redSplit.away
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

  async function refreshGroupMatchesOnly(group: AppGroup) {
    try {
      const latestMatches = await loadMatchesForGroupSelection(group, today);
      const liveMatches = latestMatches.filter((match) => LIVE_MATCH_STATUSES.has(String(match.status ?? '').toUpperCase()));
      if (liveMatches.length === 0) {
        setGroupMatches(latestMatches);
        return;
      }

      const detailedEntries = await Promise.all(
        liveMatches.map(async (match) => {
          const details = await loadMatchById(match.id);
          return [match.id, details] as const;
        })
      );
      const detailsById = new Map<number, Match>();
      for (const [matchId, details] of detailedEntries) {
        if (details) detailsById.set(matchId, details);
      }
      setGroupMatches(latestMatches.map((match) => detailsById.get(match.id) ?? match));
    } catch {
      // Ignore background refresh failures and keep current UI state.
    }
  }

  async function refreshGroupRealtimeData(group: AppGroup, userUid: string, scope: 'total' | 'weekly') {
    try {
      const [predictionRows, leaderboardData, inviteRows] = await Promise.all([
        loadPredictionsForGroup({ groupId: group.id, matchDate: today }),
        loadGroupLeaderboard({
          groupId: group.id,
          scope,
          referenceDate: `${today}T00:00:00.000Z`
        }),
        loadInvitesForGroup(group.id)
      ]);

      const mine = predictionRows.filter((row) => row.user_uid === userUid);
      const mineMap = Object.fromEntries(mine.map((row) => [row.match_id, row]));
      setMyPredictions(mineMap);

      const byMatch: Record<number, MatchPrediction[]> = {};
      for (const row of predictionRows) {
        byMatch[row.match_id] = byMatch[row.match_id] ?? [];
        byMatch[row.match_id].push(row);
      }
      setGroupPredictionsByMatch(byMatch);
      setGroupLeaderboardData(leaderboardData);
      setInvites(inviteRows);
    } catch {
      // Ignore transient polling failures.
    }
  }

  async function handleRegister() {
    const normalizedEmail = email.trim().toLowerCase();
    if (!isValidEmailAddress(normalizedEmail)) {
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

    if (!signupCodeSent || signupCodeEmail !== normalizedEmail) {
      if (signupCodeCooldownLeft > 0) {
        setError(`Please wait ${signupCodeCooldownLeft}s before requesting another code.`);
        return;
      }
      try {
        setAuthLoading(true);
        setError('');
        setMessage('');
        await sendSignupVerificationCode(normalizedEmail);
        setSignupCodeSent(true);
        setSignupCodeEmail(normalizedEmail);
        setSignupCodeCooldownEndsAt(Date.now() + SIGNUP_CODE_RESEND_SECONDS * 1000);
        setMessage('Verification code sent. Enter the 6-digit code to finish signup.');
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to send verification code.');
      } finally {
        setAuthLoading(false);
      }
      return;
    }

    if (!/^\d{6}$/.test(signupVerificationCode.trim())) {
      setError('Enter the 6-digit verification code.');
      return;
    }

    try {
      setAuthLoading(true);
      setError('');
      setMessage('');
      await verifySignupVerificationCode(normalizedEmail, signupVerificationCode.trim());
      const credential = await createUserWithEmailAndPassword(firebaseAuth, normalizedEmail, password);
      await upsertUserProfile({
        userUid: credential.user.uid,
        email: credential.user.email ?? normalizedEmail,
        firstName: signupProfile.firstName,
        lastName: signupProfile.lastName,
        displayName: signupProfile.displayName,
        country: signupProfile.country,
        favoriteTeam: signupProfile.favoriteTeam,
        bio: signupProfile.bio
      });
      setConfirmPassword('');
      setPassword('');
      setSignupVerificationCode('');
      setSignupCodeSent(false);
      setSignupCodeEmail('');
      setMessage('Account created. You are signed in.');
    } catch (err) {
      setError(mapFirebaseAuthError(err, 'Registration failed.'));
    } finally {
      setAuthLoading(false);
    }
  }

  async function handleSendSignupCode() {
    const normalizedEmail = email.trim().toLowerCase();
    if (!isValidEmailAddress(normalizedEmail)) {
      setError('Enter a valid email address before requesting a verification code.');
      return;
    }
    if (signupCodeCooldownLeft > 0) {
      setError(`Please wait ${signupCodeCooldownLeft}s before requesting another code.`);
      return;
    }

    try {
      setAuthLoading(true);
      setError('');
      setMessage('');
      await sendSignupVerificationCode(normalizedEmail);
      setSignupCodeSent(true);
      setSignupCodeEmail(normalizedEmail);
      setSignupCodeCooldownEndsAt(Date.now() + SIGNUP_CODE_RESEND_SECONDS * 1000);
      setMessage(`Verification code sent to ${normalizedEmail}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send verification code.');
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
    if (!newGroupName.trim()) {
      setError('Group name is required.');
      return;
    }
    if (newGroupMatchMode === 'competition' && !selectedCompetition) {
      setError('Competition is required for competition mode.');
      return;
    }
    if (newGroupMatchMode === 'custom' && newGroupCustomMatchIds.length === 0) {
      setError('Select at least one custom match.');
      return;
    }

    try {
      setBusy(true);
      setError('');
      const group = await createGroup({
        ownerUid: user.uid,
        ownerEmail: user.email,
        name: newGroupName,
        competitionId: selectedCompetition?.id ?? 0,
        competitionName: selectedCompetition?.name ?? 'Custom Matches',
        matchSelectionMode: newGroupMatchMode,
        customMatchDate: newGroupMatchMode === 'custom' ? newGroupCustomMatchDate : undefined,
        customMatches: newGroupMatchMode === 'custom' ? newGroupCustomMatchIds : undefined
      });

      setGroups((prev) => [group, ...prev]);
      setSelectedGroupId(group.id);
      setNewGroupName('');
      setNewGroupCompetitionId('');
      setNewGroupMatchMode('competition');
      setNewGroupCustomMatchIds([]);
      setMessage('Group created.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create group.');
    } finally {
      setBusy(false);
    }
  }

  async function handleDeleteGroupById(group: AppGroup) {
    if (!user) return;
    const isOwner = group.owner_uid === user.uid;
    if (!isOwner) {
      setError('Only group owner can delete this group.');
      return;
    }
    const confirmed = window.confirm(`Delete group "${group.name}"?\n\nThis action cannot be undone.`);
    if (!confirmed) return;

    try {
      setGroupDeleting(true);
      setError('');
      await deleteGroup(group.id);
      setGroups((prev) => prev.filter((row) => row.id !== group.id));
      setSelectedGroupId((prev) => (prev === group.id ? '' : prev));
      setMessage(`Group "${group.name}" deleted.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete group.');
    } finally {
      setGroupDeleting(false);
    }
  }

  async function handleDeleteSelectedGroup() {
    if (!selectedGroup) return;
    await handleDeleteGroupById(selectedGroup);
  }

  function toggleNewGroupCustomMatch(matchId: number) {
    setNewGroupCustomMatchIds((prev) => (prev.includes(matchId) ? prev.filter((id) => id !== matchId) : [...prev, matchId]));
  }

  function toggleSelectedGroupCustomMatch(match: Match) {
    setGroupMatches((prev) => {
      const exists = prev.some((item) => item.id === match.id);
      if (exists) return prev.filter((item) => item.id !== match.id);
      return [...prev, match].sort((a, b) => Date.parse(a.utcDate) - Date.parse(b.utcDate));
    });
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

  function buildPredictionPayload(match: Match, draft: PredictionDraft): { payload: PredictionSavePayload } | { error: string } {
    const values = [draft.htHome, draft.htAway, draft.ftHome, draft.ftAway];
    if (values.some((value) => value === '')) {
      return { error: 'Fill HT and FT scores first.' };
    }

    const numeric = values.map((value) => Number(value));
    if (numeric.some((value) => Number.isNaN(value) || value < 0)) {
      return { error: 'Prediction values must be numbers >= 0.' };
    }

    if (!selectedGroup || !user) {
      return { error: 'You need to be logged in and select a group.' };
    }

    return {
      payload: {
        groupId: selectedGroup.id,
        userUid: user.uid,
        matchId: match.id,
        matchDate: today,
        htHome: numeric[0],
        htAway: numeric[1],
        ftHome: numeric[2],
        ftAway: numeric[3],
        goalPlayers: encodeTeamPlayerPicks(draft.goalPlayersHome, draft.goalPlayersAway),
        yellowCardPlayers: encodeTeamPlayerPicks(draft.yellowCardPlayersHome, draft.yellowCardPlayersAway),
        redCardPlayers: encodeTeamPlayerPicks(draft.redCardPlayersHome, draft.redCardPlayersAway)
      }
    };
  }

  async function handleSaveAllPredictions() {
    if (!user || !selectedGroup) {
      return;
    }

    const payloads: PredictionSavePayload[] = [];
    let lockedMatches = 0;

    for (const match of groupMatches) {
      if (!isMatchOpenForPrediction(match, selectedGroup.prediction_lock_minutes)) {
        lockedMatches += 1;
        continue;
      }

      const draft = predictionDrafts[match.id];
      if (!draft) continue;
      const built = buildPredictionPayload(match, draft);
      if ('error' in built) {
        if (built.error.includes('numbers')) {
          setError('One or more predictions are invalid. Use numbers >= 0.');
          return;
        }
        continue;
      }

      payloads.push(built.payload);
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
        <main className="auth-loading-screen">
          <img
            className="auth-loading-logo"
            src={themeMode === 'dark' ? '/brand-logo-dark.svg' : '/brand-logo-light.svg'}
            alt="predileague.com"
          />
        </main>
      </div>
    );
  }

  const headerContextLabel =
    page === 'home' ? 'Home Matches' : page === 'game' ? 'Game' : user ? 'Your Profile' : 'Profile';
  const isGroupOwner = Boolean(user && selectedGroup && selectedGroup.owner_uid === user.uid);
  const profileDisplayName =
    profileRecord?.display_name?.trim() || user?.displayName?.trim() || user?.email?.split('@')[0] || 'User';
  const profileInitial = profileDisplayName.charAt(0).toUpperCase();

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-inner">
          <div className="topbar-brand">
            <img
              className="brand-logo"
              src={themeMode === 'dark' ? '/brand-logo-dark.svg' : '/brand-logo-light.svg'}
              alt="predileague.com - Predict Today. Top the League."
            />
            <div className="topbar-meta">
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
              Let's Play
            </button>
          </nav>

          <div className="topbar-action">
            <button
              type="button"
              className="chip theme-toggle"
              onClick={() => setThemeMode((prev) => (prev === 'light' ? 'dark' : 'light'))}
              aria-label={themeMode === 'light' ? 'Switch to dark theme' : 'Switch to light theme'}
              title={themeMode === 'light' ? 'Switch to dark theme' : 'Switch to light theme'}
            >
              {themeMode === 'light' ? 'Dark' : 'Light'}
            </button>
            {user ? (
              <div className="profile-menu-wrap" ref={profileMenuRef}>
                <button
                  type="button"
                  className="profile-menu-trigger"
                  aria-haspopup="menu"
                  aria-expanded={profileMenuOpen}
                  onClick={() => setProfileMenuOpen((prev) => !prev)}
                >
                  <span className="profile-avatar" aria-hidden="true">
                    {profileInitial}
                  </span>
                  <span className="topbar-context">{profileDisplayName}</span>
                </button>
                {profileMenuOpen ? (
                  <div className="profile-menu-dropdown" role="menu" aria-label="User menu">
                    <button
                      type="button"
                      role="menuitem"
                      className="profile-menu-item"
                      onClick={() => {
                        setProfileMenuOpen(false);
                        goToPage('profile');
                      }}
                    >
                      User info
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      className="profile-menu-item profile-menu-item-danger"
                      onClick={() => {
                        setProfileMenuOpen(false);
                        void handleLogout();
                      }}
                    >
                      Logout
                    </button>
                  </div>
                ) : null}
              </div>
            ) : (
              <span className="topbar-context">Guest mode</span>
            )}
          </div>
        </div>
      </header>

      <main className="layout">
        {page === 'home' ? (
          <section className="home-grid">
            <div className="home-main">
              <section className="filter-panel">
                <h2>Home Matches</h2>
                <p className="muted">
                  Explore today football match prediction insights, today match prediction picks, soccer predictions today,
                  and prediction for today games. Build each prediction match in your group and join our world cup predictor
                  game challenges.
                </p>
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
                      {footballDataCompetitions.map((competition) => (
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

              <section
                className="filter-panel important-panel"
                style={
                  {
                    '--left-accent': importantMatch ? getTeamAccentColor(importantMatch.homeTeam) : '#2f8f6b',
                    '--right-accent': importantMatch ? getTeamAccentColor(importantMatch.awayTeam) : '#2c5f9f'
                  } as CSSProperties
                }
              >
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
                        // Use a composite key to avoid row/logo reuse if provider IDs collide across competitions.
                        <div
                          className="match-row match-row-clickable"
                          key={`${match.id}-${match.utcDate}-${match.homeTeam.name}-${match.awayTeam.name}-${match.competition?.name ?? ''}`}
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
                      <option value="">Select competition (ESPN-supported)</option>
                      {standingsCompetitions.map((competition) => (
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
                {standingsCompetitionId && standingsCompetitions.length === 0 ? (
                  <p className="muted">No football-data-supported competitions loaded yet.</p>
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
                            <td>
                              <span className="standings-team-cell">
                                {row.team.crest ? (
                                  <img className="table-team-crest" src={row.team.crest} alt="" loading="lazy" />
                                ) : null}
                                <span>{row.team.shortName ?? row.team.name}</span>
                              </span>
                            </td>
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
                            <span className="scorer-team-line">
                              {scorer.team?.crest ? (
                                <img className="table-team-crest" src={scorer.team.crest} alt="" loading="lazy" />
                              ) : null}
                              <span>{scorer.team?.shortName ?? scorer.team?.name ?? 'Unknown team'}</span>
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
                    setSignupVerificationCode('');
                    setSignupCodeSent(false);
                    setSignupCodeEmail('');
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
                    setSignupVerificationCode('');
                    setSignupCodeSent(false);
                    setSignupCodeEmail('');
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
                  <p className="muted auth-hint">After you click Sign up, we will email a 6-digit verification code.</p>
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

              {authMode === 'signup' && signupCodeSent ? (
                <section className="auth-verification-panel">
                  <h4>Email Verification</h4>
                  <label>
                    Verification Code
                    <input
                      value={signupVerificationCode}
                      onChange={(e) => setSignupVerificationCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                      type="text"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      placeholder="6-digit code"
                    />
                  </label>
                  <div className="auth-actions">
                    <button
                      type="button"
                      className="details-btn"
                      onClick={() => void handleSendSignupCode()}
                      disabled={authLoading || !isAuthEmailValid || signupCodeCooldownLeft > 0}
                    >
                      {signupCodeCooldownLeft > 0 ? `Resend in ${signupCodeCooldownLeft}s` : 'Resend Code'}
                    </button>
                  </div>
                </section>
              ) : null}

              <div className="auth-actions">
                <button
                  type="button"
                  className="refresh"
                  onClick={() => void (authMode === 'login' ? handleLogin() : handleRegister())}
                  disabled={authLoading || !canSubmitAuth}
                >
                  {authLoading ? 'Please wait...' : authMode === 'login' ? 'Login' : signupCodeSent ? 'Verify account' : 'Sign up'}
                </button>
                <button
                  type="button"
                  className="details-btn"
                  onClick={() => {
                    setAuthMode((prev) => (prev === 'login' ? 'signup' : 'login'));
                    setConfirmPassword('');
                    setSignupVerificationCode('');
                    setSignupCodeSent(false);
                    setSignupCodeEmail('');
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
                    Match Source
                    <select value={newGroupMatchMode} onChange={(e) => setNewGroupMatchMode(e.target.value === 'custom' ? 'custom' : 'competition')}>
                      <option value="competition">Competition</option>
                      <option value="custom">Custom Matches</option>
                    </select>
                  </label>
                  {newGroupMatchMode === 'competition' ? (
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
                  ) : (
                    <label>
                      Match Date
                      <input type="date" value={newGroupCustomMatchDate} onChange={(e) => setNewGroupCustomMatchDate(e.target.value)} />
                    </label>
                  )}
                  <button
                    type="button"
                    className="refresh"
                    disabled={busy}
                    onClick={() => void handleCreateGroup()}
                  >
                    Create
                  </button>
                </div>
                {newGroupMatchMode === 'custom' ? (
                  <div className="invite-list">
                    <p className="muted">
                      Select one or more matches from any competition ({newGroupCustomMatchIds.length} selected).
                    </p>
                    <div className="selectors">
                      <label>
                        Competition Filter
                        <select
                          value={newGroupCustomCompetitionFilter}
                          onChange={(e) => setNewGroupCustomCompetitionFilter(e.target.value)}
                        >
                          <option value="">All Competitions</option>
                          {newGroupCustomCompetitionOptions.map((name) => (
                            <option key={name} value={name}>
                              {name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        Country Filter
                        <select value={newGroupCustomCountryFilter} onChange={(e) => setNewGroupCustomCountryFilter(e.target.value)}>
                          <option value="">All Countries</option>
                          {newGroupCustomCountryOptions.map((name) => (
                            <option key={name} value={name}>
                              {name}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                    {newGroupCustomPoolLoading ? <p className="muted">Loading matches...</p> : null}
                    {!newGroupCustomPoolLoading && filteredNewGroupCustomPool.length === 0 ? (
                      <p className="muted">No matches found for this date/filter.</p>
                    ) : null}
                    {filteredNewGroupCustomPool.map((match) => (
                      <label key={match.id} className="group-custom-match-row">
                        <input
                          type="checkbox"
                          checked={newGroupCustomMatchIds.includes(match.id)}
                          onChange={() => toggleNewGroupCustomMatch(match.id)}
                        />
                        <span className="group-custom-match-card">
                          <span className="group-custom-match-meta">
                            <strong>{formatMatchDateTime(match.utcDate)}</strong>
                            <em>{match.competition?.name ?? 'Competition'} · {match.competition?.area?.name ?? match.area?.name ?? 'Country'}</em>
                          </span>
                          <span className="group-custom-match-teams">
                            <span className="team-name-wrap">
                              {match.homeTeam.crest ? <img className="team-crest" src={match.homeTeam.crest} alt="" loading="lazy" /> : null}
                              <span className="team-name">{match.homeTeam.name}</span>
                            </span>
                            <span className="group-custom-match-vs">vs</span>
                            <span className="team-name-wrap">
                              {match.awayTeam.crest ? <img className="team-crest" src={match.awayTeam.crest} alt="" loading="lazy" /> : null}
                              <span className="team-name">{match.awayTeam.name}</span>
                            </span>
                          </span>
                        </span>
                      </label>
                    ))}
                  </div>
                ) : null}
              </section>

              <section className="filter-panel">
                <h2>Your Groups</h2>
                <div className="group-list">
                  {groups.length === 0 ? <p className="muted">No groups yet. Create one above or accept an invite.</p> : null}
                  {groups.map((group) => (
                    <div
                      key={group.id}
                      className={`group-chip-row ${group.id === selectedGroupId ? 'group-chip-row-active' : ''}`}
                    >
                      <button
                        type="button"
                        className="group-chip group-chip-main"
                        onClick={() => setSelectedGroupId(group.id)}
                      >
                        {group.name} - {group.match_selection_mode === 'custom' ? 'Custom Matches' : group.competition_name}
                      </button>
                      {user && group.owner_uid === user.uid ? (
                        <button
                          type="button"
                          className="group-chip-delete"
                          aria-label={`Delete ${group.name}`}
                          title="Delete group"
                          disabled={groupDeleting}
                          onClick={() => void handleDeleteGroupById(group)}
                        >
                          X
                        </button>
                      ) : null}
                    </div>
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
                    <strong>{selectedGroup.bonus_enabled ? 'On' : 'Off'}</strong> | Mode:{' '}
                    <strong>{selectedGroup.match_selection_mode === 'custom' ? 'Custom Matches' : 'Competition'}</strong>
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

                      {selectedGroup.match_selection_mode === 'custom' ? (
                        <div className="custom-selection-panel">
                          <div className="custom-selection-head">
                            <strong>Custom Match Selection</strong>
                            <span className="muted">Pick matches from any competition for today.</span>
                          </div>
                          <div className="quick-status custom-selection-stats">
                            <span className="group-chip">Available: {filteredSelectedGroupCustomPool.length}</span>
                            <span className="group-chip">Selected: {groupMatches.length}</span>
                            <span className="group-chip">Stored: {selectedGroupCustomMatches.length}</span>
                          </div>
                          <div className="selectors">
                            <label>
                              Competition Filter
                              <select
                                value={selectedGroupCustomCompetitionFilter}
                                onChange={(e) => setSelectedGroupCustomCompetitionFilter(e.target.value)}
                              >
                                <option value="">All Competitions</option>
                                {selectedGroupCustomCompetitionOptions.map((name) => (
                                  <option key={name} value={name}>
                                    {name}
                                  </option>
                                ))}
                              </select>
                            </label>
                            <label>
                              Country Filter
                              <select
                                value={selectedGroupCustomCountryFilter}
                                onChange={(e) => setSelectedGroupCustomCountryFilter(e.target.value)}
                              >
                                <option value="">All Countries</option>
                                {selectedGroupCustomCountryOptions.map((name) => (
                                  <option key={name} value={name}>
                                    {name}
                                  </option>
                                ))}
                              </select>
                            </label>
                          </div>
                          <div className="custom-selection-list">
                            {selectedGroupCustomPoolLoading ? <p className="muted">Loading available matches...</p> : null}
                            {!selectedGroupCustomPoolLoading && filteredSelectedGroupCustomPool.length === 0 ? (
                              <p className="muted">No available matches found for today/filter.</p>
                            ) : null}
                            {filteredSelectedGroupCustomPool.map((match) => (
                              <label key={`custom-${match.id}`} className="group-custom-match-row">
                                <input
                                  type="checkbox"
                                  checked={groupMatches.some((row) => row.id === match.id)}
                                  onChange={() => toggleSelectedGroupCustomMatch(match)}
                                />
                                <span className="group-custom-match-card">
                                  <span className="group-custom-match-meta">
                                    <strong>{formatMatchDateTime(match.utcDate)}</strong>
                                    <em>{match.competition?.name ?? 'Competition'} · {match.competition?.area?.name ?? match.area?.name ?? 'Country'}</em>
                                  </span>
                                  <span className="group-custom-match-teams">
                                    <span className="team-name-wrap">
                                      {match.homeTeam.crest ? <img className="team-crest" src={match.homeTeam.crest} alt="" loading="lazy" /> : null}
                                      <span className="team-name">{match.homeTeam.name}</span>
                                    </span>
                                    <span className="group-custom-match-vs">vs</span>
                                    <span className="team-name-wrap">
                                      {match.awayTeam.crest ? <img className="team-crest" src={match.awayTeam.crest} alt="" loading="lazy" /> : null}
                                      <span className="team-name">{match.awayTeam.name}</span>
                                    </span>
                                  </span>
                                </span>
                              </label>
                            ))}
                          </div>
                          <div className="custom-selection-actions">
                            <button
                              type="button"
                              className="refresh"
                              disabled={groupSettingsBusy || customSelectionSaving}
                              onClick={() => void handleSaveCustomSelection()}
                            >
                              {customSelectionSaving ? 'Saving Selection...' : 'Save Custom Selection'}
                            </button>
                          </div>
                        </div>
                      ) : null}

                      <div className="auth-actions">
                        <button
                          type="button"
                          className="details-btn"
                          disabled={groupDeleting || groupSettingsBusy}
                          onClick={() => void handleDeleteSelectedGroup()}
                        >
                          {groupDeleting ? 'Deleting Group...' : 'Delete Group'}
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
                  <p>Goal player pick hit (optional): <strong>+1</strong></p>
                  <p>Yellow-card player pick hit (optional): <strong>+1</strong></p>
                  <p>Red-card player pick hit (optional): <strong>+1</strong></p>
                  <p>Perfect prediction (winner + HT + FT all correct): <strong>+2 bonus</strong></p>
                  <p className="muted">Max normal score per match: 8 pts (group bonus multipliers can increase it).</p>
                </div>
              </section>
            </div>

            <div className="game-main">
              {!selectedGroup ? (
                <article className="league-card empty">Select a group to start predicting matches.</article>
              ) : null}

              {selectedGroup ? (
                <section className="filter-panel game-summary">
                  <h2>
                    Prediction Board - {selectedGroup.match_selection_mode === 'custom' ? 'Custom Matches' : selectedGroup.competition_name}
                  </h2>
                  <div className="quick-status">
                    <span className="group-chip">Matches: {groupMatches.length}</span>
                    <span className="group-chip">Completed Drafts: {completedDraftCount}</span>
                    <span className="group-chip">Saved: {Object.keys(myPredictions).length}</span>
                    <span className={`group-chip ${unsavedDraftCount > 0 ? 'group-chip-warn' : ''}`}>Unsaved: {unsavedDraftCount}</span>
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
                    <strong>
                      Today Matches - {selectedGroup.match_selection_mode === 'custom' ? 'Custom Matches' : selectedGroup.competition_name}
                    </strong>
                    <span>{groupMatchesLoading ? 'Loading...' : `${groupMatches.length} match(es)`}</span>
                  </div>

                  {groupMatches.map((match) => {
                    const draft = predictionDrafts[match.id] ?? {
                      htHome: '',
                      htAway: '',
                      ftHome: '',
                      ftAway: '',
                      goalPlayersHome: '',
                      goalPlayersAway: '',
                      yellowCardPlayersHome: '',
                      yellowCardPlayersAway: '',
                      redCardPlayersHome: '',
                      redCardPlayersAway: ''
                    };
                    const matchPredictions = groupPredictionsByMatch[match.id] ?? [];
                    const isOpenForPrediction = isMatchOpenForPrediction(match, selectedGroup.prediction_lock_minutes);
                    const shouldReveal = !isOpenForPrediction;
                    const memberEmailByUid = Object.fromEntries(groupMembers.map((member) => [member.user_uid, member.email]));
                    const realFtHome = match.score?.fullTime?.home ?? '-';
                    const realFtAway = match.score?.fullTime?.away ?? '-';
                    const matchLabel = `${match.homeTeam.name} vs ${match.awayTeam.name}`;
                    const showEventResultState = match.status === 'FINISHED';
                    const goalPlayersHomeActual = incidentPlayersForTeam(match.incidents?.goals, match.homeTeam);
                    const goalPlayersAwayActual = incidentPlayersForTeam(match.incidents?.goals, match.awayTeam);
                    const yellowPlayersHomeActual = incidentPlayersForTeam(match.incidents?.yellowCards, match.homeTeam);
                    const yellowPlayersAwayActual = incidentPlayersForTeam(match.incidents?.yellowCards, match.awayTeam);
                    const redPlayersHomeActual = incidentPlayersForTeam(match.incidents?.redCards, match.homeTeam);
                    const redPlayersAwayActual = incidentPlayersForTeam(match.incidents?.redCards, match.awayTeam);
                    const homePlayers =
                      match.homeTeam.id !== undefined ? teamDetailsById[match.homeTeam.id]?.squad?.map((p) => p.name ?? '').filter(Boolean) ?? [] : [];
                    const awayPlayers =
                      match.awayTeam.id !== undefined ? teamDetailsById[match.awayTeam.id]?.squad?.map((p) => p.name ?? '').filter(Boolean) ?? [] : [];

                    return (
                      <article className="league-card prediction-card" key={match.id}>
                        <div className="prediction-head prediction-head-modern">
                          <div className="match-time">
                            <span className={`status-dot ${getStatusClass(match.status)}`} />
                            <span>{match.status === 'TIMED' ? kickoffTime(match.utcDate) : match.status}</span>
                          </div>
                          <span className="prediction-kickoff">{formatMatchDateTime(match.utcDate)}</span>
                        </div>

                        <div className="prediction-scoreboard">
                          <section className="prediction-team-side">
                            <span className="team-name-wrap">
                              {match.homeTeam.crest ? <img className="team-crest" src={match.homeTeam.crest} alt="" loading="lazy" /> : null}
                              <span className="team-name">{match.homeTeam.name}</span>
                            </span>
                          </section>

                          <section className="prediction-score-core">
                            <label className="prediction-score-row">
                              <span className="prediction-score-tag">FT</span>
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

                            <label className="prediction-score-row">
                              <span className="prediction-score-tag">HT</span>
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
                            <p className="prediction-real-result">{realFtHome}-{realFtAway}</p>
                          </section>

                          <section className="prediction-team-side prediction-team-side-away">
                            <span className="team-name-wrap">
                              {match.awayTeam.crest ? <img className="team-crest" src={match.awayTeam.crest} alt="" loading="lazy" /> : null}
                              <span className="team-name">{match.awayTeam.name}</span>
                            </span>
                          </section>
                        </div>

                        <div className="prediction-events-board">
                          <div className="prediction-events-head">
                            <span />
                            <span className="prediction-events-team-logo" title={match.homeTeam.name}>
                              {match.homeTeam.crest ? (
                                <img className="team-crest prediction-events-crest" src={match.homeTeam.crest} alt={match.homeTeam.name} loading="lazy" />
                              ) : null}
                            </span>
                            <span className="prediction-events-team-logo" title={match.awayTeam.name}>
                              {match.awayTeam.crest ? (
                                <img className="team-crest prediction-events-crest" src={match.awayTeam.crest} alt={match.awayTeam.name} loading="lazy" />
                              ) : null}
                            </span>
                          </div>

                          <div className="prediction-event-row">
                            <span className="prediction-event-marker" title="Goal">
                              ⚽
                            </span>
                            <div className="prediction-event-cell">
                              <PlayerPicksInput
                                compact
                                label="⚽"
                              title={`${match.homeTeam.name} goal players`}
                              value={draft.goalPlayersHome}
                              options={homePlayers}
                              actualPlayers={goalPlayersHomeActual}
                              showResultState={showEventResultState}
                              disabled={!isOpenForPrediction}
                              onChange={(next) =>
                                setPredictionDrafts((prev) => ({
                                    ...prev,
                                    [match.id]: { ...draft, goalPlayersHome: next }
                                  }))
                                }
                              />
                            </div>
                            <div className="prediction-event-cell">
                              <PlayerPicksInput
                                compact
                                label="⚽"
                              title={`${match.awayTeam.name} goal players`}
                              value={draft.goalPlayersAway}
                              options={awayPlayers}
                              actualPlayers={goalPlayersAwayActual}
                              showResultState={showEventResultState}
                              disabled={!isOpenForPrediction}
                              onChange={(next) =>
                                setPredictionDrafts((prev) => ({
                                    ...prev,
                                    [match.id]: { ...draft, goalPlayersAway: next }
                                  }))
                                }
                              />
                            </div>
                          </div>

                          <div className="prediction-event-row">
                            <span className="prediction-event-marker" title="Yellow Card">
                              <img className="prediction-event-icon" src="/yellow-card.png" alt="Yellow card" loading="lazy" />
                            </span>
                            <div className="prediction-event-cell">
                              <PlayerPicksInput
                                compact
                                label="🟨"
                              title={`${match.homeTeam.name} yellow card players`}
                              value={draft.yellowCardPlayersHome}
                              options={homePlayers}
                              actualPlayers={yellowPlayersHomeActual}
                              showResultState={showEventResultState}
                              disabled={!isOpenForPrediction}
                              onChange={(next) =>
                                setPredictionDrafts((prev) => ({
                                    ...prev,
                                    [match.id]: { ...draft, yellowCardPlayersHome: next }
                                  }))
                                }
                              />
                            </div>
                            <div className="prediction-event-cell">
                              <PlayerPicksInput
                                compact
                                label="🟨"
                              title={`${match.awayTeam.name} yellow card players`}
                              value={draft.yellowCardPlayersAway}
                              options={awayPlayers}
                              actualPlayers={yellowPlayersAwayActual}
                              showResultState={showEventResultState}
                              disabled={!isOpenForPrediction}
                              onChange={(next) =>
                                setPredictionDrafts((prev) => ({
                                    ...prev,
                                    [match.id]: { ...draft, yellowCardPlayersAway: next }
                                  }))
                                }
                              />
                            </div>
                          </div>

                          <div className="prediction-event-row">
                            <span className="prediction-event-marker" title="Red Card">
                              <img className="prediction-event-icon" src="/red-card.png" alt="Red card" loading="lazy" />
                            </span>
                            <div className="prediction-event-cell">
                              <PlayerPicksInput
                                compact
                                label="🟥"
                              title={`${match.homeTeam.name} red card players`}
                              value={draft.redCardPlayersHome}
                              options={homePlayers}
                              actualPlayers={redPlayersHomeActual}
                              showResultState={showEventResultState}
                              disabled={!isOpenForPrediction}
                              onChange={(next) =>
                                setPredictionDrafts((prev) => ({
                                    ...prev,
                                    [match.id]: { ...draft, redCardPlayersHome: next }
                                  }))
                                }
                              />
                            </div>
                            <div className="prediction-event-cell">
                              <PlayerPicksInput
                                compact
                                label="🟥"
                              title={`${match.awayTeam.name} red card players`}
                              value={draft.redCardPlayersAway}
                              options={awayPlayers}
                              actualPlayers={redPlayersAwayActual}
                              showResultState={showEventResultState}
                              disabled={!isOpenForPrediction}
                              onChange={(next) =>
                                setPredictionDrafts((prev) => ({
                                    ...prev,
                                    [match.id]: { ...draft, redCardPlayersAway: next }
                                  }))
                                }
                              />
                            </div>
                          </div>
                        </div>
                        {!isOpenForPrediction ? (
                          <p className="saved-line prediction-lock-alert">
                            Predictions locked for this match.
                          </p>
                        ) : null}
                        {shouldReveal ? (
                          <div className="reveal-list">
                            {matchPredictions.map((item) => {
                              const points = calculatePredictionPoints(match, item);
                              const itemGoalSplit = splitTeamPlayerPicks(item.goal_players);
                              const itemYellowSplit = splitTeamPlayerPicks(item.yellow_card_players);
                              const itemRedSplit = splitTeamPlayerPicks(item.red_card_players);
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
                                    {item.goal_players?.length ? (
                                      <p>
                                        <strong>Goal:</strong> {match.homeTeam.tla ?? 'Home'} [{itemGoalSplit.home || '-'}] | {match.awayTeam.tla ?? 'Away'} [{itemGoalSplit.away || '-'}]
                                      </p>
                                    ) : null}
                                    {item.yellow_card_players?.length ? (
                                      <p>
                                        <strong>Yellow:</strong> {match.homeTeam.tla ?? 'Home'} [{itemYellowSplit.home || '-'}] | {match.awayTeam.tla ?? 'Away'} [{itemYellowSplit.away || '-'}]
                                      </p>
                                    ) : null}
                                    {item.red_card_players?.length ? (
                                      <p>
                                        <strong>Red:</strong> {match.homeTeam.tla ?? 'Home'} [{itemRedSplit.home || '-'}] | {match.awayTeam.tla ?? 'Away'} [{itemRedSplit.away || '-'}]
                                      </p>
                                    ) : null}
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
              <>
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
              </>
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
                              <p className="muted">Short: {homeDetails?.tla ?? activeMatchDetails.homeTeam.tla ?? 'N/A'}</p>
                              <p className="muted">Nickname: {homeDetails?.nickname ?? activeMatchDetails.homeTeam.nickname ?? 'N/A'}</p>
                              <p className="muted">Form: {homeDetails?.form ?? activeMatchDetails.homeTeam.form ?? 'N/A'}</p>
                              <p className="muted">Venue: {homeDetails?.venue ?? activeMatchDetails.homeTeam.venue ?? 'N/A'}</p>
                              {(homeDetails?.color ?? activeMatchDetails.homeTeam.color) ? (
                                <p className="muted">
                                  Primary Color:{' '}
                                  <span
                                    style={{
                                      display: 'inline-block',
                                      width: 14,
                                      height: 14,
                                      borderRadius: 999,
                                      verticalAlign: 'middle',
                                      marginLeft: 6,
                                      border: '1px solid rgba(255,255,255,0.25)',
                                      background: `#${homeDetails?.color ?? activeMatchDetails.homeTeam.color}`
                                    }}
                                  />
                                </p>
                              ) : null}
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
                              <p className="muted">Short: {awayDetails?.tla ?? activeMatchDetails.awayTeam.tla ?? 'N/A'}</p>
                              <p className="muted">Nickname: {awayDetails?.nickname ?? activeMatchDetails.awayTeam.nickname ?? 'N/A'}</p>
                              <p className="muted">Form: {awayDetails?.form ?? activeMatchDetails.awayTeam.form ?? 'N/A'}</p>
                              <p className="muted">Venue: {awayDetails?.venue ?? activeMatchDetails.awayTeam.venue ?? 'N/A'}</p>
                              {(awayDetails?.color ?? activeMatchDetails.awayTeam.color) ? (
                                <p className="muted">
                                  Primary Color:{' '}
                                  <span
                                    style={{
                                      display: 'inline-block',
                                      width: 14,
                                      height: 14,
                                      borderRadius: 999,
                                      verticalAlign: 'middle',
                                      marginLeft: 6,
                                      border: '1px solid rgba(255,255,255,0.25)',
                                      background: `#${awayDetails?.color ?? activeMatchDetails.awayTeam.color}`
                                    }}
                                  />
                                </p>
                              ) : null}
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

                  <div className="events-grid">
                    <article className="league-card">
                      <header className="league-head">
                        <h4>Goals</h4>
                      </header>
                      <div className="filter-panel">
                        {(activeMatchDetails.incidents?.goals ?? []).length === 0 ? (
                          <p className="muted">No goals data.</p>
                        ) : (
                          (activeMatchDetails.incidents?.goals ?? []).map((item, index) => (
                            <p key={`goal-${index}`}>
                              <strong>{item.minute || '--'}</strong> {item.player || item.text || 'Goal'}{' '}
                              <span className="muted">({item.team || 'Unknown'})</span>
                            </p>
                          ))
                        )}
                      </div>
                    </article>

                    <article className="league-card">
                      <header className="league-head">
                        <h4>Yellow Cards</h4>
                      </header>
                      <div className="filter-panel">
                        {(activeMatchDetails.incidents?.yellowCards ?? []).length === 0 ? (
                          <p className="muted">No yellow cards data.</p>
                        ) : (
                          (activeMatchDetails.incidents?.yellowCards ?? []).map((item, index) => (
                            <p key={`yellow-${index}`}>
                              <strong>{item.minute || '--'}</strong> {item.player || item.text || 'Yellow card'}{' '}
                              <span className="muted">({item.team || 'Unknown'})</span>
                            </p>
                          ))
                        )}
                      </div>
                    </article>

                    <article className="league-card">
                      <header className="league-head">
                        <h4>Red Cards</h4>
                      </header>
                      <div className="filter-panel">
                        {(activeMatchDetails.incidents?.redCards ?? []).length === 0 ? (
                          <p className="muted">No red cards data.</p>
                        ) : (
                          (activeMatchDetails.incidents?.redCards ?? []).map((item, index) => (
                            <p key={`red-${index}`}>
                              <strong>{item.minute || '--'}</strong> {item.player || item.text || 'Red card'}{' '}
                              <span className="muted">({item.team || 'Unknown'})</span>
                            </p>
                          ))
                        )}
                      </div>
                    </article>
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
        {message ? <p className="status-message">{message}</p> : null}
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
  goalEvent: number;
  yellowEvent: number;
  redEvent: number;
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

function calculatePredictionPoints(match: Match, prediction: MatchPrediction): PredictionPoints {
  const result = getMatchResult(match);
  if (!result) {
    return { ready: false, winner: 0, ht: 0, ft: 0, goalEvent: 0, yellowEvent: 0, redEvent: 0, total: 0 };
  }

  const predictedWinner = getWinner(prediction.ft_home, prediction.ft_away);
  const winner = predictedWinner === result.winner ? 1 : 0;
  const ht = prediction.ht_home === result.htHome && prediction.ht_away === result.htAway ? 1 : 0;
  const ft = prediction.ft_home === result.ftHome && prediction.ft_away === result.ftAway ? 1 : 0;
  const normalize = (value: string) =>
    value
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9\s'-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  const parsePredicted = (value: string) => {
    if (value.startsWith(HOME_PICK_PREFIX)) return { name: value.slice(HOME_PICK_PREFIX.length), side: 'home' as const };
    if (value.startsWith(AWAY_PICK_PREFIX)) return { name: value.slice(AWAY_PICK_PREFIX.length), side: 'away' as const };
    return { name: value, side: null as 'home' | 'away' | null };
  };
  const homeTeamNormalized = normalize(match.homeTeam.name ?? '');
  const awayTeamNormalized = normalize(match.awayTeam.name ?? '');
  const hasEventMatch = (predictedPlayers: string[] | undefined, incidents: MatchIncident[] | undefined) => {
    if (!predictedPlayers?.length || !incidents?.length) return 0;
    const actual = incidents
      .map((item) => ({
        player: normalize(String(item.player ?? '')),
        team: normalize(String(item.team ?? ''))
      }))
      .filter((item) => item.player.length > 0);
    return predictedPlayers.some((raw) => {
      const predicted = parsePredicted(String(raw ?? ''));
      const playerName = normalize(predicted.name);
      if (!playerName) return false;
      return actual.some((row) => {
        if (row.player !== playerName) return false;
        if (predicted.side === 'home' && homeTeamNormalized && row.team && row.team !== homeTeamNormalized) return false;
        if (predicted.side === 'away' && awayTeamNormalized && row.team && row.team !== awayTeamNormalized) return false;
        return true;
      });
    })
      ? 1
      : 0;
  };
  const goalEvent = hasEventMatch(prediction.goal_players, match.incidents?.goals);
  const yellowEvent = hasEventMatch(prediction.yellow_card_players, match.incidents?.yellowCards);
  const redEvent = hasEventMatch(prediction.red_card_players, match.incidents?.redCards);
  const perfectBonus = winner === 1 && ht === 1 && ft === 1 ? 2 : 0;
  const eventBonus = goalEvent + yellowEvent + redEvent;

  return { ready: true, winner, ht, ft, goalEvent, yellowEvent, redEvent, total: winner + ht + ft + perfectBonus + eventBonus };
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
