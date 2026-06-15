create extension if not exists pgcrypto;

create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_uid text not null references public.user_profiles(user_uid) on delete cascade,
  token text not null unique,
  platform text not null default 'web',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_push_subscriptions_user_uid on public.push_subscriptions(user_uid);

create table if not exists public.match_reminder_deliveries (
  id uuid primary key default gen_random_uuid(),
  user_uid text not null references public.user_profiles(user_uid) on delete cascade,
  match_id integer not null,
  reminder_minutes integer not null,
  sent_at timestamptz not null default now(),
  unique (user_uid, match_id, reminder_minutes)
);

alter table public.user_profiles alter column reminder_minutes_before set default 20;

alter table public.push_subscriptions enable row level security;
alter table public.match_reminder_deliveries enable row level security;

drop policy if exists "push_subscriptions_block_select" on public.push_subscriptions;
drop policy if exists "push_subscriptions_block_insert" on public.push_subscriptions;
drop policy if exists "push_subscriptions_block_update" on public.push_subscriptions;
create policy "push_subscriptions_block_select" on public.push_subscriptions for select using (false);
create policy "push_subscriptions_block_insert" on public.push_subscriptions for insert with check (false);
create policy "push_subscriptions_block_update" on public.push_subscriptions for update using (false) with check (false);

drop policy if exists "match_reminder_deliveries_block_select" on public.match_reminder_deliveries;
drop policy if exists "match_reminder_deliveries_block_insert" on public.match_reminder_deliveries;
create policy "match_reminder_deliveries_block_select" on public.match_reminder_deliveries for select using (false);
create policy "match_reminder_deliveries_block_insert" on public.match_reminder_deliveries for insert with check (false);
