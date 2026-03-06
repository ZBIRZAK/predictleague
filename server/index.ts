import express from 'express';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import nodemailer from 'nodemailer';

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

let smtpLastVerifyAt: string | null = null;
let smtpLastVerifyError: string | null = null;

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

app.get('/internal/smtp-health', async (_, res) => {
  if (!smtpLastVerifyAt) {
    await verifySmtpConnection();
  }

  res.status(200).json({
    configured: Boolean(mailer && smtpFrom),
    smtpHost,
    smtpPort,
    smtpSecure,
    smtpUser,
    smtpFrom,
    lastVerifyAt: smtpLastVerifyAt,
    lastVerifyError: smtpLastVerifyError
  });
});

app.post('/internal/invite-email', async (req, res) => {
  const { toEmail, groupName, inviterEmail } = req.body as {
    toEmail?: string;
    groupName?: string;
    inviterEmail?: string;
  };

  if (!toEmail || !groupName) {
    res.status(400).json({ error: 'toEmail and groupName are required.' });
    return;
  }

  if (!mailer || !smtpFrom) {
    res.status(500).json({ error: 'SMTP is not configured on the server.' });
    return;
  }

  try {
    const result = await mailer.sendMail({
      from: smtpFrom,
      to: toEmail,
      subject: `You were invited to join "${groupName}" on PredictLeague`,
      text: `${inviterEmail ?? 'A friend'} invited you to join "${groupName}" on PredictLeague.\n\nSign in with this email in the app to join the group automatically.`,
      html: `<p>${inviterEmail ?? 'A friend'} invited you to join <strong>${groupName}</strong> on PredictLeague.</p><p>Sign in with this email in the app to join the group automatically.</p>`
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
