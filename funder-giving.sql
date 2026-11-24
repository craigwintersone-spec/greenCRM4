-- Vorlana: a week-long cache of funders' giving history (360Giving open data), so Find funding stays quick
-- and 360Giving isn't asked the same thing twice. Only the server reads and writes it. Safe to run twice.
create table if not exists public.funder_giving (
  key        text primary key,
  org_id     text not null,
  name       text,
  grants     jsonb,
  updated_at timestamptz not null default now()
);
alter table public.funder_giving enable row level security;   -- no policies: only the server (service role) can use it
