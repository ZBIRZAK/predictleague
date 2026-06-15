-- Run supabase/push-notifications.sql first.
-- Replace both placeholder values before running this file.

create extension if not exists pg_cron;
create extension if not exists pg_net;

select vault.create_secret(
  'https://www.predileague.com',
  'push_reminder_base_url'
);

select vault.create_secret(
  'REPLACE_WITH_THE_SAME_CRON_SECRET_USED_IN_VERCEL',
  'push_reminder_cron_secret'
);

select cron.schedule(
  'send-match-push-reminders',
  '* * * * *',
  $$
  select net.http_post(
    url := (
      select decrypted_secret
      from vault.decrypted_secrets
      where name = 'push_reminder_base_url'
      limit 1
    ) || '/internal/cron/push-reminders',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (
        select decrypted_secret
        from vault.decrypted_secrets
        where name = 'push_reminder_cron_secret'
        limit 1
      )
    ),
    body := jsonb_build_object('scheduled_at', now())
  );
  $$
);
