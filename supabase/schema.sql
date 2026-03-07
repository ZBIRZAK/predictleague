-- Enable extension for UUID generation
create extension if not exists pgcrypto;

create table if not exists public.groups (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  competition_id integer not null,
  competition_name text not null,
  owner_uid text not null,
  prediction_lock_minutes integer not null default 5 check (prediction_lock_minutes >= 0 and prediction_lock_minutes <= 180),
  bonus_enabled boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.group_members (
  group_id uuid not null references public.groups(id) on delete cascade,
  user_uid text not null,
  email text not null,
  role text not null default 'member',
  created_at timestamptz not null default now(),
  primary key (group_id, user_uid)
);

create index if not exists idx_group_members_user_uid on public.group_members(user_uid);

create table if not exists public.group_invites (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade,
  invited_by_uid text not null,
  email text not null,
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  unique (group_id, email)
);

create index if not exists idx_group_invites_email on public.group_invites(email);

create table if not exists public.predictions (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade,
  match_id integer not null,
  user_uid text not null,
  match_date date not null,
  match_kickoff_at timestamptz not null,
  lock_at timestamptz not null,
  ht_home integer not null check (ht_home >= 0),
  ht_away integer not null check (ht_away >= 0),
  ft_home integer not null check (ft_home >= 0),
  ft_away integer not null check (ft_away >= 0),
  created_at timestamptz not null default now(),
  unique (group_id, match_id, user_uid)
);

create index if not exists idx_predictions_lookup on public.predictions(group_id, user_uid, match_date);

create table if not exists public.group_match_bonus (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade,
  match_id integer not null,
  label text not null default 'custom',
  multiplier numeric(5,2) not null default 1.00 check (multiplier >= 1 and multiplier <= 5),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (group_id, match_id)
);

create index if not exists idx_group_match_bonus_group on public.group_match_bonus(group_id, active);

create table if not exists public.prediction_points_snapshots (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade,
  match_id integer not null,
  user_uid text not null,
  match_date date not null,
  winner_points integer not null default 0,
  ht_points integer not null default 0,
  ft_points integer not null default 0,
  bonus_points integer not null default 0,
  total_points integer not null default 0,
  result_ht_home integer,
  result_ht_away integer,
  result_ft_home integer,
  result_ft_away integer,
  result_winner text,
  computed_at timestamptz not null default now(),
  unique (group_id, match_id, user_uid)
);

create index if not exists idx_prediction_points_group_date on public.prediction_points_snapshots(group_id, match_date);

create table if not exists public.user_profiles (
  user_uid text primary key,
  email text not null,
  first_name text,
  last_name text,
  display_name text,
  country text,
  favorite_team text,
  bio text,
  reminders_enabled boolean not null default true,
  reminder_minutes_before integer not null default 30 check (reminder_minutes_before >= 5 and reminder_minutes_before <= 180),
  weekly_summary_enabled boolean not null default true,
  take_break_until timestamptz,
  subscription_tier text not null default 'free' check (subscription_tier in ('free', 'pro')),
  subscription_status text not null default 'inactive',
  paypal_subscription_id text,
  pro_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Compatibility upgrades for existing databases:
-- "create table if not exists" does not add new columns to already-created tables.
alter table public.groups add column if not exists prediction_lock_minutes integer;
alter table public.groups add column if not exists bonus_enabled boolean;
update public.groups set prediction_lock_minutes = 5 where prediction_lock_minutes is null;
update public.groups set bonus_enabled = false where bonus_enabled is null;
alter table public.groups alter column prediction_lock_minutes set default 5;
alter table public.groups alter column bonus_enabled set default false;
alter table public.groups alter column prediction_lock_minutes set not null;
alter table public.groups alter column bonus_enabled set not null;

alter table public.predictions add column if not exists match_kickoff_at timestamptz;
alter table public.predictions add column if not exists lock_at timestamptz;
update public.predictions set match_kickoff_at = created_at where match_kickoff_at is null;
update public.predictions set lock_at = match_kickoff_at where lock_at is null;
alter table public.predictions alter column match_kickoff_at set not null;
alter table public.predictions alter column lock_at set not null;

alter table public.user_profiles add column if not exists reminders_enabled boolean;
alter table public.user_profiles add column if not exists reminder_minutes_before integer;
alter table public.user_profiles add column if not exists weekly_summary_enabled boolean;
alter table public.user_profiles add column if not exists take_break_until timestamptz;
alter table public.user_profiles add column if not exists subscription_tier text;
alter table public.user_profiles add column if not exists subscription_status text;
alter table public.user_profiles add column if not exists paypal_subscription_id text;
alter table public.user_profiles add column if not exists pro_expires_at timestamptz;
update public.user_profiles set reminders_enabled = true where reminders_enabled is null;
update public.user_profiles set reminder_minutes_before = 30 where reminder_minutes_before is null;
update public.user_profiles set weekly_summary_enabled = true where weekly_summary_enabled is null;
update public.user_profiles set subscription_tier = 'free' where subscription_tier is null;
update public.user_profiles set subscription_status = 'inactive' where subscription_status is null;
alter table public.user_profiles alter column reminders_enabled set default true;
alter table public.user_profiles alter column reminder_minutes_before set default 30;
alter table public.user_profiles alter column weekly_summary_enabled set default true;
alter table public.user_profiles alter column subscription_tier set default 'free';
alter table public.user_profiles alter column subscription_status set default 'inactive';
alter table public.user_profiles alter column reminders_enabled set not null;
alter table public.user_profiles alter column reminder_minutes_before set not null;
alter table public.user_profiles alter column weekly_summary_enabled set not null;
alter table public.user_profiles alter column subscription_tier set not null;
alter table public.user_profiles alter column subscription_status set not null;

alter table public.groups enable row level security;
alter table public.group_members enable row level security;
alter table public.group_invites enable row level security;
alter table public.predictions enable row level security;
alter table public.user_profiles enable row level security;
alter table public.group_match_bonus enable row level security;
alter table public.prediction_points_snapshots enable row level security;

create or replace function public.block_locked_prediction_updates()
returns trigger
language plpgsql
as $$
begin
  if now() >= old.lock_at then
    raise exception 'Prediction is locked for this match.';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_block_locked_prediction_updates on public.predictions;
create trigger trg_block_locked_prediction_updates
before update on public.predictions
for each row
execute function public.block_locked_prediction_updates();

-- Secure default policies:
-- Block direct anon-key reads/writes from client. Use backend + service role.

drop policy if exists "groups_mvp_select" on public.groups;
drop policy if exists "groups_mvp_insert" on public.groups;
drop policy if exists "groups_block_select" on public.groups;
drop policy if exists "groups_block_insert" on public.groups;
drop policy if exists "groups_block_update" on public.groups;
create policy "groups_block_select" on public.groups for select using (false);
create policy "groups_block_insert" on public.groups for insert with check (false);
create policy "groups_block_update" on public.groups for update using (false) with check (false);

drop policy if exists "group_members_mvp_select" on public.group_members;
drop policy if exists "group_members_mvp_insert" on public.group_members;
drop policy if exists "group_members_block_select" on public.group_members;
drop policy if exists "group_members_block_insert" on public.group_members;
drop policy if exists "group_members_block_update" on public.group_members;
create policy "group_members_block_select" on public.group_members for select using (false);
create policy "group_members_block_insert" on public.group_members for insert with check (false);
create policy "group_members_block_update" on public.group_members for update using (false) with check (false);

drop policy if exists "invites_mvp_select" on public.group_invites;
drop policy if exists "invites_mvp_insert" on public.group_invites;
drop policy if exists "invites_mvp_update" on public.group_invites;
drop policy if exists "invites_block_select" on public.group_invites;
drop policy if exists "invites_block_insert" on public.group_invites;
drop policy if exists "invites_block_update" on public.group_invites;
create policy "invites_block_select" on public.group_invites for select using (false);
create policy "invites_block_insert" on public.group_invites for insert with check (false);
create policy "invites_block_update" on public.group_invites for update using (false) with check (false);

drop policy if exists "predictions_mvp_select" on public.predictions;
drop policy if exists "predictions_mvp_insert" on public.predictions;
drop policy if exists "predictions_mvp_update" on public.predictions;
drop policy if exists "predictions_block_select" on public.predictions;
drop policy if exists "predictions_block_insert" on public.predictions;
drop policy if exists "predictions_block_update" on public.predictions;
create policy "predictions_block_select" on public.predictions for select using (false);
create policy "predictions_block_insert" on public.predictions for insert with check (false);
create policy "predictions_block_update" on public.predictions for update using (false) with check (false);

drop policy if exists "profiles_mvp_select" on public.user_profiles;
drop policy if exists "profiles_mvp_insert" on public.user_profiles;
drop policy if exists "profiles_mvp_update" on public.user_profiles;
drop policy if exists "profiles_block_select" on public.user_profiles;
drop policy if exists "profiles_block_insert" on public.user_profiles;
drop policy if exists "profiles_block_update" on public.user_profiles;
create policy "profiles_block_select" on public.user_profiles for select using (false);
create policy "profiles_block_insert" on public.user_profiles for insert with check (false);
create policy "profiles_block_update" on public.user_profiles for update using (false) with check (false);

drop policy if exists "group_match_bonus_block_select" on public.group_match_bonus;
drop policy if exists "group_match_bonus_block_insert" on public.group_match_bonus;
drop policy if exists "group_match_bonus_block_update" on public.group_match_bonus;
create policy "group_match_bonus_block_select" on public.group_match_bonus for select using (false);
create policy "group_match_bonus_block_insert" on public.group_match_bonus for insert with check (false);
create policy "group_match_bonus_block_update" on public.group_match_bonus for update using (false) with check (false);

drop policy if exists "prediction_points_snapshots_block_select" on public.prediction_points_snapshots;
drop policy if exists "prediction_points_snapshots_block_insert" on public.prediction_points_snapshots;
drop policy if exists "prediction_points_snapshots_block_update" on public.prediction_points_snapshots;
create policy "prediction_points_snapshots_block_select" on public.prediction_points_snapshots for select using (false);
create policy "prediction_points_snapshots_block_insert" on public.prediction_points_snapshots for insert with check (false);
create policy "prediction_points_snapshots_block_update" on public.prediction_points_snapshots for update using (false) with check (false);
