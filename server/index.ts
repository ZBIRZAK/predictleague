import express from 'express';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import nodemailer from 'nodemailer';
import { createClient } from '@supabase/supabase-js';

const app = express();
const port = Number(process.env.PORT ?? 8787);
const apiBase = 'https://api.football-data.org';

app.use(express.json());

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
const paypalClientId = process.env.PAYPAL_CLIENT_ID ?? '';
const paypalClientSecret = process.env.PAYPAL_CLIENT_SECRET ?? '';
const paypalMode = (process.env.PAYPAL_MODE ?? 'sandbox').toLowerCase() === 'live' ? 'live' : 'sandbox';
const paypalPlanPriceUsd = Number(process.env.PAYWALL_PRO_PRICE_USD ?? 4.99);
const appBaseUrl = process.env.APP_BASE_URL ?? 'http://localhost:5173';
const freeMaxOwnedGroups = Number(process.env.FREE_MAX_OWNED_GROUPS ?? 1);
const paypalApiBase =
  paypalMode === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';

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
const footballApiUsageState: {
  remainingMinute: number | null;
  limitMinute: number | null;
  resetInSeconds: number | null;
  updatedAt: string | null;
} = {
  remainingMinute: null,
  limitMinute: null,
  resetInSeconds: null,
  updatedAt: null
};
const footballApiUsageStreams = new Set<express.Response>();

type AuthContext = {
  uid: string;
  email: string;
};

type MatchApiResponse = {
  match?: MatchApi;
} & MatchApi;

type MatchApi = {
  id?: number;
  status?: string;
  utcDate?: string;
  matchday?: number;
  competition?: { id?: number };
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

function parseHeaderNumber(headers: Headers, keys: string[]) {
  for (const key of keys) {
    const raw = headers.get(key);
    if (!raw) continue;
    const value = Number(raw);
    if (Number.isFinite(value)) {
      return value;
    }
  }
  return null;
}

function updateFootballApiUsage(headers: Headers) {
  footballApiUsageState.remainingMinute = parseHeaderNumber(headers, [
    'x-requests-available-minute',
    'x-ratelimit-remaining',
    'x-rate-limit-remaining'
  ]);
  footballApiUsageState.limitMinute = parseHeaderNumber(headers, [
    'x-requests-limit-minute',
    'x-ratelimit-limit',
    'x-rate-limit-limit'
  ]);
  footballApiUsageState.resetInSeconds = parseHeaderNumber(headers, [
    'x-requests-reset',
    'x-ratelimit-reset',
    'x-rate-limit-reset'
  ]);
  footballApiUsageState.updatedAt = new Date().toISOString();
  const payload = `data: ${JSON.stringify(footballApiUsageState)}\n\n`;
  for (const stream of footballApiUsageStreams) {
    stream.write(payload);
  }
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

function hasPayPalConfig() {
  return Boolean(paypalClientId && paypalClientSecret);
}

async function getPayPalAccessToken() {
  const auth = Buffer.from(`${paypalClientId}:${paypalClientSecret}`).toString('base64');
  const response = await fetch(`${paypalApiBase}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { error_description?: string };
    throw new Error(payload.error_description ?? 'Failed to authenticate with PayPal.');
  }
  const payload = (await response.json()) as { access_token: string };
  return payload.access_token;
}

async function paypalRequest(pathname: string, options: RequestInit = {}) {
  if (!hasPayPalConfig()) {
    throw new Error('PayPal is not configured on server.');
  }
  const token = await getPayPalAccessToken();
  const headers = new Headers(options.headers);
  headers.set('Authorization', `Bearer ${token}`);
  if (options.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  return fetch(`${paypalApiBase}${pathname}`, { ...options, headers });
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

function getWeekStart(dateInput: string | Date) {
  const date = typeof dateInput === 'string' ? new Date(dateInput) : new Date(dateInput.getTime());
  const day = date.getUTCDay();
  const shift = day === 0 ? -6 : 1 - day;
  date.setUTCDate(date.getUTCDate() + shift);
  date.setUTCHours(0, 0, 0, 0);
  return date;
}

async function fetchMatchById(apiKey: string, matchId: number) {
  const response = await fetch(new URL(`/v4/matches/${matchId}`, apiBase), {
    headers: {
      'X-Auth-Token': apiKey,
      Accept: 'application/json'
    }
  });
  updateFootballApiUsage(response.headers);
  if (!response.ok) {
    return null;
  }

  const payload = (await response.json()) as MatchApiResponse;
  return payload.match ?? payload;
}

function calculatePointsForPrediction(params: {
  prediction: {
    ft_home: number;
    ft_away: number;
    ht_home: number;
    ht_away: number;
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
  const matchBonusPoints = Math.max(0, Math.round(baseTotal * (params.bonusMultiplier - 1)));
  const bonusPoints = perfectBonusPoints + matchBonusPoints;
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

app.get('/internal/api-usage', (_req, res) => {
  res.status(200).json(footballApiUsageState);
});

app.get('/internal/api-usage/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  footballApiUsageStreams.add(res);
  res.write(`data: ${JSON.stringify(footballApiUsageState)}\n\n`);

  const keepAliveId = setInterval(() => {
    res.write(': keepalive\n\n');
  }, 25000);

  req.on('close', () => {
    clearInterval(keepAliveId);
    footballApiUsageStreams.delete(res);
  });
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
    const result = await mailer.sendMail({
      from: smtpFrom,
      to: toEmail.trim(),
      subject: `You were invited to join "${groupName}" on PredictLeague`,
      text: `${requesterEmail} invited you to join "${groupName}" on PredictLeague.\n\nSign in with this email in the app to join the group automatically.`,
      html: `<p>${requesterEmail} invited you to join <strong>${groupName}</strong> on PredictLeague.</p><p>Sign in with this email in the app to join the group automatically.</p>`
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

  const { name, competitionId, competitionName, predictionLockMinutes, bonusEnabled } = req.body as {
    name?: string;
    competitionId?: number;
    competitionName?: string;
    predictionLockMinutes?: number;
    bonusEnabled?: boolean;
  };
  const ownerUid = req.auth?.uid ?? '';
  const ownerEmail = req.auth?.email ?? '';

  if (!name?.trim() || !competitionId || !competitionName?.trim()) {
    res.status(400).json({ error: 'name, competitionId and competitionName are required.' });
    return;
  }

  const normalizedLockMinutes =
    typeof predictionLockMinutes === 'number' && predictionLockMinutes >= 0 && predictionLockMinutes <= 180
      ? Math.floor(predictionLockMinutes)
      : 5;
  const normalizedBonusEnabled = Boolean(bonusEnabled);

  try {
    const { data: profile } = await admin
      .from('user_profiles')
      .select('subscription_tier')
      .eq('user_uid', ownerUid)
      .maybeSingle<{ subscription_tier?: string | null }>();
    const tier = (profile?.subscription_tier ?? 'free').toLowerCase();
    if (tier !== 'pro') {
      const { count, error: countError } = await admin
        .from('groups')
        .select('id', { count: 'exact', head: true })
        .eq('owner_uid', ownerUid);
      if (countError) {
        throw new Error(countError.message);
      }
      if ((count ?? 0) >= freeMaxOwnedGroups) {
        res
          .status(402)
          .json({ error: `Free plan limit reached (${freeMaxOwnedGroups} groups). Upgrade to Pro for unlimited groups.` });
        return;
      }
    }

    const { data: group, error: groupError } = await admin
      .from('groups')
      .insert({
        name: name.trim(),
        competition_id: competitionId,
        competition_name: competitionName.trim(),
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

    res.status(200).json({ group });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to create group.' });
  }
});

app.get('/internal/billing/status', requireFirebaseAuth, async (req: AuthedRequest, res) => {
  const admin = requireSupabaseAdmin(res);
  if (!admin) return;
  const userUid = req.auth?.uid ?? '';

  try {
    const { data, error } = await admin
      .from('user_profiles')
      .select('subscription_tier,subscription_status,pro_expires_at,paypal_subscription_id')
      .eq('user_uid', userUid)
      .maybeSingle<{
        subscription_tier?: string | null;
        subscription_status?: string | null;
        pro_expires_at?: string | null;
        paypal_subscription_id?: string | null;
      }>();
    if (error) throw new Error(error.message);

    res.status(200).json({
      tier: (data?.subscription_tier ?? 'free').toLowerCase(),
      status: data?.subscription_status ?? 'inactive',
      proExpiresAt: data?.pro_expires_at ?? null,
      paypalSubscriptionId: data?.paypal_subscription_id ?? null,
      paypalConfigured: hasPayPalConfig(),
      paypalClientId: paypalClientId || null,
      paypalMode
    });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to load billing status.' });
  }
});

app.post('/internal/billing/paypal/order', requireFirebaseAuth, async (req: AuthedRequest, res) => {
  if (!hasPayPalConfig()) {
    res.status(500).json({ error: 'PayPal credentials are missing on server.' });
    return;
  }

  try {
    const response = await paypalRequest('/v2/checkout/orders', {
      method: 'POST',
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [
          {
            description: 'PredictLeague Pro Monthly',
            amount: { currency_code: 'USD', value: paypalPlanPriceUsd.toFixed(2) }
          }
        ],
        application_context: {
          return_url: `${appBaseUrl}/?paypal=success`,
          cancel_url: `${appBaseUrl}/?paypal=cancel`,
          brand_name: 'PredictLeague',
          user_action: 'PAY_NOW'
        }
      })
    });
    const payload = (await response.json()) as {
      id?: string;
      links?: Array<{ rel?: string; href?: string }>;
      message?: string;
    };
    if (!response.ok || !payload.id) {
      throw new Error(payload.message ?? 'Failed to create PayPal order.');
    }
    const approveUrl = payload.links?.find((link) => link.rel === 'approve')?.href ?? '';
    res.status(200).json({ orderId: payload.id, approveUrl });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to create PayPal order.' });
  }
});

app.post('/internal/billing/paypal/capture', requireFirebaseAuth, async (req: AuthedRequest, res) => {
  const admin = requireSupabaseAdmin(res);
  if (!admin) return;
  if (!hasPayPalConfig()) {
    res.status(500).json({ error: 'PayPal credentials are missing on server.' });
    return;
  }

  const { orderId } = req.body as { orderId?: string };
  if (!orderId?.trim()) {
    res.status(400).json({ error: 'orderId is required.' });
    return;
  }

  try {
    const response = await paypalRequest(`/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {
      method: 'POST',
      body: JSON.stringify({})
    });
    const payload = (await response.json()) as { status?: string; message?: string };
    if (!response.ok || payload.status !== 'COMPLETED') {
      throw new Error(payload.message ?? 'PayPal capture did not complete.');
    }

    const userUid = req.auth?.uid ?? '';
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const { error } = await admin.from('user_profiles').upsert(
      {
        user_uid: userUid,
        email: req.auth?.email?.toLowerCase().trim() ?? '',
        subscription_tier: 'pro',
        subscription_status: 'active',
        paypal_subscription_id: orderId,
        pro_expires_at: expiresAt,
        updated_at: new Date().toISOString()
      },
      { onConflict: 'user_uid' }
    );
    if (error) throw new Error(error.message);

    res.status(200).json({ ok: true, tier: 'pro', status: 'active', proExpiresAt: expiresAt });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to capture PayPal order.' });
  }
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

    const apiKey = process.env.FOOTBALL_DATA_API_KEY;
    if (!apiKey) {
      res.status(500).json({ error: 'FOOTBALL_DATA_API_KEY is missing on the server.' });
      return;
    }

    const { data: group, error: groupError } = await admin
      .from('groups')
      .select('bonus_enabled')
      .eq('id', groupId)
      .single<{ bonus_enabled: boolean }>();
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
        const match = await fetchMatchById(apiKey, matchId);
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

  const { groupId, matchId, matchDate, htHome, htAway, ftHome, ftAway } = req.body as {
    groupId?: string;
    matchId?: number;
    matchDate?: string;
    htHome?: number;
    htAway?: number;
    ftHome?: number;
    ftAway?: number;
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
      .select('competition_id,prediction_lock_minutes')
      .eq('id', groupId)
      .single<{ competition_id: number; prediction_lock_minutes: number }>();
    if (groupError || !group) {
      throw new Error(groupError?.message ?? 'Group not found.');
    }

    const apiKey = process.env.FOOTBALL_DATA_API_KEY;
    if (!apiKey) {
      res.status(500).json({ error: 'FOOTBALL_DATA_API_KEY is missing on the server.' });
      return;
    }

    const matchResponse = await fetch(new URL(`/v4/matches/${matchId}`, apiBase), {
      headers: {
        'X-Auth-Token': apiKey,
        Accept: 'application/json'
      }
    });
    updateFootballApiUsage(matchResponse.headers);
    if (!matchResponse.ok) {
      res.status(502).json({ error: 'Failed to validate match before saving prediction.' });
      return;
    }

    const payload = (await matchResponse.json()) as {
      match?: { competition?: { id?: number }; status?: string; utcDate?: string };
      competition?: { id?: number };
      status?: string;
      utcDate?: string;
    };
    const matchData = payload.match ?? payload;
    const matchCompetitionId = matchData.competition?.id;
    const matchStatus = matchData.status ?? '';
    const kickoffAt = matchData.utcDate ? Date.parse(matchData.utcDate) : Number.NaN;

    if (matchCompetitionId !== group.competition_id) {
      res.status(400).json({ error: 'This match is not part of the group competition.' });
      return;
    }

    const lockMinutes = Math.max(0, Math.min(180, Number(group.prediction_lock_minutes ?? 0)));
    const lockAt = Number.isFinite(kickoffAt) ? kickoffAt - lockMinutes * 60_000 : Number.NaN;
    const isOpen =
      ['SCHEDULED', 'TIMED'].includes(matchStatus) && Number.isFinite(lockAt) && lockAt > Date.now();
    if (!isOpen) {
      res.status(423).json({ error: 'Predictions are locked for this match.' });
      return;
    }

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
        ft_away: ftAway
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

app.use('/api', async (req, res) => {
  const apiKey = process.env.FOOTBALL_DATA_API_KEY;

  if (!apiKey) {
    res.status(500).json({ error: 'FOOTBALL_DATA_API_KEY is missing on the server.' });
    return;
  }

  const upstreamPath = req.originalUrl.replace(/^\/api/, '');
  const upstreamUrl = new URL(upstreamPath, apiBase);

  try {
    const upstreamResponse = await fetch(upstreamUrl, {
      method: req.method,
      headers: {
        'X-Auth-Token': apiKey,
        Accept: 'application/json'
      }
    });
    updateFootballApiUsage(upstreamResponse.headers);

    const contentType = upstreamResponse.headers.get('content-type');
    if (contentType) {
      res.setHeader('content-type', contentType);
    }

    res.status(upstreamResponse.status).send(await upstreamResponse.text());
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Proxy request failed.';
    res.status(502).json({ error: message });
  }
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

app.listen(port, () => {
  // Keep this startup log simple for terminal-based deployment visibility.
  console.log(`PredictLeague server listening on http://localhost:${port}`);
});
