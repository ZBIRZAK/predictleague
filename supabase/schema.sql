-- Enable extension for UUID generation
create extension if not exists pgcrypto;

create table if not exists public.groups (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  competition_id integer not null,
  competition_name text not null,
  owner_uid text not null,
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
  ht_home integer not null check (ht_home >= 0),
  ht_away integer not null check (ht_away >= 0),
  ft_home integer not null check (ft_home >= 0),
  ft_away integer not null check (ft_away >= 0),
  created_at timestamptz not null default now(),
  unique (group_id, match_id, user_uid)
);

create index if not exists idx_predictions_lookup on public.predictions(group_id, user_uid, match_date);

alter table public.groups enable row level security;
alter table public.group_members enable row level security;
alter table public.group_invites enable row level security;
alter table public.predictions enable row level security;

-- Firebase-auth + Supabase anon key MVP policies.
-- For production hardening, move writes/reads behind your backend and use service role.

drop policy if exists "groups_mvp_select" on public.groups;
drop policy if exists "groups_mvp_insert" on public.groups;
create policy "groups_mvp_select" on public.groups for select using (true);
create policy "groups_mvp_insert" on public.groups for insert with check (true);

drop policy if exists "group_members_mvp_select" on public.group_members;
drop policy if exists "group_members_mvp_insert" on public.group_members;
create policy "group_members_mvp_select" on public.group_members for select using (true);
create policy "group_members_mvp_insert" on public.group_members for insert with check (true);

drop policy if exists "invites_mvp_select" on public.group_invites;
drop policy if exists "invites_mvp_insert" on public.group_invites;
drop policy if exists "invites_mvp_update" on public.group_invites;
create policy "invites_mvp_select" on public.group_invites for select using (true);
create policy "invites_mvp_insert" on public.group_invites for insert with check (true);
create policy "invites_mvp_update" on public.group_invites for update using (true) with check (true);

drop policy if exists "predictions_mvp_select" on public.predictions;
drop policy if exists "predictions_mvp_insert" on public.predictions;
drop policy if exists "predictions_mvp_update" on public.predictions;
create policy "predictions_mvp_select" on public.predictions for select using (true);
create policy "predictions_mvp_insert" on public.predictions for insert with check (true);
create policy "predictions_mvp_update" on public.predictions for update using (true) with check (true);
