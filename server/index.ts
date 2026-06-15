import express from 'express';
import { createSign } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import nodemailer from 'nodemailer';
import { createClient } from '@supabase/supabase-js';
import { countCorrectPlayerPicks, getBonusPickLimitForPoints } from './reward-system.js';

const app = express();
const port = Number(process.env.PORT ?? 8787);

app.use(express.json());
app.use((req, _res, next) => {
  // Vercel rewrites /internal/* to /api/internal/* so the API function can receive it.
  // Normalize back to /internal/* for the existing route handlers.
  if (req.url.startsWith('/api/internal/')) {
    req.url = req.url.slice('/api'.length);
  }
  next();
});

const smtpHost = process.env.SMTP_HOST ?? 'smtp.mail.ovh.ca';
const smtpPort = Number(process.env.SMTP_PORT ?? 587);
const smtpSecure = process.env.SMTP_SECURE === 'true';
const smtpUser = process.env.SMTP_USER ?? '';
const smtpPass = process.env.SMTP_PASS ?? '';
const smtpFrom = process.env.SMTP_FROM ?? smtpUser;
const firebaseWebApiKey = process.env.FIREBASE_WEB_API_KEY ?? process.env.VITE_FIREBASE_API_KEY ?? '';
const isProd = process.env.NODE_ENV === 'production';
const supabaseUrl = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? '';
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const footballDataApiKey = process.env.FOOTBALL_DATA_API_KEY ?? '';
const footballDataApiBase = 'https://api.football-data.org';
const cronSecret = process.env.CRON_SECRET ?? '';
const appBaseUrl = (process.env.APP_BASE_URL ?? 'https://www.predileague.com').replace(/\/+$/, '');
const firebaseServiceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON ?? '';
const firebaseServiceAccountBase64 = process.env.FIREBASE_SERVICE_ACCOUNT_JSON_BASE64 ?? '';

type FirebaseServiceAccount = {
  project_id?: string;
  client_email?: string;
  private_key?: string;
};

function parseFirebaseServiceAccount(): FirebaseServiceAccount | null {
  const raw = firebaseServiceAccountJson || (
    firebaseServiceAccountBase64
      ? Buffer.from(firebaseServiceAccountBase64, 'base64').toString('utf8')
      : ''
  );
  if (!raw) return null;
  try {
    return JSON.parse(raw) as FirebaseServiceAccount;
  } catch {
    return null;
  }
}

const firebaseServiceAccount = parseFirebaseServiceAccount();
let firebaseAccessTokenCache: { token: string; expiresAt: number } | null = null;

const mailer =
  smtpUser && smtpPass
    ? nodemailer.createTransport({
        host: smtpHost,
        port: smtpPort,
        secure: smtpSecure,
        auth: {
          user: smtpUser,
          pass: smtpPass
        }
      })
    : null;

const supabaseAdmin =
  supabaseUrl && supabaseServiceRoleKey
    ? createClient(supabaseUrl, supabaseServiceRoleKey, {
        auth: {
          autoRefreshToken: false,
          persistSession: false
        }
      })
    : null;

let smtpLastVerifyAt: string | null = null;
let smtpLastVerifyError: string | null = null;
const inviteRateLimitStore = new Map<string, number[]>();
const INVITE_RATE_WINDOW_MS = 60_000;
const INVITE_RATE_LIMIT = 8;
const signupVerificationStore = new Map<
  string,
  { code: string; expiresAt: number; sentAt: number; attempts: number }
>();
const SIGNUP_CODE_TTL_MS = 10 * 60_000;
const SIGNUP_CODE_COOLDOWN_MS = 45_000;
const SIGNUP_CODE_MAX_ATTEMPTS = 5;
const espnGetCache = new Map<string, { bodyText: string; expiresAt: number }>();
const espnGetInflight = new Map<string, Promise<string>>();
const espnEventById = new Map<number, Record<string, unknown>>();
const espnTeamById = new Map<number, Record<string, unknown>>();
const espnLeagueByEventId = new Map<number, string>();
const espnLeagueByTeamId = new Map<number, string>();

type AuthContext = {
  uid: string;
  email: string;
};

type MatchApi = {
  id?: number;
  status?: string;
  utcDate?: string;
  matchday?: number;
  homeTeam?: { name?: string; shortName?: string; tla?: string };
  awayTeam?: { name?: string; shortName?: string; tla?: string };
  competition?: { id?: number };
  incidents?: {
    goals?: Array<{ minute?: string; team?: string; player?: string; text?: string }>;
    yellowCards?: Array<{ minute?: string; team?: string; player?: string; text?: string }>;
    redCards?: Array<{ minute?: string; team?: string; player?: string; text?: string }>;
  };
  score?: {
    winner?: 'HOME_TEAM' | 'AWAY_TEAM' | 'DRAW' | null;
    halfTime?: { home?: number | null; away?: number | null };
    fullTime?: { home?: number | null; away?: number | null };
  };
};

type AuthedRequest = express.Request & {
  auth?: AuthContext;
};

async function verifySmtpConnection() {
  smtpLastVerifyAt = new Date().toISOString();
  smtpLastVerifyError = null;

  if (!mailer) {
    smtpLastVerifyError = 'SMTP transporter is not configured (missing SMTP_USER/SMTP_PASS).';
    return;
  }

  try {
    await mailer.verify();
  } catch (error) {
    smtpLastVerifyError = error instanceof Error ? error.message : 'Unknown SMTP verify error.';
  }
}

void verifySmtpConnection();

async function verifyFirebaseIdToken(idToken: string): Promise<AuthContext | null> {
  if (!firebaseWebApiKey) {
    return null;
  }

  try {
    const response = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(firebaseWebApiKey)}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ idToken })
      }
    );

    if (!response.ok) {
      return null;
    }

    const payload = (await response.json()) as {
      users?: Array<{ localId?: string; email?: string }>;
    };
    const user = payload.users?.[0];
    if (!user?.localId || !user?.email) {
      return null;
    }

    return {
      uid: user.localId,
      email: user.email
    };
  } catch {
    return null;
  }
}

async function requireFirebaseAuth(req: AuthedRequest, res: express.Response, next: express.NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing Bearer token.' });
    return;
  }

  const token = authHeader.slice('Bearer '.length).trim();
  if (!token) {
    res.status(401).json({ error: 'Missing Bearer token.' });
    return;
  }

  const auth = await verifyFirebaseIdToken(token);
  if (!auth) {
    res.status(401).json({ error: 'Invalid Firebase token.' });
    return;
  }

  req.auth = auth;
  next();
}

function toBase64Url(value: string | Buffer) {
  return Buffer.from(value).toString('base64url');
}

async function getFirebaseAccessToken() {
  if (firebaseAccessTokenCache && firebaseAccessTokenCache.expiresAt > Date.now() + 60_000) {
    return firebaseAccessTokenCache.token;
  }

  const clientEmail = firebaseServiceAccount?.client_email;
  const privateKey = firebaseServiceAccount?.private_key?.replace(/\\n/g, '\n');
  if (!clientEmail || !privateKey) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is missing or invalid.');
  }

  const now = Math.floor(Date.now() / 1000);
  const header = toBase64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = toBase64Url(
    JSON.stringify({
      iss: clientEmail,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600
    })
  );
  const unsignedToken = `${header}.${claims}`;
  const signer = createSign('RSA-SHA256');
  signer.update(unsignedToken);
  signer.end();
  const assertion = `${unsignedToken}.${signer.sign(privateKey).toString('base64url')}`;

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion
    })
  });
  const payload = (await response.json().catch(() => ({}))) as {
    access_token?: string;
    expires_in?: number;
    error_description?: string;
  };
  if (!response.ok || !payload.access_token) {
    throw new Error(payload.error_description ?? `Firebase OAuth failed (${response.status}).`);
  }

  firebaseAccessTokenCache = {
    token: payload.access_token,
    expiresAt: Date.now() + Math.max(300, Number(payload.expires_in ?? 3600)) * 1000
  };
  return payload.access_token;
}

async function sendFirebasePush(params: {
  token: string;
  title: string;
  body: string;
  link: string;
}) {
  const projectId = firebaseServiceAccount?.project_id;
  if (!projectId) {
    throw new Error('Firebase service account project_id is missing.');
  }
  const accessToken = await getFirebaseAccessToken();
  const response = await fetch(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/messages:send`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      message: {
        token: params.token,
        data: {
          title: params.title,
          body: params.body,
          link: params.link
        },
        webpush: {
          headers: { Urgency: 'high' },
          fcm_options: { link: params.link }
        }
      }
    })
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as {
      error?: { message?: string; status?: string };
    };
    const error = new Error(payload.error?.message ?? `Firebase send failed (${response.status}).`) as Error & {
      status?: string;
    };
    error.status = payload.error?.status;
    throw error;
  }
}

function hitInviteRateLimit(ip: string) {
  const now = Date.now();
  const list = inviteRateLimitStore.get(ip) ?? [];
  const next = list.filter((timestamp) => now - timestamp <= INVITE_RATE_WINDOW_MS);
  next.push(now);
  inviteRateLimitStore.set(ip, next);
  return next.length > INVITE_RATE_LIMIT;
}

function isValidEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function normalizeEmail(value: string) {
  return value.trim().toLowerCase();
}

function generateSixDigitCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function parseYmd(value: string) {
  const dt = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(dt.getTime())) return null;
  return dt;
}

function toYmd(value: Date) {
  const y = value.getUTCFullYear();
  const m = String(value.getUTCMonth() + 1).padStart(2, '0');
  const d = String(value.getUTCDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

function getAdjacentDateRange(value: string) {
  const parsed = parseYmd(value);
  if (!parsed) return null;
  const from = new Date(parsed);
  from.setUTCDate(from.getUTCDate() - 1);
  const to = new Date(parsed);
  to.setUTCDate(to.getUTCDate() + 1);
  return {
    from: from.toISOString().slice(0, 10),
    to: to.toISOString().slice(0, 10)
  };
}

function enumerateDates(from: string, to: string) {
  const start = parseYmd(from);
  const end = parseYmd(to);
  if (!start || !end || end < start) return [];
  const dates: string[] = [];
  const current = new Date(start.getTime());
  while (current <= end && dates.length < 7) {
    dates.push(toYmd(current));
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return dates;
}

function mapEspnStatus(statusTypeInput: Record<string, unknown>) {
  const name = String(statusTypeInput.name ?? '').toUpperCase();
  const state = String(statusTypeInput.state ?? '').toLowerCase();
  const detail = `${String(statusTypeInput.detail ?? '')} ${String(statusTypeInput.shortDetail ?? '')}`.toLowerCase();

  if (state === 'post' || Boolean(statusTypeInput.completed) || name.includes('FINAL') || name.includes('FULL_TIME')) {
    return 'FINISHED';
  }

  if (state === 'in') {
    const isHalftimeLike =
      name === 'STATUS_HALFTIME' ||
      name.includes('HALF_TIME') ||
      name.includes('BREAK') ||
      detail.includes('half-time') ||
      detail.includes('halftime');
    if (isHalftimeLike) {
      return 'PAUSED';
    }
    return 'LIVE';
  }

  if (name.includes('PAUSED')) return 'PAUSED';
  return 'TIMED';
}

function mapEspnWinner(homeScore: number | null, awayScore: number | null): 'HOME_TEAM' | 'AWAY_TEAM' | 'DRAW' | null {
  if (homeScore === null || awayScore === null) return null;
  if (homeScore > awayScore) return 'HOME_TEAM';
  if (awayScore > homeScore) return 'AWAY_TEAM';
  return 'DRAW';
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const cleaned = value.replace(/[^0-9.+-]/g, '');
    const n = Number(cleaned);
    if (Number.isFinite(n)) return n;
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const nested = asNumber(obj.value ?? obj.displayValue ?? obj.rawValue);
    if (nested !== null) return nested;
  }
  return null;
}

async function fetchEspnJson(path: string, ttlMs = 12000) {
  const url = `https://site.api.espn.com${path}`;
  const now = Date.now();
  const cached = espnGetCache.get(url);
  if (cached && cached.expiresAt > now) {
    return JSON.parse(cached.bodyText) as Record<string, unknown>;
  }

  const inflight = espnGetInflight.get(url);
  if (inflight) {
    const text = await inflight;
    return JSON.parse(text) as Record<string, unknown>;
  }

  const promise = (async () => {
    const response = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'PredictLeague/1.0' } });
    if (!response.ok) {
      throw new Error(`ESPN request failed (${response.status}).`);
    }
    const text = await response.text();
    espnGetCache.set(url, { bodyText: text, expiresAt: Date.now() + ttlMs });
    return text;
  })();

  espnGetInflight.set(url, promise);
  try {
    const text = await promise;
    return JSON.parse(text) as Record<string, unknown>;
  } finally {
    espnGetInflight.delete(url);
  }
}

async function fetchEspnCoreJson(urlOrPath: string, ttlMs = 90000) {
  const rawUrl = urlOrPath.startsWith('http')
    ? urlOrPath
    : `https://sports.core.api.espn.com${urlOrPath.startsWith('/') ? '' : '/'}${urlOrPath}`;
  const url = new URL(rawUrl);
  if (!url.searchParams.has('lang')) url.searchParams.set('lang', 'en');
  if (!url.searchParams.has('region')) url.searchParams.set('region', 'us');
  const key = url.toString();
  const now = Date.now();
  const cached = espnGetCache.get(key);
  if (cached && cached.expiresAt > now) {
    return JSON.parse(cached.bodyText) as Record<string, unknown>;
  }

  const inflight = espnGetInflight.get(key);
  if (inflight) {
    const text = await inflight;
    return JSON.parse(text) as Record<string, unknown>;
  }

  const promise = (async () => {
    const response = await fetch(key, { headers: { Accept: 'application/json', 'User-Agent': 'PredictLeague/1.0' } });
    if (!response.ok) {
      throw new Error(`ESPN core request failed (${response.status}).`);
    }
    const text = await response.text();
    espnGetCache.set(key, { bodyText: text, expiresAt: Date.now() + ttlMs });
    return text;
  })();
  espnGetInflight.set(key, promise);
  try {
    const text = await promise;
    return JSON.parse(text) as Record<string, unknown>;
  } finally {
    espnGetInflight.delete(key);
  }
}

function getRefFromNode(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const ref = (value as Record<string, unknown>).$ref;
  return typeof ref === 'string' && ref.length > 0 ? ref : null;
}

async function resolveCoreObject(value: unknown): Promise<Record<string, unknown> | null> {
  if (!value) return null;
  if (typeof value !== 'object') return null;
  const ref = getRefFromNode(value);
  if (ref) return fetchEspnCoreJson(ref, 90000);
  return value as Record<string, unknown>;
}

async function resolveCoreCollection(value: unknown): Promise<Array<Record<string, unknown>>> {
  if (Array.isArray(value)) {
    return value.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object');
  }
  if (!value || typeof value !== 'object') return [];
  const ref = getRefFromNode(value);
  if (ref) {
    const payload = await fetchEspnCoreJson(ref, 90000);
    return resolveCoreCollection(payload.items ?? payload.entries ?? payload.leaders ?? []);
  }
  const obj = value as Record<string, unknown>;
  if (Array.isArray(obj.items)) return resolveCoreCollection(obj.items);
  if (Array.isArray(obj.entries)) return resolveCoreCollection(obj.entries);
  if (Array.isArray(obj.leaders)) return resolveCoreCollection(obj.leaders);
  return [];
}

const ESPN_COMPETITIONS: Record<string, { id: number; name: string; areaName: string }> = {
  'fifa.world': { id: 32017, name: 'FIFA World Cup', areaName: 'World' },
  'uefa.euro': { id: 32018, name: 'UEFA European Championship', areaName: 'Europe' },
  'caf.nations': { id: 32019, name: 'Africa Cup of Nations', areaName: 'Africa' },
  'uefa.champions': { id: 2001, name: 'UEFA Champions League', areaName: 'Europe' },
  'uefa.europa': { id: 32001, name: 'UEFA Europa League', areaName: 'Europe' },
  'uefa.europa.conf': { id: 32002, name: 'UEFA Conference League', areaName: 'Europe' },
  'eng.1': { id: 2021, name: 'Premier League', areaName: 'England' },
  'eng.2': { id: 32003, name: 'Championship', areaName: 'England' },
  'esp.1': { id: 2014, name: 'Primera Division', areaName: 'Spain' },
  'esp.2': { id: 32004, name: 'Segunda Division', areaName: 'Spain' },
  'ger.1': { id: 2002, name: 'Bundesliga', areaName: 'Germany' },
  'ger.2': { id: 32005, name: '2. Bundesliga', areaName: 'Germany' },
  'ita.1': { id: 2019, name: 'Serie A', areaName: 'Italy' },
  'ita.2': { id: 32006, name: 'Serie B', areaName: 'Italy' },
  'fra.1': { id: 2015, name: 'Ligue 1', areaName: 'France' },
  'fra.2': { id: 32007, name: 'Ligue 2', areaName: 'France' },
  'por.1': { id: 32008, name: 'Primeira Liga', areaName: 'Portugal' },
  'ned.1': { id: 32009, name: 'Eredivisie', areaName: 'Netherlands' },
  'bel.1': { id: 32010, name: 'Belgian Pro League', areaName: 'Belgium' },
  'sco.1': { id: 32011, name: 'Scottish Premiership', areaName: 'Scotland' },
  'tur.1': { id: 32012, name: 'Super Lig', areaName: 'Turkey' },
  'usa.1': { id: 32013, name: 'MLS', areaName: 'United States' },
  'mex.1': { id: 32014, name: 'Liga MX', areaName: 'Mexico' },
  'arg.1': { id: 32015, name: 'Liga Profesional', areaName: 'Argentina' },
  'bra.1': { id: 32016, name: 'Brasileirao Serie A', areaName: 'Brazil' }
};
const ESPN_LEAGUES = Object.keys(ESPN_COMPETITIONS);
const FOOTBALL_COMPETITION_TO_ESPN: Record<number, string> = Object.fromEntries(
  Object.entries(ESPN_COMPETITIONS).map(([league, meta]) => [meta.id, league])
);
const FOOTBALL_DATA_COMPETITION_CODE_BY_ESPN_LEAGUE: Record<string, string> = {
  'uefa.champions': 'CL',
  'uefa.europa': 'EL',
  'uefa.europa.conf': 'ECL',
  'eng.1': 'PL',
  'eng.2': 'ELC',
  'esp.1': 'PD',
  'ger.1': 'BL1',
  'ger.2': 'BL2',
  'ita.1': 'SA',
  'fra.1': 'FL1',
  'ned.1': 'DED',
  'por.1': 'PPL'
};

function getEspnLeagueByFootballCompetitionId(value: number) {
  return FOOTBALL_COMPETITION_TO_ESPN[value];
}

function getEspnCompetitionByLeague(league: string) {
  return ESPN_COMPETITIONS[league];
}

function pickEspnLogoUrl(primary: Record<string, unknown> | null | undefined, secondary?: Record<string, unknown> | null) {
  const primaryLogos = Array.isArray(primary?.logos) ? (primary?.logos as Array<Record<string, unknown>>) : [];
  const secondaryLogos = Array.isArray(secondary?.logos) ? (secondary?.logos as Array<Record<string, unknown>>) : [];
  const candidate =
    String(primaryLogos[0]?.href ?? '') ||
    String(primary?.logo ?? '') ||
    String(secondaryLogos[0]?.href ?? '') ||
    String(secondary?.logo ?? '');
  if (candidate) return candidate;

  const teamId = asNumber(primary?.id ?? secondary?.id);
  if (teamId && teamId > 0) {
    return `https://a.espncdn.com/i/teamlogos/soccer/500/${teamId}.png`;
  }
  return '';
}

function getSeasonCandidates() {
  const now = new Date();
  const current = now.getUTCMonth() >= 6 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
  return [current, current - 1, current + 1];
}

type CoreTeamAthlete = {
  id?: number;
  name?: string;
  position?: string;
  nationality?: string;
  dateOfBirth?: string;
};

async function fetchCoreTeamWithAthletes(league: string, teamId: number) {
  const candidates = [
    `/v2/sports/soccer/leagues/${league}/teams/${teamId}`,
    ...getSeasonCandidates().map((season) => `/v2/sports/soccer/leagues/${league}/seasons/${season}/teams/${teamId}`)
  ];
  for (const path of candidates) {
    try {
      const payload = await fetchEspnCoreJson(path, 90000);
      const athletes = await resolveCoreCollection(
        (payload as Record<string, unknown>).athletes ?? (payload as Record<string, unknown>).roster ?? []
      );
      if (athletes.length > 0) {
        return payload;
      }
    } catch {
      // Try next candidate.
    }
  }
  return null;
}

async function fetchCoreTeamSquad(league: string, teamId: number): Promise<CoreTeamAthlete[]> {
  const teamPayload = await fetchCoreTeamWithAthletes(league, teamId);
  if (!teamPayload) return [];
  const athletes = await resolveCoreCollection(
    (teamPayload as Record<string, unknown>).athletes ?? (teamPayload as Record<string, unknown>).roster ?? []
  );
  const squad = athletes
    .map((item) => {
      const position = (item.position as Record<string, unknown> | undefined) ?? {};
      const birthDate = String(item.dateOfBirth ?? '');
      return {
        id: asNumber(item.id) ?? undefined,
        name: String(item.displayName ?? item.fullName ?? item.shortName ?? item.name ?? '').trim(),
        position: String(position.abbreviation ?? position.name ?? ''),
        nationality: String(item.nationality ?? (item.citizenship as string | undefined) ?? ''),
        dateOfBirth: birthDate ? birthDate : undefined
      };
    })
    .filter((item) => item.name);
  const seen = new Set<string>();
  return squad.filter((item) => {
    const key = item.name?.toLowerCase() ?? '';
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function mapSiteRosterAthletes(payload: Record<string, unknown>): CoreTeamAthlete[] {
  const buckets: unknown[] = [];
  const tryPush = (value: unknown) => {
    if (Array.isArray(value)) buckets.push(...value);
  };
  const walk = (value: unknown, depth = 0) => {
    if (!value || typeof value !== 'object' || depth > 6) return;
    const obj = value as Record<string, unknown>;
    tryPush(obj.athletes);
    tryPush(obj.players);
    for (const child of Object.values(obj)) {
      if (Array.isArray(child)) {
        for (const item of child) walk(item, depth + 1);
      } else if (child && typeof child === 'object') {
        walk(child, depth + 1);
      }
    }
  };
  walk(payload);
  const mapped = buckets
    .map((item) => item as Record<string, unknown>)
    .map((item) => {
      const position = (item.position as Record<string, unknown> | undefined) ?? {};
      return {
        id: asNumber(item.id) ?? undefined,
        name: String(item.displayName ?? item.fullName ?? item.shortName ?? item.name ?? '').trim(),
        position: String(position.abbreviation ?? position.name ?? ''),
        nationality: String(item.nationality ?? ''),
        dateOfBirth: String(item.dateOfBirth ?? '') || undefined
      };
    })
    .filter((item) => item.name);
  const seen = new Set<string>();
  return mapped.filter((item) => {
    const key = item.name?.toLowerCase() ?? '';
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function fetchSiteTeamSquad(league: string, teamId: number): Promise<CoreTeamAthlete[]> {
  const candidates = [
    `/apis/site/v2/sports/soccer/${league}/teams/${teamId}/roster`,
    `/apis/site/v2/sports/soccer/${league}/teams/${teamId}`
  ];
  for (const path of candidates) {
    try {
      const payload = await fetchEspnJson(path, 60000);
      const squad = mapSiteRosterAthletes(payload);
      if (squad.length > 0) return squad;
    } catch {
      // Continue.
    }
  }
  return [];
}

async function extractEspnIncidents(summaryPayload: Record<string, unknown>) {
  const detailCandidates: unknown[] = [];
  const pushArray = (value: unknown) => {
    if (Array.isArray(value)) {
      detailCandidates.push(...value);
    }
  };
  const walk = (value: unknown, depth = 0) => {
    if (!value || typeof value !== 'object' || depth > 6) return;
    const obj = value as Record<string, unknown>;
    pushArray(obj.details);
    pushArray(obj.scoringPlays);
    pushArray(obj.plays);
    pushArray(obj.cards);
    pushArray(obj.keyEvents);
    for (const child of Object.values(obj)) {
      if (child && typeof child === 'object') {
        walk(child, depth + 1);
      }
    }
  };

  walk(summaryPayload);

  const detailsResolved = await Promise.all(
    detailCandidates.map(async (item) => {
      const detail = await resolveCoreObject(item);
      if (!detail) return null;
      const typeResolved = await resolveCoreObject(detail.type);
      if (typeResolved) detail.type = typeResolved;
      const teamResolved = await resolveCoreObject(detail.team);
      if (teamResolved) detail.team = teamResolved;
      const athleteResolved = await resolveCoreObject(detail.athlete);
      if (athleteResolved) detail.athlete = athleteResolved;
      const playerResolved = await resolveCoreObject(detail.player);
      if (playerResolved) detail.player = playerResolved;
      if (Array.isArray(detail.athletesInvolved)) {
        const athletesResolved = await Promise.all(
          (detail.athletesInvolved as Array<unknown>).map(async (athlete) => (await resolveCoreObject(athlete)) ?? null)
        );
        detail.athletesInvolved = athletesResolved.filter((athlete): athlete is Record<string, unknown> => athlete !== null);
      }
      return detail;
    })
  );
  const details = detailsResolved.filter((item): item is Record<string, unknown> => item !== null);
  const headerCompetition = ((summaryPayload.header as Record<string, unknown> | undefined)?.competitions as
    | Array<Record<string, unknown>>
    | undefined)?.[0];
  const competitors = Array.isArray(headerCompetition?.competitors)
    ? (headerCompetition?.competitors as Array<unknown>)
    : [];
  const teamNameById = new Map<string, string>();
  for (const rawCompetitor of competitors) {
    const competitor = (await resolveCoreObject(rawCompetitor)) ?? {};
    const team = ((await resolveCoreObject(competitor.team)) ?? {}) as Record<string, unknown>;
    const id = String(team.id ?? competitor.id ?? competitor.teamId ?? '');
    if (!id) continue;
    teamNameById.set(id, String(team.displayName ?? team.shortDisplayName ?? team.name ?? ''));
  }

  const getMinute = (detail: Record<string, unknown>) => {
    const clock = (detail.clock as Record<string, unknown> | undefined) ?? {};
    const displayValue = clock.displayValue;
    if (typeof displayValue === 'string' && displayValue.trim()) {
      return displayValue.trim();
    }
    const clockMinute = asNumber(clock.value);
    if (clockMinute !== null) {
      const normalized = clockMinute > 200 ? Math.round(clockMinute / 60) : Math.round(clockMinute);
      return `${normalized}'`;
    }
    const directMinute = asNumber(detail.time);
    if (directMinute !== null) return `${directMinute}'`;
    const text = String(detail.text ?? detail.shortText ?? detail.description ?? detail.headline ?? '').trim();
    const minuteMatch = text.match(/(\d{1,3}(?:\+\d{1,2})?)'/);
    const inferred = minuteMatch ? `${minuteMatch[1]}'` : '';
    return inferred === '[object Object]' ? '' : inferred;
  };
  const getTeam = (detail: Record<string, unknown>) => {
    const detailTeam = (detail.team as Record<string, unknown> | undefined) ?? {};
    const detailTeamId = String(detailTeam.id ?? detail.teamId ?? detail.competitorId ?? '');
    return teamNameById.get(detailTeamId) ?? String(detailTeam.displayName ?? detailTeam.name ?? '');
  };
  const getPlayer = (detail: Record<string, unknown>) => {
    const athlete = (detail.athlete as Record<string, unknown> | undefined) ?? {};
    if (athlete.displayName || athlete.fullName || athlete.name) {
      return String(athlete.displayName ?? athlete.fullName ?? athlete.name ?? '');
    }
    const athletes = Array.isArray(detail.athletesInvolved) ? (detail.athletesInvolved as Array<Record<string, unknown>>) : [];
    const first = athletes[0] ?? ((detail.player as Record<string, unknown> | undefined) ?? {});
    const fromFields = String(first.displayName ?? first.fullName ?? first.name ?? '').trim();
    if (fromFields) return fromFields;
    const text = String(detail.text ?? detail.shortText ?? detail.description ?? '').trim();
    // Common ESPN formats:
    // "Rubén García (Osasuna) is shown the yellow card ..."
    // "Goal! Osasuna 2, Mallorca 2. Ante Budimir (Osasuna) left footed shot ..."
    const afterGoalPrefix = text.match(/Goal!\s*[^.]*\.\s*([^()]+)\s*\(/i);
    if (afterGoalPrefix?.[1]) return afterGoalPrefix[1].trim();
    const leadingName = text.match(/^([^()]+)\s*\(/);
    if (leadingName?.[1]) return leadingName[1].trim();
    return '';
  };
  const describe = (detail: Record<string, unknown>) => {
    const type = (detail.type as Record<string, unknown> | undefined) ?? {};
    return [
      detail.text,
      detail.shortText,
      detail.description,
      detail.headline,
      detail.displayValue,
      type.text,
      type.name,
      type.description,
      type.displayName,
      type.shortName,
      type.abbreviation
    ]
      .map((value) => String(value ?? '').trim())
      .filter((value) => value.length > 0)
      .join(' ');
  };
  const displayText = (detail: Record<string, unknown>) =>
    String(detail.text ?? detail.shortText ?? detail.description ?? detail.headline ?? '').trim();
  const build = (detail: Record<string, unknown>) => ({
    minute: getMinute(detail),
    team: getTeam(detail),
    player: getPlayer(detail),
    text: displayText(detail)
  });

  const unique = (rows: Array<{ minute: string; team: string; player: string; text: string }>) => {
    const seen = new Set<string>();
    return rows.filter((row) => {
      const key = `${row.minute}|${row.team}|${row.player}|${row.text}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };

  const classifyText = (detail: Record<string, unknown>) => describe(detail).toLowerCase();
  const classifyType = (detail: Record<string, unknown>) =>
    String(
      ((detail.type as Record<string, unknown> | undefined)?.text ??
        (detail.type as Record<string, unknown> | undefined)?.name ??
        (detail.type as Record<string, unknown> | undefined)?.abbreviation ??
        detail.type) ??
        ''
    ).toLowerCase();

  const goals = details
    .filter((detail) => {
      const type = classifyType(detail);
      const text = classifyText(detail);
      return (
        (Boolean((detail as { scoringPlay?: unknown }).scoringPlay) &&
          !/\battempt saved\b|\bsaved\b|\boff target\b|\bwide\b/.test(text)) ||
        /^goal!/i.test(text) ||
        /\bpenalty scored\b|\bown goal\b/.test(text) ||
        type.includes('goal') ||
        type.includes('score') ||
        type === 'g' ||
        type === 'pg' ||
        type === 'og'
      );
    })
    .map(build)
    .filter((row) => row.text.length > 0);

  const yellowCards = details
    .filter((detail) => {
      const type = classifyType(detail);
      const text = classifyText(detail);
      return (
        /\bshown the yellow card\b|\byellow card\b|\bbooked\b|\bcaution\b/.test(text) ||
        type.includes('yellow') ||
        type === 'yc'
      );
    })
    .map(build)
    .filter((row) => row.text.length > 0);

  const redCards = details
    .filter((detail) => {
      const type = classifyType(detail);
      const text = classifyText(detail);
      return /\bshown the red card\b|\bred card\b|\bsent off\b|\bdismissed\b/.test(text) || type.includes('red') || type === 'rc';
    })
    .map(build)
    .filter((row) => row.text.length > 0);

  const normalizeRows = (rows: Array<{ minute: string; team: string; player: string; text: string }>) => {
    const deduped = unique(rows)
      .filter((row) => row.text.length > 0)
      .map((row) => ({
        ...row,
        minute: row.minute === '[object Object]' ? '' : row.minute
      }));

    const byText = new Map<string, { minute: string; team: string; player: string; text: string }>();
    for (const row of deduped) {
      const key = row.text.toLowerCase().replace(/\s+/g, ' ').trim();
      const existing = byText.get(key);
      if (!existing) {
        byText.set(key, row);
        continue;
      }
      const existingScore = (existing.team ? 2 : 0) + (existing.minute ? 1 : 0);
      const rowScore = (row.team ? 2 : 0) + (row.minute ? 1 : 0);
      if (rowScore > existingScore) {
        byText.set(key, row);
      }
    }
    return Array.from(byText.values());
  };

  return {
    goals: normalizeRows(goals),
    yellowCards: normalizeRows(yellowCards),
    redCards: normalizeRows(redCards)
  };
}

function normalizeEspnEvent(event: Record<string, unknown>, leagueFallback?: Record<string, unknown>, leagueKey?: string) {
  const competition = Array.isArray(event.competitions) ? (event.competitions[0] as Record<string, unknown> | undefined) : undefined;
  const competitors = Array.isArray(competition?.competitors) ? (competition?.competitors as Array<Record<string, unknown>>) : [];
  const home = competitors.find((c) => String(c.homeAway ?? '').toLowerCase() === 'home') ?? competitors[0];
  const away = competitors.find((c) => String(c.homeAway ?? '').toLowerCase() === 'away') ?? competitors[1];
  const homeTeam = (home?.team ?? {}) as Record<string, unknown>;
  const awayTeam = (away?.team ?? {}) as Record<string, unknown>;
  const statusType = (((event.status as Record<string, unknown> | undefined)?.type ?? {}) as Record<string, unknown>);
  const status = mapEspnStatus(statusType);
  const homeScore = asNumber(home?.score);
  const awayScore = asNumber(away?.score);
  const homeLines = Array.isArray(home?.linescores) ? (home?.linescores as Array<Record<string, unknown>>) : [];
  const awayLines = Array.isArray(away?.linescores) ? (away?.linescores as Array<Record<string, unknown>>) : [];
  const htHome = asNumber(homeLines[0]?.value);
  const htAway = asNumber(awayLines[0]?.value);
  const eventLeague = Array.isArray((event.leagues as unknown[]))
    ? ((event.leagues as Array<Record<string, unknown>>)[0] ?? {})
    : {};
  const league = Object.keys(eventLeague).length > 0 ? eventLeague : leagueFallback ?? {};
  const mappedCompetition = leagueKey ? getEspnCompetitionByLeague(leagueKey) : undefined;
  const areaName = String((league.country as Record<string, unknown> | undefined)?.name ?? '');

  const normalized = {
    id: asNumber(event.id) ?? 0,
    utcDate: String(event.date ?? ''),
    status,
    homeTeam: {
      id: asNumber(homeTeam.id) ?? undefined,
      name: String(homeTeam.displayName ?? homeTeam.shortDisplayName ?? 'Home'),
      shortName: String(homeTeam.shortDisplayName ?? homeTeam.abbreviation ?? ''),
      tla: String(homeTeam.abbreviation ?? ''),
      crest: pickEspnLogoUrl(homeTeam, home as Record<string, unknown>),
      venue: String((competition?.venue as Record<string, unknown> | undefined)?.fullName ?? ''),
      nickname: String(homeTeam.nickname ?? ''),
      color: String(homeTeam.color ?? ''),
      alternateColor: String(homeTeam.alternateColor ?? ''),
      form: String((home as Record<string, unknown> | undefined)?.form ?? '')
    },
    awayTeam: {
      id: asNumber(awayTeam.id) ?? undefined,
      name: String(awayTeam.displayName ?? awayTeam.shortDisplayName ?? 'Away'),
      shortName: String(awayTeam.shortDisplayName ?? awayTeam.abbreviation ?? ''),
      tla: String(awayTeam.abbreviation ?? ''),
      crest: pickEspnLogoUrl(awayTeam, away as Record<string, unknown>),
      venue: String((competition?.venue as Record<string, unknown> | undefined)?.fullName ?? ''),
      nickname: String(awayTeam.nickname ?? ''),
      color: String(awayTeam.color ?? ''),
      alternateColor: String(awayTeam.alternateColor ?? ''),
      form: String((away as Record<string, unknown> | undefined)?.form ?? '')
    },
    score: {
      winner: mapEspnWinner(homeScore, awayScore),
      halfTime: { home: htHome, away: htAway },
      fullTime: { home: homeScore, away: awayScore }
    },
    competition: {
      id: mappedCompetition?.id ?? asNumber(league.id) ?? 0,
      name: mappedCompetition?.name ?? String(league.name ?? 'Competition'),
      area: { name: mappedCompetition?.areaName ?? (areaName || 'Unknown') }
    },
    area: { name: mappedCompetition?.areaName ?? (areaName || 'Unknown') },
    venue: String((competition?.venue as Record<string, unknown> | undefined)?.fullName ?? ''),
    matchday: asNumber((competition?.week as Record<string, unknown> | undefined)?.number) ?? undefined
  };

  const eventId = normalized.id;
  if (eventId > 0) {
    espnEventById.set(eventId, event);
    if (leagueKey) {
      espnLeagueByEventId.set(eventId, leagueKey);
    }
  }
  const homeTeamId = normalized.homeTeam.id ?? 0;
  const awayTeamId = normalized.awayTeam.id ?? 0;
  if (homeTeamId > 0) espnTeamById.set(homeTeamId, homeTeam);
  if (awayTeamId > 0) espnTeamById.set(awayTeamId, awayTeam);
  if (leagueKey) {
    if (homeTeamId > 0) espnLeagueByTeamId.set(homeTeamId, leagueKey);
    if (awayTeamId > 0) espnLeagueByTeamId.set(awayTeamId, leagueKey);
  }

  return normalized;
}

async function enrichMatchScoreFromSummary(
  match: MatchApi,
  leagueKey: string,
  matchId: number
): Promise<MatchApi> {
  try {
    const summary = await fetchEspnJson(`/apis/site/v2/sports/soccer/${leagueKey}/summary?event=${matchId}`, 12000);
    const summaryCompetition = Array.isArray((summary.header as Record<string, unknown> | undefined)?.competitions)
      ? (((summary.header as Record<string, unknown>).competitions as Array<Record<string, unknown>>)[0] ?? null)
      : null;
    const summaryCompetitors = Array.isArray(summaryCompetition?.competitors)
      ? (summaryCompetition?.competitors as Array<Record<string, unknown>>)
      : [];
    const summaryHome = summaryCompetitors.find(
      (item) => String((item.homeAway as string | undefined) ?? '').toLowerCase() === 'home'
    );
    const summaryAway = summaryCompetitors.find(
      (item) => String((item.homeAway as string | undefined) ?? '').toLowerCase() === 'away'
    );
    const summaryHomeLines = Array.isArray(summaryHome?.linescores)
      ? (summaryHome?.linescores as Array<Record<string, unknown>>)
      : [];
    const summaryAwayLines = Array.isArray(summaryAway?.linescores)
      ? (summaryAway?.linescores as Array<Record<string, unknown>>)
      : [];

    const currentHalfTime = match.score?.halfTime ?? {};
    const currentFullTime = match.score?.fullTime ?? {};
    const htHome = asNumber(summaryHomeLines[0]?.value ?? summaryHomeLines[0]?.displayValue) ?? currentHalfTime.home ?? null;
    const htAway = asNumber(summaryAwayLines[0]?.value ?? summaryAwayLines[0]?.displayValue) ?? currentHalfTime.away ?? null;
    const ftHome = asNumber(summaryHome?.score) ?? currentFullTime.home ?? null;
    const ftAway = asNumber(summaryAway?.score) ?? currentFullTime.away ?? null;
    const winner = match.score?.winner ?? mapEspnWinner(ftHome, ftAway);
    const incidents = await extractEspnIncidents(summary);

    return {
      ...match,
      incidents,
      score: {
        ...(match.score ?? {}),
        winner,
        halfTime: { home: htHome, away: htAway },
        fullTime: { home: ftHome, away: ftAway }
      }
    };
  } catch {
    return match;
  }
}

async function enrichMatchesWithSummaryIfNeeded(
  matches: Array<Record<string, unknown>>,
  leagueKey: string
) {
  const enriched = await Promise.all(
    matches.map(async (row) => {
      const match = row as unknown as MatchApi;
      const matchId = Number((row as Record<string, unknown>).id ?? 0);
      const status = String((row as Record<string, unknown>).status ?? '');
      const htHome = match.score?.halfTime?.home;
      const htAway = match.score?.halfTime?.away;
      const needsHalfTime = htHome === null || htHome === undefined || htAway === null || htAway === undefined;
      if (!matchId || status !== 'FINISHED') {
        return row;
      }
      if (!needsHalfTime && match.incidents) {
        return row;
      }
      const next = await enrichMatchScoreFromSummary(match, leagueKey, matchId);
      return next as unknown as Record<string, unknown>;
    })
  );
  return enriched;
}

async function fetchEspnMatchesInRange(from: string, to: string) {
  const ymdDates = enumerateDates(from, to);
  const tasks: Array<Promise<Record<string, unknown>>> = [];
  for (const leagueKey of ESPN_LEAGUES) {
    for (const ymd of ymdDates) {
      tasks.push(fetchEspnJson(`/apis/site/v2/sports/soccer/${leagueKey}/scoreboard?dates=${ymd}`, 10000));
    }
  }
  const payloadsSettled = await Promise.allSettled(tasks);
  const events: Array<{ event: Record<string, unknown>; league: Record<string, unknown> }> = [];
  for (let i = 0; i < payloadsSettled.length; i += 1) {
    const result = payloadsSettled[i];
    if (result.status !== 'fulfilled') continue;
    const payload = result.value;
    const rows = Array.isArray(payload.events) ? (payload.events as Array<Record<string, unknown>>) : [];
    const league = Array.isArray(payload.leagues) ? ((payload.leagues as Array<Record<string, unknown>>)[0] ?? {}) : {};
    const leagueKey = ESPN_LEAGUES[Math.floor(i / Math.max(1, ymdDates.length))] ?? '';
    for (const event of rows) {
      events.push({ event: { ...event, __leagueKey: leagueKey }, league });
    }
  }
  const seen = new Set<number>();
  const matches: Array<Record<string, unknown>> = [];
  for (const item of events) {
    const normalized = normalizeEspnEvent(item.event, item.league, String(item.event.__leagueKey ?? ''));
    if (!normalized.id || seen.has(normalized.id)) continue;
    seen.add(normalized.id);
    matches.push(normalized);
  }
  return matches;
}

async function fetchEspnLeagueMatchesInRange(league: string, from: string, to: string) {
  const ymdDates = enumerateDates(from, to);
  const tasks: Array<Promise<Record<string, unknown>>> = [];
  for (const ymd of ymdDates) {
    tasks.push(fetchEspnJson(`/apis/site/v2/sports/soccer/${league}/scoreboard?dates=${ymd}`, 10000));
  }
  const payloadsSettled = await Promise.allSettled(tasks);
  const events: Array<{ event: Record<string, unknown>; league: Record<string, unknown> }> = [];
  for (const result of payloadsSettled) {
    if (result.status !== 'fulfilled') continue;
    const payload = result.value;
    const rows = Array.isArray(payload.events) ? (payload.events as Array<Record<string, unknown>>) : [];
    const payloadLeague = Array.isArray(payload.leagues) ? ((payload.leagues as Array<Record<string, unknown>>)[0] ?? {}) : {};
    for (const event of rows) {
      events.push({ event: { ...event, __leagueKey: league }, league: payloadLeague });
    }
  }
  const seen = new Set<number>();
  const matches: Array<Record<string, unknown>> = [];
  for (const item of events) {
    const normalized = normalizeEspnEvent(item.event, item.league, String(item.event.__leagueKey ?? league));
    if (!normalized.id || seen.has(normalized.id)) continue;
    seen.add(normalized.id);
    matches.push(normalized);
  }
  return matches;
}

async function fetchFootballDataJson(pathname: string, query: URLSearchParams) {
  if (!footballDataApiKey) return null;
  const url = new URL(pathname, footballDataApiBase);
  for (const [key, value] of query.entries()) {
    url.searchParams.set(key, value);
  }
  const response = await fetch(url, {
    headers: {
      'X-Auth-Token': footballDataApiKey,
      Accept: 'application/json'
    }
  });
  if (!response.ok) {
    return null;
  }
  return (await response.json()) as Record<string, unknown>;
}

async function fetchFootballDataScorersWithFallback(competitionRef: string, season: string | null, limit: number) {
  const attempts: URLSearchParams[] = [];

  const primary = new URLSearchParams();
  if (season) primary.set('season', season);
  if (Number.isFinite(limit)) primary.set('limit', String(limit));
  attempts.push(primary);

  if (season) {
    const noSeason = new URLSearchParams();
    if (Number.isFinite(limit)) noSeason.set('limit', String(limit));
    attempts.push(noSeason);

    const seasonNum = Number(season);
    if (Number.isFinite(seasonNum) && seasonNum > 1900) {
      const previousSeason = new URLSearchParams();
      previousSeason.set('season', String(seasonNum - 1));
      if (Number.isFinite(limit)) previousSeason.set('limit', String(limit));
      attempts.push(previousSeason);
    }
  }

  let lastPayload: Record<string, unknown> | null = null;
  for (const query of attempts) {
    const payload = await fetchFootballDataJson(`/v4/competitions/${competitionRef}/scorers`, query);
    if (!payload) continue;
    lastPayload = payload;
    const scorers = Array.isArray((payload as { scorers?: unknown }).scorers)
      ? ((payload as { scorers?: unknown[] }).scorers ?? [])
      : [];
    if (scorers.length > 0) return payload;
  }

  return lastPayload;
}

function getFootballDataCompetitionRef(appCompetitionId: number): string {
  const espnLeague = getEspnLeagueByFootballCompetitionId(appCompetitionId);
  if (espnLeague && FOOTBALL_DATA_COMPETITION_CODE_BY_ESPN_LEAGUE[espnLeague]) {
    return FOOTBALL_DATA_COMPETITION_CODE_BY_ESPN_LEAGUE[espnLeague];
  }
  return String(appCompetitionId);
}

function isFootballDataCompetitionSupported(appCompetitionId: number) {
  const espnLeague = getEspnLeagueByFootballCompetitionId(appCompetitionId);
  return Boolean(espnLeague && FOOTBALL_DATA_COMPETITION_CODE_BY_ESPN_LEAGUE[espnLeague]);
}

function requireSupabaseAdmin(res: express.Response) {
  if (!supabaseAdmin) {
    res.status(500).json({
      error: 'Supabase server configuration is missing. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.'
    });
    return null;
  }
  return supabaseAdmin;
}

async function loadGroupMembership(groupId: string, userUid: string) {
  if (!supabaseAdmin) {
    return null;
  }

  const { data, error } = await supabaseAdmin
    .from('group_members')
    .select('group_id,user_uid,role,email')
    .eq('group_id', groupId)
    .eq('user_uid', userUid)
    .maybeSingle<{ group_id: string; user_uid: string; role: string; email: string }>();

  if (error) {
    throw new Error(error.message);
  }

  return data;
}

async function requireGroupMember(req: AuthedRequest, res: express.Response, groupId: string) {
  const membership = await loadGroupMembership(groupId, req.auth?.uid ?? '');
  if (!membership) {
    res.status(403).json({ error: 'You are not a member of this group.' });
    return null;
  }
  return membership;
}

function getWinner(home: number, away: number): 'HOME_TEAM' | 'AWAY_TEAM' | 'DRAW' {
  if (home > away) return 'HOME_TEAM';
  if (away > home) return 'AWAY_TEAM';
  return 'DRAW';
}

function normalizeNameForCompare(value: string) {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s'-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function sanitizePredictedPlayers(input: unknown, maxCountPerTeam = 5) {
  if (!Array.isArray(input)) return [];
  const normalizedMax = Number.isFinite(maxCountPerTeam) ? Math.max(1, Math.floor(maxCountPerTeam)) : 5;
  const outHome: string[] = [];
  const outAway: string[] = [];
  const seenHome = new Set<string>();
  const seenAway = new Set<string>();

  const parseRaw = (value: string) => {
    if (value.startsWith('HOME::')) return { side: 'home' as const, name: value.slice('HOME::'.length) };
    if (value.startsWith('AWAY::')) return { side: 'away' as const, name: value.slice('AWAY::'.length) };
    return { side: 'home' as const, name: value };
  };

  const out: string[] = [];
  for (const raw of input) {
    if (typeof raw !== 'string') continue;
    const parsed = parseRaw(raw.trim());
    const value = parsed.name.trim().slice(0, 80);
    if (!value) continue;
    const normalized = normalizeNameForCompare(value);
    if (!normalized) continue;

    if (parsed.side === 'away') {
      if (seenAway.has(normalized) || outAway.length >= normalizedMax) continue;
      seenAway.add(normalized);
      outAway.push(`AWAY::${value}`);
      continue;
    }

    if (seenHome.has(normalized) || outHome.length >= normalizedMax) continue;
    seenHome.add(normalized);
    outHome.push(`HOME::${value}`);
  }
  out.push(...outHome, ...outAway);
  return out;
}

async function loadUserGroupTotalPoints(groupId: string, userUid: string) {
  if (!supabaseAdmin) return 0;
  const { data, error } = await supabaseAdmin
    .from('prediction_points_snapshots')
    .select('total_points')
    .eq('group_id', groupId)
    .eq('user_uid', userUid);
  if (error) {
    throw new Error(error.message);
  }
  return (data ?? []).reduce((sum, row) => sum + Number(row.total_points ?? 0), 0);
}

function getWeekStart(dateInput: string | Date) {
  const date = typeof dateInput === 'string' ? new Date(dateInput) : new Date(dateInput.getTime());
  const day = date.getUTCDay();
  const shift = day === 0 ? -6 : 1 - day;
  date.setUTCDate(date.getUTCDate() + shift);
  date.setUTCHours(0, 0, 0, 0);
  return date;
}

async function fetchMatchForCompetition(params: {
  competitionId: number;
  matchId: number;
  matchDate?: string;
}): Promise<MatchApi | null> {
  const { competitionId, matchId, matchDate } = params;
  const espnLeague = getEspnLeagueByFootballCompetitionId(competitionId);
  if (!espnLeague) return null;
  const cachedEvent = espnEventById.get(matchId);
  if (cachedEvent) {
    const normalized = normalizeEspnEvent(cachedEvent, undefined, espnLeague) as unknown as MatchApi;
    const needsSummaryData =
      normalized.status === 'FINISHED' &&
      ((normalized.score?.halfTime?.home === null ||
        normalized.score?.halfTime?.home === undefined ||
        normalized.score?.halfTime?.away === null ||
        normalized.score?.halfTime?.away === undefined) ||
        !normalized.incidents);
    if (needsSummaryData) {
      return enrichMatchScoreFromSummary(normalized, espnLeague, matchId);
    }
    return normalized;
  }

  if (matchDate) {
    const range = getAdjacentDateRange(matchDate);
    if (!range) return null;
    const matches = await fetchEspnLeagueMatchesInRange(espnLeague, range.from, range.to);
    const found = matches.find((item) => Number((item as Record<string, unknown>).id ?? 0) === matchId);
    if (found) {
      const normalized = found as unknown as MatchApi;
      const needsSummaryData =
        normalized.status === 'FINISHED' &&
        ((normalized.score?.halfTime?.home === null ||
          normalized.score?.halfTime?.home === undefined ||
          normalized.score?.halfTime?.away === null ||
          normalized.score?.halfTime?.away === undefined) ||
          !normalized.incidents);
      if (needsSummaryData) {
        return enrichMatchScoreFromSummary(normalized, espnLeague, matchId);
      }
      return normalized;
    }
  }

  return null;
}

async function fetchCompetitionMatchesForDate(params: {
  competitionId: number;
  matchDate: string;
}): Promise<
  Array<{
    id?: number;
    competition?: { id?: number };
    status?: string;
    utcDate?: string;
  }>
> {
  const { competitionId, matchDate } = params;
  const espnLeague = getEspnLeagueByFootballCompetitionId(competitionId);
  if (!espnLeague) {
    return [];
  }
  const range = getAdjacentDateRange(matchDate);
  if (!range) return [];
  const matches = await fetchEspnLeagueMatchesInRange(espnLeague, range.from, range.to);
  return matches.map((row) => ({
    id: Number((row as Record<string, unknown>).id ?? 0),
    competition: {
      id: Number(((row as Record<string, unknown>).competition as Record<string, unknown> | undefined)?.id ?? 0)
    },
    status: String((row as Record<string, unknown>).status ?? ''),
    utcDate: String((row as Record<string, unknown>).utcDate ?? '')
  }));
}

async function fetchMatchForAnyCompetition(params: { matchId: number; matchDate?: string }): Promise<MatchApi | null> {
  const { matchId, matchDate } = params;
  const cachedEvent = espnEventById.get(matchId);
  if (cachedEvent) {
    const leagueKey = espnLeagueByEventId.get(matchId) ?? '';
    const normalized = normalizeEspnEvent(cachedEvent, undefined, leagueKey) as unknown as MatchApi;
    const needsSummaryData =
      normalized.status === 'FINISHED' &&
      ((normalized.score?.halfTime?.home === null ||
        normalized.score?.halfTime?.home === undefined ||
        normalized.score?.halfTime?.away === null ||
        normalized.score?.halfTime?.away === undefined) ||
        !normalized.incidents);
    if (needsSummaryData && leagueKey) {
      return enrichMatchScoreFromSummary(normalized, leagueKey, matchId);
    }
    return normalized;
  }

  if (matchDate) {
    const range = getAdjacentDateRange(matchDate);
    if (!range) return null;
    const matches = await fetchEspnMatchesInRange(range.from, range.to);
    const found = matches.find((item) => Number((item as Record<string, unknown>).id ?? 0) === matchId);
    if (found) {
      const normalized = found as unknown as MatchApi;
      const compId = Number(normalized.competition?.id ?? Number.NaN);
      const leagueKey = Number.isFinite(compId) ? getEspnLeagueByFootballCompetitionId(compId) ?? '' : '';
      const needsSummaryData =
        normalized.status === 'FINISHED' &&
        ((normalized.score?.halfTime?.home === null ||
          normalized.score?.halfTime?.home === undefined ||
          normalized.score?.halfTime?.away === null ||
          normalized.score?.halfTime?.away === undefined) ||
          !normalized.incidents);
      if (needsSummaryData && leagueKey) {
        return enrichMatchScoreFromSummary(normalized, leagueKey, matchId);
      }
      return normalized;
    }
  }

  return null;
}

function calculatePointsForPrediction(params: {
  prediction: {
    ft_home: number;
    ft_away: number;
    ht_home: number;
    ht_away: number;
    goal_players?: string[] | null;
    yellow_card_players?: string[] | null;
    red_card_players?: string[] | null;
  };
  match: MatchApi;
  bonusMultiplier: number;
}) {
  const htHome = params.match.score?.halfTime?.home;
  const htAway = params.match.score?.halfTime?.away;
  const ftHome = params.match.score?.fullTime?.home;
  const ftAway = params.match.score?.fullTime?.away;
  if (
    params.match.status !== 'FINISHED' ||
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

  const winner = params.match.score?.winner ?? getWinner(ftHome, ftAway);
  const predictedWinner = getWinner(params.prediction.ft_home, params.prediction.ft_away);
  const winnerPoints = predictedWinner === winner ? 1 : 0;
  const htPoints = params.prediction.ht_home === htHome && params.prediction.ht_away === htAway ? 1 : 0;
  const ftPoints = params.prediction.ft_home === ftHome && params.prediction.ft_away === ftAway ? 1 : 0;
  const baseTotal = winnerPoints + htPoints + ftPoints;
  const perfectBonusPoints = baseTotal === 3 ? 2 : 0;
  const goalEventBonus = countCorrectPlayerPicks(
    params.prediction.goal_players ?? [],
    params.match.incidents?.goals ?? [],
    params.match
  );
  const yellowEventBonus = countCorrectPlayerPicks(
    params.prediction.yellow_card_players ?? [],
    params.match.incidents?.yellowCards ?? [],
    params.match
  );
  const redEventBonus = countCorrectPlayerPicks(
    params.prediction.red_card_players ?? [],
    params.match.incidents?.redCards ?? [],
    params.match
  );
  const eventBonusPoints = goalEventBonus + yellowEventBonus + redEventBonus;
  const matchBonusPoints = Math.max(0, Math.round(baseTotal * (params.bonusMultiplier - 1)));
  const bonusPoints = perfectBonusPoints + eventBonusPoints + matchBonusPoints;
  const totalPoints = baseTotal + bonusPoints;

  return {
    winnerPoints,
    htPoints,
    ftPoints,
    bonusPoints,
    totalPoints,
    resultHtHome: htHome,
    resultHtAway: htAway,
    resultFtHome: ftHome,
    resultFtAway: ftAway,
    resultWinner: winner
  };
}

app.get('/internal/smtp-health', requireFirebaseAuth, async (req: AuthedRequest, res) => {
  if (isProd) {
    res.status(403).json({ error: 'SMTP health endpoint is disabled in production.' });
    return;
  }

  if (!smtpLastVerifyAt) {
    await verifySmtpConnection();
  }

  res.status(200).json({
    user: req.auth?.email ?? '',
    configured: Boolean(mailer && smtpFrom),
    smtpHost: smtpHost ? '[configured]' : '[missing]',
    smtpPort,
    smtpSecure,
    smtpUser: smtpUser ? `${smtpUser.slice(0, 2)}***` : '[missing]',
    smtpFrom: smtpFrom ? `${smtpFrom.slice(0, 2)}***` : '[missing]',
    lastVerifyAt: smtpLastVerifyAt,
    lastVerifyError: smtpLastVerifyError
  });
});

app.post('/internal/auth/email-verification/send', async (req, res) => {
  const { email } = req.body as { email?: string };
  const normalizedEmail = normalizeEmail(String(email ?? ''));

  if (!isValidEmail(normalizedEmail)) {
    res.status(400).json({ error: 'Valid email is required.' });
    return;
  }

  if (!mailer || !smtpFrom) {
    res.status(500).json({ error: 'SMTP is not configured on the server.' });
    return;
  }

  const now = Date.now();
  const existing = signupVerificationStore.get(normalizedEmail);
  if (existing && now - existing.sentAt < SIGNUP_CODE_COOLDOWN_MS) {
    const waitSeconds = Math.ceil((SIGNUP_CODE_COOLDOWN_MS - (now - existing.sentAt)) / 1000);
    res.status(429).json({ error: `Please wait ${waitSeconds}s before requesting a new code.` });
    return;
  }

  const code = generateSixDigitCode();
  signupVerificationStore.set(normalizedEmail, {
    code,
    expiresAt: now + SIGNUP_CODE_TTL_MS,
    sentAt: now,
    attempts: 0
  });

  try {
    await mailer.sendMail({
      from: smtpFrom,
      to: normalizedEmail,
      subject: 'Your PrediLeague verification code',
      text: [
        'Welcome to PrediLeague!',
        '',
        `Your verification code is: ${code}`,
        'This code expires in 10 minutes.',
        '',
        'Enter this code in the app to complete your account registration.',
        'Website: https://predileague.com'
      ].join('\n'),
      html: `
        <div style="font-family:Arial,sans-serif;line-height:1.55;color:#1b2430">
          <p><strong>Welcome to PrediLeague!</strong></p>
          <p>Your verification code is:</p>
          <p style="font-size:28px;font-weight:700;letter-spacing:3px;margin:8px 0 12px">${code}</p>
          <p>This code expires in <strong>10 minutes</strong>.</p>
          <p>Enter this code in the app to complete your account registration.</p>
          <p>Website: <a href="https://predileague.com">predileague.com</a></p>
        </div>
      `
    });

    res.status(200).json({ ok: true, expiresInSeconds: Math.floor(SIGNUP_CODE_TTL_MS / 1000) });
  } catch (error) {
    signupVerificationStore.delete(normalizedEmail);
    res.status(502).json({ error: error instanceof Error ? error.message : 'Failed to send verification code.' });
  }
});

app.post('/internal/auth/email-verification/verify', async (req, res) => {
  const { email, code } = req.body as { email?: string; code?: string };
  const normalizedEmail = normalizeEmail(String(email ?? ''));
  const normalizedCode = String(code ?? '').trim();

  if (!isValidEmail(normalizedEmail) || !/^\d{6}$/.test(normalizedCode)) {
    res.status(400).json({ error: 'Valid email and 6-digit code are required.' });
    return;
  }

  const entry = signupVerificationStore.get(normalizedEmail);
  if (!entry) {
    res.status(400).json({ error: 'No verification code found. Request a new code.' });
    return;
  }

  if (Date.now() > entry.expiresAt) {
    signupVerificationStore.delete(normalizedEmail);
    res.status(400).json({ error: 'Verification code expired. Request a new one.' });
    return;
  }

  if (entry.attempts >= SIGNUP_CODE_MAX_ATTEMPTS) {
    signupVerificationStore.delete(normalizedEmail);
    res.status(429).json({ error: 'Too many failed attempts. Request a new code.' });
    return;
  }

  if (entry.code !== normalizedCode) {
    entry.attempts += 1;
    signupVerificationStore.set(normalizedEmail, entry);
    res.status(400).json({ error: 'Invalid verification code.' });
    return;
  }

  signupVerificationStore.delete(normalizedEmail);
  res.status(200).json({ ok: true });
});

app.post('/internal/invite-email', requireFirebaseAuth, async (req: AuthedRequest, res) => {
  const { toEmail, groupName, inviterEmail, groupId } = req.body as {
    toEmail?: string;
    groupName?: string;
    inviterEmail?: string;
    groupId?: string;
  };
  const requesterEmail = req.auth?.email ?? '';
  const requesterUid = req.auth?.uid ?? '';
  const ip = req.ip ?? 'unknown';

  if (!toEmail || !groupName) {
    res.status(400).json({ error: 'toEmail and groupName are required.' });
    return;
  }

  if (!requesterUid || !requesterEmail) {
    res.status(401).json({ error: 'Unauthorized request.' });
    return;
  }

  if (!isValidEmail(toEmail)) {
    res.status(400).json({ error: 'Invalid recipient email address.' });
    return;
  }

  if (inviterEmail && inviterEmail.toLowerCase().trim() !== requesterEmail.toLowerCase().trim()) {
    res.status(403).json({ error: 'Inviter email does not match authenticated user.' });
    return;
  }

  if (groupName.trim().length < 2 || groupName.trim().length > 80) {
    res.status(400).json({ error: 'groupName must be 2-80 characters.' });
    return;
  }

  if (groupId) {
    try {
      const membership = await loadGroupMembership(groupId, requesterUid);
      if (!membership) {
        res.status(403).json({ error: 'You are not a member of this group.' });
        return;
      }
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to validate group membership.' });
      return;
    }
  }

  if (hitInviteRateLimit(ip)) {
    res.status(429).json({ error: 'Rate limit exceeded. Try again in one minute.' });
    return;
  }

  if (!mailer || !smtpFrom) {
    res.status(500).json({ error: 'SMTP is not configured on the server.' });
    return;
  }

  try {
    const inviteText = [
      `Hello,`,
      ``,
      `${requesterEmail} invited you to join the PredictLeague group "${groupName}".`,
      ``,
      `What to do next:`,
      `1) Go to https://predileague.com`,
      `2) Sign in (or create an account) with this same email address: ${toEmail.trim()}`,
      `3) Your invite will be accepted automatically after login`,
      ``,
      `You can then submit match predictions, follow leaderboard updates, and compete with your friends.`,
      ``,
      `See you on predileague.com`
    ].join('\n');

    const inviteHtml = `
      <div style="font-family:Arial,sans-serif;line-height:1.55;color:#1b2430">
        <p>Hello,</p>
        <p><strong>${requesterEmail}</strong> invited you to join the PredictLeague group <strong>${groupName}</strong>.</p>
        <p><strong>What to do next:</strong></p>
        <ol>
          <li>Go to <a href="https://predileague.com">predileague.com</a></li>
          <li>Sign in (or create an account) with this same email address: <strong>${toEmail.trim()}</strong></li>
          <li>Your invite will be accepted automatically after login</li>
        </ol>
        <p>You can then submit match predictions, follow leaderboard updates, and compete with your friends.</p>
        <p>See you on <a href="https://predileague.com">predileague.com</a>.</p>
      </div>
    `;

    const result = await mailer.sendMail({
      from: smtpFrom,
      to: toEmail.trim(),
      subject: `You were invited to join "${groupName}" on PredictLeague`,
      text: inviteText,
      html: inviteHtml
    });
    res.status(200).json({
      messageId: result.messageId,
      accepted: result.accepted,
      rejected: result.rejected,
      response: result.response
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to send invite email.';
    res.status(502).json({ error: message });
  }
});

app.get('/internal/db/groups', requireFirebaseAuth, async (req: AuthedRequest, res) => {
  const admin = requireSupabaseAdmin(res);
  if (!admin) return;

  const userUid = req.auth?.uid ?? '';
  try {
    const { data: memberships, error: membershipError } = await admin
      .from('group_members')
      .select('group_id')
      .eq('user_uid', userUid);
    if (membershipError) {
      throw new Error(membershipError.message);
    }

    const groupIds = Array.from(new Set((memberships ?? []).map((row) => row.group_id)));
    if (groupIds.length === 0) {
      res.status(200).json({ groups: [] });
      return;
    }

    const { data: groups, error: groupsError } = await admin
      .from('groups')
      .select('*')
      .in('id', groupIds)
      .order('created_at', { ascending: false });
    if (groupsError) {
      throw new Error(groupsError.message);
    }

    res.status(200).json({ groups: groups ?? [] });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to load groups.' });
  }
});

app.post('/internal/db/groups', requireFirebaseAuth, async (req: AuthedRequest, res) => {
  const admin = requireSupabaseAdmin(res);
  if (!admin) return;

  const { name, competitionId, competitionName, predictionLockMinutes, bonusEnabled, matchSelectionMode, customMatches, customMatchDate } = req.body as {
    name?: string;
    competitionId?: number;
    competitionName?: string;
    predictionLockMinutes?: number;
    bonusEnabled?: boolean;
    matchSelectionMode?: 'competition' | 'custom';
    customMatches?: number[];
    customMatchDate?: string;
  };
  const ownerUid = req.auth?.uid ?? '';
  const ownerEmail = req.auth?.email ?? '';

  const normalizedMode = matchSelectionMode === 'custom' ? 'custom' : 'competition';
  const normalizedCustomMatchDate = typeof customMatchDate === 'string' && customMatchDate.trim() ? customMatchDate : '';
  const normalizedCustomMatches = Array.isArray(customMatches)
    ? Array.from(new Set(customMatches.filter((item) => typeof item === 'number' && Number.isFinite(item) && item > 0)))
    : [];

  if (!name?.trim()) {
    res.status(400).json({ error: 'name is required.' });
    return;
  }
  if (normalizedMode === 'competition' && (!competitionId || !competitionName?.trim())) {
    res.status(400).json({ error: 'competitionId and competitionName are required for competition mode.' });
    return;
  }
  if (normalizedMode === 'custom' && (!normalizedCustomMatchDate || normalizedCustomMatches.length === 0)) {
    res.status(400).json({ error: 'customMatchDate and at least one custom match are required.' });
    return;
  }

  const normalizedLockMinutes =
    typeof predictionLockMinutes === 'number' && predictionLockMinutes >= 0 && predictionLockMinutes <= 180
      ? Math.floor(predictionLockMinutes)
      : 5;
  const normalizedBonusEnabled = Boolean(bonusEnabled);

  try {
    let validatedCustomMatches: number[] = [];
    if (normalizedMode === 'custom') {
      const range = getAdjacentDateRange(normalizedCustomMatchDate);
      if (!range) {
        res.status(400).json({ error: 'Invalid custom match date.' });
        return;
      }
      const allMatchesForDate = await fetchEspnMatchesInRange(range.from, range.to);
      const allowedIds = new Set(allMatchesForDate.map((item) => Number((item as Record<string, unknown>).id ?? 0)).filter(Boolean));
      validatedCustomMatches = normalizedCustomMatches.filter((matchId) => allowedIds.has(matchId));
      if (validatedCustomMatches.length === 0) {
        res.status(400).json({ error: 'None of the selected custom matches were found for the chosen date.' });
        return;
      }
    }

    const { data: group, error: groupError } = await admin
      .from('groups')
      .insert({
        name: name.trim(),
        competition_id: normalizedMode === 'custom' ? 0 : Number(competitionId),
        competition_name: normalizedMode === 'custom' ? 'Custom Matches' : String(competitionName).trim(),
        match_selection_mode: normalizedMode,
        owner_uid: ownerUid,
        prediction_lock_minutes: normalizedLockMinutes,
        bonus_enabled: normalizedBonusEnabled
      })
      .select('*')
      .single();
    if (groupError || !group) {
      throw new Error(groupError?.message ?? 'Failed to create group.');
    }

    const { error: membershipError } = await admin.from('group_members').insert({
      group_id: group.id,
      user_uid: ownerUid,
      email: ownerEmail.toLowerCase().trim(),
      role: 'owner'
    });
    if (membershipError) {
      throw new Error(membershipError.message);
    }

    if (normalizedMode === 'custom') {
      const rows = validatedCustomMatches.map((matchId) => ({
        group_id: group.id,
        match_id: matchId,
        match_date: normalizedCustomMatchDate,
        added_by_uid: ownerUid
      }));
      const { error: customError } = await admin.from('group_custom_matches').upsert(rows, { onConflict: 'group_id,match_id' });
      if (customError) {
        throw new Error(customError.message);
      }
    }

    res.status(200).json({ group });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to create group.' });
  }
});

app.get('/internal/billing/status', requireFirebaseAuth, async (_req: AuthedRequest, res) => {
  res.status(503).json({ error: 'Billing is temporarily disabled.' });
});

app.post('/internal/billing/paypal/order', requireFirebaseAuth, async (_req: AuthedRequest, res) => {
  res.status(503).json({ error: 'Billing is temporarily disabled.' });
});

app.post('/internal/billing/paypal/capture', requireFirebaseAuth, async (_req: AuthedRequest, res) => {
  res.status(503).json({ error: 'Billing is temporarily disabled.' });
});

app.put('/internal/db/groups/:groupId/settings', requireFirebaseAuth, async (req: AuthedRequest, res) => {
  const admin = requireSupabaseAdmin(res);
  if (!admin) return;
  const rawGroupId = req.params.groupId;
  const groupId = Array.isArray(rawGroupId) ? rawGroupId[0] : rawGroupId;
  if (!groupId) {
    res.status(400).json({ error: 'groupId is required.' });
    return;
  }

  const { predictionLockMinutes, bonusEnabled } = req.body as {
    predictionLockMinutes?: number;
    bonusEnabled?: boolean;
  };
  if (typeof predictionLockMinutes !== 'number' || predictionLockMinutes < 0 || predictionLockMinutes > 180) {
    res.status(400).json({ error: 'predictionLockMinutes must be between 0 and 180.' });
    return;
  }

  try {
    const membership = await requireGroupMember(req, res, groupId);
    if (!membership) return;
    if (membership.role !== 'owner') {
      res.status(403).json({ error: 'Only group owner can update settings.' });
      return;
    }

    const { data, error } = await admin
      .from('groups')
      .update({
        prediction_lock_minutes: Math.floor(predictionLockMinutes),
        bonus_enabled: Boolean(bonusEnabled)
      })
      .eq('id', groupId)
      .select('*')
      .single();
    if (error || !data) {
      throw new Error(error?.message ?? 'Failed to update group settings.');
    }

    res.status(200).json({ group: data });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to update settings.' });
  }
});

app.delete('/internal/db/groups/:groupId', requireFirebaseAuth, async (req: AuthedRequest, res) => {
  const admin = requireSupabaseAdmin(res);
  if (!admin) return;
  const rawGroupId = req.params.groupId;
  const groupId = Array.isArray(rawGroupId) ? rawGroupId[0] : rawGroupId;
  if (!groupId) {
    res.status(400).json({ error: 'groupId is required.' });
    return;
  }

  try {
    const membership = await requireGroupMember(req, res, groupId);
    if (!membership) return;
    if (membership.role !== 'owner') {
      res.status(403).json({ error: 'Only group owner can delete the group.' });
      return;
    }

    const { error } = await admin.from('groups').delete().eq('id', groupId).eq('owner_uid', membership.user_uid);
    if (error) {
      throw new Error(error.message);
    }

    res.status(200).json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to delete group.' });
  }
});

app.get('/internal/db/groups/:groupId/members', requireFirebaseAuth, async (req: AuthedRequest, res) => {
  const admin = requireSupabaseAdmin(res);
  if (!admin) return;
  const rawGroupId = req.params.groupId;
  const groupId = Array.isArray(rawGroupId) ? rawGroupId[0] : rawGroupId;
  if (!groupId) {
    res.status(400).json({ error: 'groupId is required.' });
    return;
  }

  try {
    const membership = await requireGroupMember(req, res, groupId);
    if (!membership) return;

    const { data, error } = await admin
      .from('group_members')
      .select('*')
      .eq('group_id', groupId)
      .order('created_at', { ascending: true });
    if (error) {
      throw new Error(error.message);
    }

    res.status(200).json({ members: data ?? [] });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to load group members.' });
  }
});

app.get('/internal/db/groups/:groupId/invites', requireFirebaseAuth, async (req: AuthedRequest, res) => {
  const admin = requireSupabaseAdmin(res);
  if (!admin) return;
  const rawGroupId = req.params.groupId;
  const groupId = Array.isArray(rawGroupId) ? rawGroupId[0] : rawGroupId;
  if (!groupId) {
    res.status(400).json({ error: 'groupId is required.' });
    return;
  }

  try {
    const membership = await requireGroupMember(req, res, groupId);
    if (!membership) return;

    const { data, error } = await admin
      .from('group_invites')
      .select('*')
      .eq('group_id', groupId)
      .order('created_at', { ascending: false });
    if (error) {
      throw new Error(error.message);
    }

    res.status(200).json({ invites: data ?? [] });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to load invites.' });
  }
});

app.post('/internal/db/invites', requireFirebaseAuth, async (req: AuthedRequest, res) => {
  const admin = requireSupabaseAdmin(res);
  if (!admin) return;
  const { groupId, email } = req.body as { groupId?: string; email?: string };
  const invitedByUid = req.auth?.uid ?? '';

  if (!groupId || !email || !isValidEmail(email)) {
    res.status(400).json({ error: 'Valid groupId and email are required.' });
    return;
  }

  try {
    const membership = await requireGroupMember(req, res, groupId);
    if (!membership) return;

    const { error } = await admin.from('group_invites').upsert(
      {
        group_id: groupId,
        invited_by_uid: invitedByUid,
        email: email.toLowerCase().trim(),
        status: 'pending'
      },
      { onConflict: 'group_id,email' }
    );
    if (error) {
      throw new Error(error.message);
    }

    res.status(200).json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to invite member.' });
  }
});

app.post('/internal/db/invites/accept', requireFirebaseAuth, async (req: AuthedRequest, res) => {
  const admin = requireSupabaseAdmin(res);
  if (!admin) return;
  const userUid = req.auth?.uid ?? '';
  const userEmail = req.auth?.email?.toLowerCase().trim() ?? '';

  try {
    const { data: invites, error: inviteError } = await admin
      .from('group_invites')
      .select('*')
      .eq('email', userEmail)
      .eq('status', 'pending');
    if (inviteError) {
      throw new Error(inviteError.message);
    }
    if (!invites || invites.length === 0) {
      res.status(200).json({ acceptedCount: 0 });
      return;
    }

    for (const invite of invites) {
      const { error: memberError } = await admin.from('group_members').upsert(
        {
          group_id: invite.group_id,
          user_uid: userUid,
          email: userEmail,
          role: 'member'
        },
        { onConflict: 'group_id,user_uid' }
      );
      if (memberError) {
        throw new Error(memberError.message);
      }
    }

    const inviteIds = invites.map((item) => item.id);
    const { error: updateError } = await admin
      .from('group_invites')
      .update({ status: 'accepted', accepted_at: new Date().toISOString() })
      .in('id', inviteIds);
    if (updateError) {
      throw new Error(updateError.message);
    }

    res.status(200).json({ acceptedCount: invites.length });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to accept invites.' });
  }
});

app.get('/internal/db/groups/:groupId/bonus-matches', requireFirebaseAuth, async (req: AuthedRequest, res) => {
  const admin = requireSupabaseAdmin(res);
  if (!admin) return;
  const rawGroupId = req.params.groupId;
  const groupId = Array.isArray(rawGroupId) ? rawGroupId[0] : rawGroupId;
  if (!groupId) {
    res.status(400).json({ error: 'groupId is required.' });
    return;
  }

  try {
    const membership = await requireGroupMember(req, res, groupId);
    if (!membership) return;

    const { data, error } = await admin
      .from('group_match_bonus')
      .select('*')
      .eq('group_id', groupId)
      .order('created_at', { ascending: false });
    if (error) {
      throw new Error(error.message);
    }

    res.status(200).json({ bonusMatches: data ?? [] });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to load bonus matches.' });
  }
});

app.put('/internal/db/groups/:groupId/bonus-matches', requireFirebaseAuth, async (req: AuthedRequest, res) => {
  const admin = requireSupabaseAdmin(res);
  if (!admin) return;
  const rawGroupId = req.params.groupId;
  const groupId = Array.isArray(rawGroupId) ? rawGroupId[0] : rawGroupId;
  if (!groupId) {
    res.status(400).json({ error: 'groupId is required.' });
    return;
  }

  const { items } = req.body as {
    items?: Array<{ matchId: number; label?: string; multiplier?: number; active?: boolean }>;
  };
  if (!Array.isArray(items)) {
    res.status(400).json({ error: 'items array is required.' });
    return;
  }

  try {
    const membership = await requireGroupMember(req, res, groupId);
    if (!membership) return;
    if (membership.role !== 'owner') {
      res.status(403).json({ error: 'Only group owner can update bonus matches.' });
      return;
    }

    for (const item of items) {
      if (!item?.matchId || typeof item.matchId !== 'number') {
        continue;
      }
      const multiplier =
        typeof item.multiplier === 'number' && item.multiplier >= 1 && item.multiplier <= 5 ? item.multiplier : 1;
      const label = (item.label ?? 'custom').trim() || 'custom';
      const active = item.active !== false;

      const { error } = await admin.from('group_match_bonus').upsert(
        {
          group_id: groupId,
          match_id: item.matchId,
          label,
          multiplier,
          active
        },
        { onConflict: 'group_id,match_id' }
      );
      if (error) {
        throw new Error(error.message);
      }
    }

    const { data, error } = await admin
      .from('group_match_bonus')
      .select('*')
      .eq('group_id', groupId)
      .order('created_at', { ascending: false });
    if (error) {
      throw new Error(error.message);
    }

    res.status(200).json({ bonusMatches: data ?? [] });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to update bonus matches.' });
  }
});

app.get('/internal/db/groups/:groupId/custom-matches', requireFirebaseAuth, async (req: AuthedRequest, res) => {
  const admin = requireSupabaseAdmin(res);
  if (!admin) return;
  const rawGroupId = req.params.groupId;
  const groupId = Array.isArray(rawGroupId) ? rawGroupId[0] : rawGroupId;
  if (!groupId) {
    res.status(400).json({ error: 'groupId is required.' });
    return;
  }
  const matchDate = typeof req.query.matchDate === 'string' ? req.query.matchDate : undefined;

  try {
    const membership = await requireGroupMember(req, res, groupId);
    if (!membership) return;

    let query = admin.from('group_custom_matches').select('*').eq('group_id', groupId);
    if (matchDate) {
      query = query.eq('match_date', matchDate);
    }
    const { data, error } = await query.order('created_at', { ascending: false });
    if (error) {
      throw new Error(error.message);
    }
    res.status(200).json({ customMatches: data ?? [] });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to load custom matches.' });
  }
});

app.put('/internal/db/groups/:groupId/custom-matches', requireFirebaseAuth, async (req: AuthedRequest, res) => {
  const admin = requireSupabaseAdmin(res);
  if (!admin) return;
  const rawGroupId = req.params.groupId;
  const groupId = Array.isArray(rawGroupId) ? rawGroupId[0] : rawGroupId;
  if (!groupId) {
    res.status(400).json({ error: 'groupId is required.' });
    return;
  }
  const { matchDate, matchIds } = req.body as { matchDate?: string; matchIds?: number[] };
  if (!matchDate || !Array.isArray(matchIds)) {
    res.status(400).json({ error: 'matchDate and matchIds are required.' });
    return;
  }
  const normalizedMatchIds = Array.from(new Set(matchIds.filter((item) => typeof item === 'number' && Number.isFinite(item) && item > 0)));

  try {
    const membership = await requireGroupMember(req, res, groupId);
    if (!membership) return;
    if (membership.role !== 'owner') {
      res.status(403).json({ error: 'Only group owner can update custom matches.' });
      return;
    }

    const { data: group, error: groupError } = await admin
      .from('groups')
      .select('match_selection_mode')
      .eq('id', groupId)
      .single<{ match_selection_mode: 'competition' | 'custom' }>();
    if (groupError || !group) {
      throw new Error(groupError?.message ?? 'Group not found.');
    }
    if (group.match_selection_mode !== 'custom') {
      res.status(400).json({ error: 'This group does not use custom match selection mode.' });
      return;
    }

    const range = getAdjacentDateRange(matchDate);
    if (!range) {
      res.status(400).json({ error: 'Invalid match date.' });
      return;
    }
    const allMatchesForDate = await fetchEspnMatchesInRange(range.from, range.to);
    const allowedIds = new Set(allMatchesForDate.map((item) => Number((item as Record<string, unknown>).id ?? 0)).filter(Boolean));
    const validIds = normalizedMatchIds.filter((matchId) => allowedIds.has(matchId));

    const { error: deleteError } = await admin
      .from('group_custom_matches')
      .delete()
      .eq('group_id', groupId)
      .eq('match_date', matchDate);
    if (deleteError) {
      throw new Error(deleteError.message);
    }

    if (validIds.length > 0) {
      const rows = validIds.map((matchId) => ({
        group_id: groupId,
        match_id: matchId,
        match_date: matchDate,
        added_by_uid: membership.user_uid
      }));
      const { error: upsertError } = await admin.from('group_custom_matches').upsert(rows, { onConflict: 'group_id,match_id' });
      if (upsertError) {
        throw new Error(upsertError.message);
      }
    }

    const { data, error } = await admin
      .from('group_custom_matches')
      .select('*')
      .eq('group_id', groupId)
      .eq('match_date', matchDate)
      .order('created_at', { ascending: false });
    if (error) {
      throw new Error(error.message);
    }

    res.status(200).json({ customMatches: data ?? [] });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to update custom matches.' });
  }
});

app.get('/internal/db/groups/:groupId/predictions', requireFirebaseAuth, async (req: AuthedRequest, res) => {
  const admin = requireSupabaseAdmin(res);
  if (!admin) return;
  const rawGroupId = req.params.groupId;
  const groupId = Array.isArray(rawGroupId) ? rawGroupId[0] : rawGroupId;
  if (!groupId) {
    res.status(400).json({ error: 'groupId is required.' });
    return;
  }
  const matchDate = typeof req.query.matchDate === 'string' ? req.query.matchDate : undefined;
  const mineOnly = req.query.mine === '1';
  const userUid = req.auth?.uid ?? '';

  try {
    const membership = await requireGroupMember(req, res, groupId);
    if (!membership) return;

    let query = admin.from('predictions').select('*').eq('group_id', groupId);
    if (matchDate) {
      query = query.eq('match_date', matchDate);
    }
    if (mineOnly) {
      query = query.eq('user_uid', userUid);
    }
    const { data, error } = await query;
    if (error) {
      throw new Error(error.message);
    }

    res.status(200).json({ predictions: data ?? [] });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to load predictions.' });
  }
});

app.get('/internal/db/groups/:groupId/leaderboard', requireFirebaseAuth, async (req: AuthedRequest, res) => {
  const admin = requireSupabaseAdmin(res);
  if (!admin) return;
  const rawGroupId = req.params.groupId;
  const groupId = Array.isArray(rawGroupId) ? rawGroupId[0] : rawGroupId;
  if (!groupId) {
    res.status(400).json({ error: 'groupId is required.' });
    return;
  }

  const scope = req.query.scope === 'weekly' ? 'weekly' : 'total';
  const referenceDateInput = typeof req.query.referenceDate === 'string' ? req.query.referenceDate : new Date().toISOString();
  const referenceDate = new Date(referenceDateInput);
  const weekStart = getWeekStart(referenceDate);
  const weekEnd = new Date(weekStart.getTime());
  weekEnd.setUTCDate(weekEnd.getUTCDate() + 6);

  try {
    const membership = await requireGroupMember(req, res, groupId);
    if (!membership) return;

    const { data: group, error: groupError } = await admin
      .from('groups')
      .select('bonus_enabled,competition_id,match_selection_mode')
      .eq('id', groupId)
      .single<{ bonus_enabled: boolean; competition_id: number; match_selection_mode: 'competition' | 'custom' }>();
    if (groupError || !group) {
      throw new Error(groupError?.message ?? 'Group not found.');
    }

    const { data: members, error: memberError } = await admin.from('group_members').select('*').eq('group_id', groupId);
    if (memberError) {
      throw new Error(memberError.message);
    }

    const { data: allPredictions, error: predictionError } = await admin
      .from('predictions')
      .select('*')
      .eq('group_id', groupId);
    if (predictionError) {
      throw new Error(predictionError.message);
    }

    const { data: bonuses, error: bonusError } = await admin
      .from('group_match_bonus')
      .select('match_id,multiplier,active')
      .eq('group_id', groupId);
    if (bonusError) {
      throw new Error(bonusError.message);
    }
    const bonusByMatch = new Map<number, { multiplier: number; active: boolean }>(
      (bonuses ?? []).map((item) => [item.match_id, { multiplier: item.multiplier, active: item.active }])
    );

    const matchIds = Array.from(new Set((allPredictions ?? []).map((item) => item.match_id)));
    const matchesById = new Map<number, MatchApi>();
    await Promise.all(
      matchIds.map(async (matchId) => {
        const predictionForDate = (allPredictions ?? []).find((item) => item.match_id === matchId);
        const match =
          group.match_selection_mode === 'custom'
            ? await fetchMatchForAnyCompetition({
                matchId,
                matchDate: predictionForDate?.match_date
              })
            : await fetchMatchForCompetition({
                competitionId: group.competition_id,
                matchId,
                matchDate: predictionForDate?.match_date
              });
        if (match) matchesById.set(matchId, match);
      })
    );

    const scoredRows: Array<{
      group_id: string;
      match_id: number;
      user_uid: string;
      match_date: string;
      winner_points: number;
      ht_points: number;
      ft_points: number;
      bonus_points: number;
      total_points: number;
      result_ht_home: number;
      result_ht_away: number;
      result_ft_home: number;
      result_ft_away: number;
      result_winner: string;
      computed_at: string;
      created_at: string;
      matchday: number | null;
    }> = [];

    for (const prediction of allPredictions ?? []) {
      const match = matchesById.get(prediction.match_id);
      if (!match) continue;
      const bonus = bonusByMatch.get(prediction.match_id);
      const multiplier = group.bonus_enabled && bonus?.active ? Number(bonus.multiplier ?? 1) : 1;
      const points = calculatePointsForPrediction({
        prediction,
        match,
        bonusMultiplier: multiplier
      });
      if (!points) continue;

      scoredRows.push({
        group_id: prediction.group_id,
        match_id: prediction.match_id,
        user_uid: prediction.user_uid,
        match_date: prediction.match_date,
        winner_points: points.winnerPoints,
        ht_points: points.htPoints,
        ft_points: points.ftPoints,
        bonus_points: points.bonusPoints,
        total_points: points.totalPoints,
        result_ht_home: points.resultHtHome,
        result_ht_away: points.resultHtAway,
        result_ft_home: points.resultFtHome,
        result_ft_away: points.resultFtAway,
        result_winner: points.resultWinner,
        computed_at: new Date().toISOString(),
        created_at: prediction.created_at,
        matchday: match.matchday ?? null
      });
    }

    if (scoredRows.length > 0) {
      const snapshotPayload = scoredRows.map((row) => ({
        group_id: row.group_id,
        match_id: row.match_id,
        user_uid: row.user_uid,
        match_date: row.match_date,
        winner_points: row.winner_points,
        ht_points: row.ht_points,
        ft_points: row.ft_points,
        bonus_points: row.bonus_points,
        total_points: row.total_points,
        result_ht_home: row.result_ht_home,
        result_ht_away: row.result_ht_away,
        result_ft_home: row.result_ft_home,
        result_ft_away: row.result_ft_away,
        result_winner: row.result_winner,
        computed_at: row.computed_at
      }));
      const { error: snapshotError } = await admin
        .from('prediction_points_snapshots')
        .upsert(snapshotPayload, { onConflict: 'group_id,match_id,user_uid' });
      if (snapshotError) {
        throw new Error(snapshotError.message);
      }
    }

    const filteredRows =
      scope === 'weekly'
        ? scoredRows.filter((row) => {
            const d = new Date(`${row.match_date}T00:00:00.000Z`);
            return d >= weekStart && d <= weekEnd;
          })
        : scoredRows;

    const aggregate = new Map<
      string,
      {
        user_uid: string;
        points: number;
        winner_count: number;
        exact_ht_count: number;
        exact_ft_count: number;
        earliest_submission: string | null;
      }
    >();
    for (const member of members ?? []) {
      aggregate.set(member.user_uid, {
        user_uid: member.user_uid,
        points: 0,
        winner_count: 0,
        exact_ht_count: 0,
        exact_ft_count: 0,
        earliest_submission: null
      });
    }
    for (const row of filteredRows) {
      const current = aggregate.get(row.user_uid);
      if (!current) continue;
      current.points += row.total_points;
      current.winner_count += row.winner_points;
      current.exact_ht_count += row.ht_points;
      current.exact_ft_count += row.ft_points;
      if (!current.earliest_submission || row.created_at < current.earliest_submission) {
        current.earliest_submission = row.created_at;
      }
    }

    const { data: snapshotsAll, error: snapshotsError } = await admin
      .from('prediction_points_snapshots')
      .select('user_uid,match_date,total_points')
      .eq('group_id', groupId);
    if (snapshotsError) {
      throw new Error(snapshotsError.message);
    }

    const positiveDatesByUser = new Map<string, Set<string>>();
    for (const item of snapshotsAll ?? []) {
      if (item.total_points <= 0) continue;
      const set = positiveDatesByUser.get(item.user_uid) ?? new Set<string>();
      set.add(item.match_date);
      positiveDatesByUser.set(item.user_uid, set);
    }

    const leaderboard = Array.from(aggregate.values())
      .map((row) => {
        const dateSet = Array.from(positiveDatesByUser.get(row.user_uid) ?? [])
          .map((value) => new Date(`${value}T00:00:00.000Z`).getTime())
          .sort((a, b) => a - b);
        let streak = 0;
        let prev: number | null = null;
        for (const ts of dateSet) {
          if (prev === null || ts - prev === 86_400_000) {
            streak += 1;
          } else {
            streak = 1;
          }
          prev = ts;
        }

        return {
          ...row,
          streak_days: streak
        };
      })
      .sort((a, b) => {
        if (b.points !== a.points) return b.points - a.points;
        if (b.exact_ft_count !== a.exact_ft_count) return b.exact_ft_count - a.exact_ft_count;
        if (b.exact_ht_count !== a.exact_ht_count) return b.exact_ht_count - a.exact_ht_count;
        if (!a.earliest_submission && !b.earliest_submission) return 0;
        if (!a.earliest_submission) return 1;
        if (!b.earliest_submission) return -1;
        return a.earliest_submission.localeCompare(b.earliest_submission);
      })
      .map((row, index) => ({
        rank: index + 1,
        ...row,
        email: (members ?? []).find((member) => member.user_uid === row.user_uid)?.email ?? row.user_uid
      }));

    const historyByRound = new Map<number, { round: number; total_points: number }>();
    for (const row of filteredRows) {
      const round = row.matchday ?? 0;
      if (!historyByRound.has(round)) {
        historyByRound.set(round, { round, total_points: 0 });
      }
      const current = historyByRound.get(round);
      if (current) {
        current.total_points += row.total_points;
      }
    }
    const rounds = Array.from(historyByRound.values()).sort((a, b) => a.round - b.round);

    res.status(200).json({
      scope,
      weekStart: weekStart.toISOString().slice(0, 10),
      weekEnd: weekEnd.toISOString().slice(0, 10),
      leaderboard,
      rounds
    });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to load leaderboard.' });
  }
});

app.post('/internal/db/predictions', requireFirebaseAuth, async (req: AuthedRequest, res) => {
  const admin = requireSupabaseAdmin(res);
  if (!admin) return;

  const { groupId, matchId, matchDate, htHome, htAway, ftHome, ftAway, goalPlayers, yellowCardPlayers, redCardPlayers } =
    req.body as {
    groupId?: string;
    matchId?: number;
    matchDate?: string;
    htHome?: number;
    htAway?: number;
    ftHome?: number;
    ftAway?: number;
    goalPlayers?: unknown;
    yellowCardPlayers?: unknown;
    redCardPlayers?: unknown;
  };
  const userUid = req.auth?.uid ?? '';

  const numbers = [htHome, htAway, ftHome, ftAway];
  if (!groupId || !matchId || !matchDate || numbers.some((value) => typeof value !== 'number' || value < 0)) {
    res.status(400).json({ error: 'Invalid prediction payload.' });
    return;
  }

  try {
    const membership = await requireGroupMember(req, res, groupId);
    if (!membership) return;

    const { data: group, error: groupError } = await admin
      .from('groups')
      .select('competition_id,prediction_lock_minutes,match_selection_mode')
      .eq('id', groupId)
      .single<{ competition_id: number; prediction_lock_minutes: number; match_selection_mode: 'competition' | 'custom' }>();
    if (groupError || !group) {
      throw new Error(groupError?.message ?? 'Group not found.');
    }

    let matchStatus = '';
    let kickoffAt = Number.NaN;
    if (group.match_selection_mode === 'custom') {
      const { data: selected, error: selectedError } = await admin
        .from('group_custom_matches')
        .select('match_id')
        .eq('group_id', groupId)
        .eq('match_date', matchDate)
        .eq('match_id', matchId)
        .maybeSingle<{ match_id: number }>();
      if (selectedError) {
        throw new Error(selectedError.message);
      }
      if (!selected) {
        res.status(400).json({ error: 'This match is not in the custom selection for this group/date.' });
        return;
      }

      const matchData = await fetchMatchForAnyCompetition({ matchId, matchDate });
      if (!matchData) {
        res.status(400).json({ error: 'Match not found for this date.' });
        return;
      }
      matchStatus = matchData.status ?? '';
      kickoffAt = matchData.utcDate ? Date.parse(matchData.utcDate) : Number.NaN;
    } else {
      const competitionMatches = await fetchCompetitionMatchesForDate({
        competitionId: group.competition_id,
        matchDate
      });
      const matchData = competitionMatches.find((item) => item.id === matchId);
      if (!matchData) {
        res.status(400).json({ error: 'Match not found for this competition/date.' });
        return;
      }
      const matchCompetitionId = matchData.competition?.id;
      if (matchCompetitionId !== group.competition_id) {
        res.status(400).json({ error: 'This match is not part of the group competition.' });
        return;
      }
      matchStatus = matchData.status ?? '';
      kickoffAt = matchData.utcDate ? Date.parse(matchData.utcDate) : Number.NaN;
    }

    const lockMinutes = Math.max(0, Math.min(180, Number(group.prediction_lock_minutes ?? 0)));
    const lockAt = Number.isFinite(kickoffAt) ? kickoffAt - lockMinutes * 60_000 : Number.NaN;
    const isOpen =
      ['SCHEDULED', 'TIMED'].includes(matchStatus) && Number.isFinite(lockAt) && lockAt > Date.now();
    if (!isOpen) {
      res.status(423).json({ error: 'Predictions are locked for this match.' });
      return;
    }

    const totalPoints = await loadUserGroupTotalPoints(groupId, userUid);
    const maxBonusPicksPerTeam = getBonusPickLimitForPoints(totalPoints);
    const normalizedGoalPlayers = sanitizePredictedPlayers(goalPlayers, maxBonusPicksPerTeam);
    const normalizedYellowCardPlayers = sanitizePredictedPlayers(yellowCardPlayers, maxBonusPicksPerTeam);
    const normalizedRedCardPlayers = sanitizePredictedPlayers(redCardPlayers, maxBonusPicksPerTeam);

    const { error } = await admin.from('predictions').upsert(
      {
        group_id: groupId,
        match_id: matchId,
        user_uid: userUid,
        match_date: matchDate,
        match_kickoff_at: new Date(kickoffAt).toISOString(),
        lock_at: new Date(lockAt).toISOString(),
        ht_home: htHome,
        ht_away: htAway,
        ft_home: ftHome,
        ft_away: ftAway,
        goal_players: normalizedGoalPlayers,
        yellow_card_players: normalizedYellowCardPlayers,
        red_card_players: normalizedRedCardPlayers
      },
      { onConflict: 'group_id,match_id,user_uid' }
    );
    if (error) {
      throw new Error(error.message);
    }

    res.status(200).json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to save prediction.' });
  }
});

app.post('/internal/db/push-subscriptions', requireFirebaseAuth, async (req: AuthedRequest, res) => {
  const admin = requireSupabaseAdmin(res);
  if (!admin) return;
  const userUid = req.auth?.uid ?? '';
  const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
  const platform = typeof req.body?.platform === 'string' ? req.body.platform.trim().slice(0, 30) : 'web';
  if (!token || token.length > 4096) {
    res.status(400).json({ error: 'Invalid push notification token.' });
    return;
  }

  try {
    const { error } = await admin.from('push_subscriptions').upsert(
      {
        user_uid: userUid,
        token,
        platform: platform || 'web',
        updated_at: new Date().toISOString()
      },
      { onConflict: 'token' }
    );
    if (error) throw new Error(error.message);
    res.status(200).json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to save push subscription.' });
  }
});

app.post('/internal/db/push-subscriptions/test', requireFirebaseAuth, async (req: AuthedRequest, res) => {
  const admin = requireSupabaseAdmin(res);
  if (!admin) return;
  if (!firebaseServiceAccount) {
    res.status(503).json({ error: 'Firebase service account is not configured.' });
    return;
  }

  try {
    const userUid = req.auth?.uid ?? '';
    const { data, error } = await admin.from('push_subscriptions').select('id,token').eq('user_uid', userUid);
    if (error) throw new Error(error.message);
    if (!data?.length) {
      res.status(404).json({ error: 'Enable push notifications on this device first.' });
      return;
    }

    let sent = 0;
    for (const subscription of data) {
      try {
        await sendFirebasePush({
          token: String(subscription.token),
          title: 'PrediLeague notifications are ready',
          body: 'You will receive match reminders 20 minutes before kickoff.',
          link: `${appBaseUrl}/#game`
        });
        sent += 1;
      } catch (sendError) {
        const status = (sendError as Error & { status?: string }).status;
        if (status === 'NOT_FOUND' || status === 'UNREGISTERED') {
          await admin.from('push_subscriptions').delete().eq('id', subscription.id);
        }
      }
    }
    if (sent === 0) {
      res.status(502).json({ error: 'Firebase could not deliver the test notification.' });
      return;
    }
    res.status(200).json({ ok: true, sent });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to send test notification.' });
  }
});

app.post('/internal/cron/push-reminders', async (req, res) => {
  if (!cronSecret || req.headers.authorization !== `Bearer ${cronSecret}`) {
    res.status(401).json({ error: 'Invalid cron authorization.' });
    return;
  }
  const admin = requireSupabaseAdmin(res);
  if (!admin) return;
  if (!firebaseServiceAccount) {
    res.status(503).json({ error: 'Firebase service account is not configured.' });
    return;
  }

  try {
    const now = new Date();
    const fromDate = new Date(now.getTime() - 24 * 60 * 60_000).toISOString().slice(0, 10);
    const toDate = new Date(now.getTime() + 24 * 60 * 60_000).toISOString().slice(0, 10);

    const [{ data: profiles, error: profileError }, { data: subscriptions, error: subscriptionError }] =
      await Promise.all([
        admin
          .from('user_profiles')
          .select('user_uid,reminders_enabled,reminder_minutes_before,take_break_until')
          .eq('reminders_enabled', true),
        admin.from('push_subscriptions').select('id,user_uid,token')
      ]);
    if (profileError) throw new Error(profileError.message);
    if (subscriptionError) throw new Error(subscriptionError.message);

    const subscribedUserIds = new Set((subscriptions ?? []).map((row) => String(row.user_uid)));
    const activeProfiles = (profiles ?? []).filter((row) => {
      if (!subscribedUserIds.has(String(row.user_uid))) return false;
      if (!row.take_break_until) return true;
      return Date.parse(String(row.take_break_until)) <= now.getTime();
    });
    const activeUserIds = activeProfiles.map((row) => String(row.user_uid));
    if (activeUserIds.length === 0) {
      res.status(200).json({ checked: 0, sent: 0 });
      return;
    }

    const { data: memberships, error: membershipError } = await admin
      .from('group_members')
      .select('group_id,user_uid')
      .in('user_uid', activeUserIds);
    if (membershipError) throw new Error(membershipError.message);
    const groupIds = Array.from(new Set((memberships ?? []).map((row) => String(row.group_id))));
    if (groupIds.length === 0) {
      res.status(200).json({ checked: activeProfiles.length, sent: 0 });
      return;
    }

    const { data: groups, error: groupError } = await admin
      .from('groups')
      .select('id,competition_id,match_selection_mode')
      .in('id', groupIds);
    if (groupError) throw new Error(groupError.message);

    const customGroupIds = (groups ?? [])
      .filter((group) => group.match_selection_mode === 'custom')
      .map((group) => String(group.id));
    const customMatchesQuery =
      customGroupIds.length > 0
        ? await admin
            .from('group_custom_matches')
            .select('group_id,match_id')
            .in('group_id', customGroupIds)
            .gte('match_date', fromDate)
            .lte('match_date', toDate)
        : { data: [], error: null };
    if (customMatchesQuery.error) throw new Error(customMatchesQuery.error.message);

    const matchRows: Array<Record<string, unknown>> = [];
    const competitionIds = Array.from(
      new Set(
        (groups ?? [])
          .filter((group) => group.match_selection_mode !== 'custom')
          .map((group) => Number(group.competition_id))
          .filter(Number.isFinite)
      )
    );
    const leagueKeys = Array.from(
      new Set(
        competitionIds
          .map((competitionId) => getEspnLeagueByFootballCompetitionId(competitionId))
          .filter((league): league is string => Boolean(league))
      )
    );
    const leagueResults = await Promise.all(
      leagueKeys.map((league) => fetchEspnLeagueMatchesInRange(league, fromDate, toDate))
    );
    for (const rows of leagueResults) matchRows.push(...rows);
    if (customGroupIds.length > 0) {
      matchRows.push(...(await fetchEspnMatchesInRange(fromDate, toDate)));
    }

    const matchesById = new Map<number, MatchApi>();
    for (const row of matchRows) {
      const match = row as unknown as MatchApi;
      const matchId = Number(match.id ?? 0);
      if (matchId && !matchesById.has(matchId)) matchesById.set(matchId, match);
    }
    const upcomingMatches = Array.from(matchesById.values()).filter((match) => {
      const kickoff = Date.parse(match.utcDate ?? '');
      return (
        ['TIMED', 'SCHEDULED'].includes(match.status ?? '') &&
        Number.isFinite(kickoff) &&
        kickoff > now.getTime() &&
        kickoff <= now.getTime() + 181 * 60_000
      );
    });
    if (upcomingMatches.length === 0) {
      res.status(200).json({ checked: activeProfiles.length, sent: 0 });
      return;
    }

    const upcomingMatchIds = upcomingMatches.map((match) => Number(match.id));
    const { data: predictions, error: predictionError } = await admin
      .from('predictions')
      .select('group_id,match_id,user_uid')
      .in('user_uid', activeUserIds)
      .in('match_id', upcomingMatchIds);
    if (predictionError) throw new Error(predictionError.message);

    const predictionsSet = new Set(
      (predictions ?? []).map((row) => `${row.user_uid}:${row.group_id}:${row.match_id}`)
    );
    const subscriptionsByUser = new Map<string, Array<{ id: string; token: string }>>();
    for (const row of subscriptions ?? []) {
      const userUid = String(row.user_uid);
      const list = subscriptionsByUser.get(userUid) ?? [];
      list.push({ id: String(row.id), token: String(row.token) });
      subscriptionsByUser.set(userUid, list);
    }
    const groupById = new Map((groups ?? []).map((group) => [String(group.id), group]));
    const groupIdsByUser = new Map<string, string[]>();
    for (const membership of memberships ?? []) {
      const userUid = String(membership.user_uid);
      const list = groupIdsByUser.get(userUid) ?? [];
      list.push(String(membership.group_id));
      groupIdsByUser.set(userUid, list);
    }
    const customMatchSet = new Set(
      (customMatchesQuery.data ?? []).map((row) => `${row.group_id}:${row.match_id}`)
    );

    let sent = 0;
    for (const profile of activeProfiles) {
      const userUid = String(profile.user_uid);
      const reminderMinutes = Math.max(5, Math.min(180, Number(profile.reminder_minutes_before ?? 20)));
      for (const match of upcomingMatches) {
        const matchId = Number(match.id);
        const kickoff = Date.parse(match.utcDate ?? '');
        const minutesUntil = (kickoff - now.getTime()) / 60_000;
        if (minutesUntil > reminderMinutes || minutesUntil <= reminderMinutes - 2) continue;

        const relevantGroupIds = (groupIdsByUser.get(userUid) ?? []).filter((groupId) => {
          const group = groupById.get(groupId);
          if (!group) return false;
          if (group.match_selection_mode === 'custom') {
            return customMatchSet.has(`${groupId}:${matchId}`);
          }
          return Number(group.competition_id) === Number(match.competition?.id);
        });
        const missingGroupIds = relevantGroupIds.filter(
          (groupId) => !predictionsSet.has(`${userUid}:${groupId}:${matchId}`)
        );
        if (missingGroupIds.length === 0) continue;

        const { error: deliveryError } = await admin.from('match_reminder_deliveries').insert({
          user_uid: userUid,
          match_id: matchId,
          reminder_minutes: reminderMinutes
        });
        if (deliveryError?.code === '23505') continue;
        if (deliveryError) throw new Error(deliveryError.message);

        const homeName = match.homeTeam?.shortName ?? match.homeTeam?.name ?? 'Home team';
        const awayName = match.awayTeam?.shortName ?? match.awayTeam?.name ?? 'Away team';
        let successfulTokens = 0;
        for (const subscription of subscriptionsByUser.get(userUid) ?? []) {
          try {
            await sendFirebasePush({
              token: subscription.token,
              title: `${homeName} vs ${awayName} starts in ${Math.round(minutesUntil)} min`,
              body: `Your prediction is missing in ${missingGroupIds.length} group${missingGroupIds.length === 1 ? '' : 's'}.`,
              link: `${appBaseUrl}/#game`
            });
            successfulTokens += 1;
          } catch (error) {
            const status = (error as Error & { status?: string }).status;
            if (status === 'NOT_FOUND' || status === 'UNREGISTERED') {
              await admin.from('push_subscriptions').delete().eq('id', subscription.id);
            }
          }
        }
        if (successfulTokens > 0) {
          sent += 1;
        } else {
          await admin
            .from('match_reminder_deliveries')
            .delete()
            .eq('user_uid', userUid)
            .eq('match_id', matchId)
            .eq('reminder_minutes', reminderMinutes);
        }
      }
    }

    res.status(200).json({ checked: activeProfiles.length, matches: upcomingMatches.length, sent });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to send match reminders.' });
  }
});

app.get('/internal/db/profile', requireFirebaseAuth, async (req: AuthedRequest, res) => {
  const admin = requireSupabaseAdmin(res);
  if (!admin) return;
  const userUid = req.auth?.uid ?? '';

  try {
    const { data, error } = await admin
      .from('user_profiles')
      .select('*')
      .eq('user_uid', userUid)
      .maybeSingle();
    if (error) {
      throw new Error(error.message);
    }

    res.status(200).json({ profile: data ?? null });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to load profile.' });
  }
});

app.put('/internal/db/profile', requireFirebaseAuth, async (req: AuthedRequest, res) => {
  const admin = requireSupabaseAdmin(res);
  if (!admin) return;
  const userUid = req.auth?.uid ?? '';
  const userEmail = req.auth?.email?.toLowerCase().trim() ?? '';
  const { firstName, lastName, displayName, country, favoriteTeam, bio, remindersEnabled, reminderMinutesBefore, weeklySummaryEnabled, takeBreakUntil } = req.body as {
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
  };

  const normalize = (value?: string) => {
    const next = (value ?? '').trim();
    return next.length > 0 ? next : null;
  };
  const normalizeBreakUntil = (value?: string | null) => {
    if (!value) return null;
    const dt = new Date(value);
    if (Number.isNaN(dt.getTime())) return null;
    return dt.toISOString();
  };

  try {
    const payload: Record<string, unknown> = {
      user_uid: userUid,
      email: userEmail,
      first_name: normalize(firstName),
      last_name: normalize(lastName),
      display_name: normalize(displayName),
      country: normalize(country),
      favorite_team: normalize(favoriteTeam),
      bio: normalize(bio),
      updated_at: new Date().toISOString()
    };

    if (typeof remindersEnabled === 'boolean') {
      payload.reminders_enabled = remindersEnabled;
    }
    if (typeof reminderMinutesBefore === 'number' && Number.isFinite(reminderMinutesBefore)) {
      const clamped = Math.max(5, Math.min(180, Math.floor(reminderMinutesBefore)));
      payload.reminder_minutes_before = clamped;
    }
    if (typeof weeklySummaryEnabled === 'boolean') {
      payload.weekly_summary_enabled = weeklySummaryEnabled;
    }
    if (takeBreakUntil !== undefined) {
      payload.take_break_until = normalizeBreakUntil(takeBreakUntil);
    }

    const { error } = await admin.from('user_profiles').upsert(payload, { onConflict: 'user_uid' });
    if (error) {
      throw new Error(error.message);
    }

    res.status(200).json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to save profile.' });
  }
});

const apiProxyHandler = async (req: express.Request, res: express.Response) => {
  try {
    const requestPath = req.originalUrl.startsWith('/api/') ? req.originalUrl.replace(/^\/api/, '') : req.originalUrl;
    const upstreamPath = requestPath.startsWith('/') ? requestPath : `/${requestPath}`;
    const upstreamUrl = new URL(upstreamPath, 'https://espn.local');
    const pathname = upstreamUrl.pathname.toLowerCase();
    const method = req.method.toUpperCase();

    if (method === 'GET' && pathname === '/v4/health') {
      res.status(200).json({
        ok: true,
        runtime: process.env.VERCEL === '1' ? 'vercel' : 'node',
        path: req.originalUrl
      });
      return;
    }

    if (method === 'GET' && pathname === '/v4/competitions') {
      const competitions = ESPN_LEAGUES.map((leagueKey) => {
        const comp = getEspnCompetitionByLeague(leagueKey);
        if (!comp) return null;
        return {
          id: comp.id,
          name: comp.name,
          area: { name: comp.areaName },
          footballDataSupported: isFootballDataCompetitionSupported(comp.id)
        };
      }).filter(
        (row): row is { id: number; name: string; area: { name: string }; footballDataSupported: boolean } =>
          row !== null
      );
      res.status(200).json({ competitions });
      return;
    }

    if (method === 'GET' && pathname.match(/^\/v4\/competitions\/\d+\/matches$/)) {
      const match = pathname.match(/^\/v4\/competitions\/(\d+)\/matches$/);
      const competitionId = Number(match?.[1] ?? Number.NaN);
      const espnLeague = Number.isFinite(competitionId) ? getEspnLeagueByFootballCompetitionId(competitionId) : undefined;
      const dateFrom = upstreamUrl.searchParams.get('dateFrom');
      const dateTo = upstreamUrl.searchParams.get('dateTo');
      if (!espnLeague) {
        res.status(200).json({ matches: [] });
        return;
      }
      if (!dateFrom || !dateTo) {
        const today = new Date();
        const y = today.getUTCFullYear();
        const m = String(today.getUTCMonth() + 1).padStart(2, '0');
        const d = String(today.getUTCDate()).padStart(2, '0');
        const ymd = `${y}-${m}-${d}`;
        const matches = await fetchEspnLeagueMatchesInRange(espnLeague, ymd, ymd);
        const enriched = await enrichMatchesWithSummaryIfNeeded(matches, espnLeague);
        res.status(200).json({ matches: enriched });
        return;
      }
      const matches = await fetchEspnLeagueMatchesInRange(espnLeague, dateFrom, dateTo);
      const shouldEnrich = upstreamUrl.searchParams.get('enrich') !== 'false';
      const payloadMatches = shouldEnrich ? await enrichMatchesWithSummaryIfNeeded(matches, espnLeague) : matches;
      res.status(200).json({ matches: payloadMatches });
      return;
    }

    if (method === 'GET' && pathname === '/v4/matches') {
      const dateFrom = upstreamUrl.searchParams.get('dateFrom');
      const dateTo = upstreamUrl.searchParams.get('dateTo');
      if (dateFrom && dateTo) {
        const matches = await fetchEspnMatchesInRange(dateFrom, dateTo);
        res.status(200).json({ matches });
        return;
      }
    }

    if (method === 'GET' && pathname.match(/^\/v4\/competitions\/\d+\/standings$/)) {
      const match = pathname.match(/^\/v4\/competitions\/(\d+)\/standings$/);
      const competitionId = Number(match?.[1] ?? Number.NaN);
      const competitionRef = getFootballDataCompetitionRef(competitionId);
      if (!footballDataApiKey) {
        res.status(500).json({ error: 'FOOTBALL_DATA_API_KEY is missing on the server.' });
        return;
      }
      const fdQuery = new URLSearchParams();
      const season = upstreamUrl.searchParams.get('season');
      const matchday = upstreamUrl.searchParams.get('matchday');
      if (season) fdQuery.set('season', season);
      if (matchday) fdQuery.set('matchday', matchday);

      const footballDataPayload = await fetchFootballDataJson(`/v4/competitions/${competitionRef}/standings`, fdQuery);
      if (footballDataPayload && Array.isArray((footballDataPayload as { standings?: unknown }).standings)) {
        res.status(200).json(footballDataPayload);
        return;
      }
      res.status(502).json({ error: 'Failed to load standings from football-data for this competition/season.' });
      return;
    }

    if (method === 'GET' && pathname.match(/^\/v4\/competitions\/\d+\/scorers$/)) {
      const match = pathname.match(/^\/v4\/competitions\/(\d+)\/scorers$/);
      const competitionId = Number(match?.[1] ?? Number.NaN);
      const competitionRef = getFootballDataCompetitionRef(competitionId);
      if (!footballDataApiKey) {
        res.status(500).json({ error: 'FOOTBALL_DATA_API_KEY is missing on the server.' });
        return;
      }
      const fdQuery = new URLSearchParams();
      const season = upstreamUrl.searchParams.get('season');
      const limit = Number(upstreamUrl.searchParams.get('limit') ?? 10);
      if (season) fdQuery.set('season', season);
      if (Number.isFinite(limit)) fdQuery.set('limit', String(limit));

      const footballDataPayload = await fetchFootballDataScorersWithFallback(
        competitionRef,
        season,
        Number.isFinite(limit) ? limit : 10
      );
      if (footballDataPayload && Array.isArray((footballDataPayload as { scorers?: unknown }).scorers)) {
        res.status(200).json(footballDataPayload);
        return;
      }
      res.status(502).json({ error: 'Failed to load scorers from football-data for this competition/season.' });
      return;
    }

    if (method === 'GET' && pathname.startsWith('/v4/matches/')) {
      const idPart = pathname.replace('/v4/matches/', '').split('/')[0];
      const matchId = Number(idPart);
      if (Number.isFinite(matchId)) {
        let leagueKey = espnLeagueByEventId.get(matchId) ?? '';
        let match: MatchApi | null = null;
        const cachedEvent = espnEventById.get(matchId);
        if (cachedEvent) {
          match = normalizeEspnEvent(cachedEvent, undefined, leagueKey) as unknown as MatchApi;
        } else {
          const matchDate = upstreamUrl.searchParams.get('matchDate') ?? '';
          const competitionId = Number(upstreamUrl.searchParams.get('competitionId') ?? Number.NaN);
          leagueKey = Number.isFinite(competitionId) ? getEspnLeagueByFootballCompetitionId(competitionId) ?? '' : '';
          const range = getAdjacentDateRange(matchDate);
          if (leagueKey && range) {
            const matches = await fetchEspnLeagueMatchesInRange(leagueKey, range.from, range.to);
            match =
              (matches.find((row) => Number((row as Record<string, unknown>).id ?? 0) === matchId) as unknown as MatchApi) ??
              null;
          } else if (range) {
            const matches = await fetchEspnMatchesInRange(range.from, range.to);
            match =
              (matches.find((row) => Number((row as Record<string, unknown>).id ?? 0) === matchId) as unknown as MatchApi) ??
              null;
            const resolvedCompetitionId = Number(match?.competition?.id ?? Number.NaN);
            leagueKey = Number.isFinite(resolvedCompetitionId)
              ? getEspnLeagueByFootballCompetitionId(resolvedCompetitionId) ?? ''
              : '';
          }
        }
        if (match) {
          const detailedMatch = leagueKey ? await enrichMatchScoreFromSummary(match, leagueKey, matchId) : match;
          res.status(200).json({ match: detailedMatch });
          return;
        }
      }
    }

    if (method === 'GET' && pathname.startsWith('/v4/teams/')) {
      const idPart = pathname.replace('/v4/teams/', '').split('/')[0];
      const teamId = Number(idPart);
      if (Number.isFinite(teamId)) {
        const team = (espnTeamById.get(teamId) ?? {}) as Record<string, unknown>;
        const leagueHint = espnLeagueByTeamId.get(teamId);
        const leaguesToTry = leagueHint ? [leagueHint] : ESPN_LEAGUES;
        let squad: CoreTeamAthlete[] = [];
        for (const league of leaguesToTry) {
          try {
            squad = await fetchSiteTeamSquad(league, teamId);
            if (squad.length === 0) {
              squad = await fetchCoreTeamSquad(league, teamId);
            }
          } catch {
            squad = [];
          }
          if (squad.length > 0) break;
        }
        res.status(200).json({
          team: {
            id: asNumber(team.id) ?? teamId,
            name: String(team.displayName ?? team.shortDisplayName ?? 'Team'),
            shortName: String(team.shortDisplayName ?? team.abbreviation ?? ''),
            tla: String(team.abbreviation ?? ''),
            crest: pickEspnLogoUrl(team),
            nickname: String(team.nickname ?? ''),
            color: String(team.color ?? ''),
            alternateColor: String(team.alternateColor ?? ''),
            form: String(team.form ?? ''),
            venue: String((team.venue as Record<string, unknown> | undefined)?.fullName ?? ''),
            squad
          }
        });
        return;
      }
    }

    res.status(404).json({ error: 'Unsupported API route for ESPN-only mode.' });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Proxy request failed.';
    res.status(502).json({ error: message });
  }
};

app.use('/api', apiProxyHandler);
app.use((req, res, next) => {
  if (req.path.toLowerCase().startsWith('/v4/')) {
    void apiProxyHandler(req, res);
    return;
  }
  next();
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const distDir = path.resolve(__dirname, '../dist');
const indexFile = path.join(distDir, 'index.html');

if (existsSync(indexFile)) {
  app.use(express.static(distDir));

  app.use((_, res) => {
    res.sendFile(indexFile);
  });
}

const isVercelRuntime = process.env.VERCEL === '1';

if (!isVercelRuntime) {
  app.listen(port, () => {
    // Keep this startup log simple for terminal-based deployment visibility.
    console.log(`PredictLeague server listening on http://localhost:${port}`);
  });
}

export default app;
