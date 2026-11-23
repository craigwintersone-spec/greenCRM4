-- Vorlana: the bid tracker. Every bid written in Find funding is saved here automatically;
-- it's marked "submitted" when it's downloaded or copied, and the person who wrote it is
-- emailed once, 8 weeks later, to tap "won" or "didn't win". Safe to run twice.
create table if not exists public.bids (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organisations(id) on delete cascade,
  funder        text not null,
  programme     text,
  project       text,
  amount        text,
  deadline      text,
  url           text,
  status        text not null default 'drafted' check (status in ('drafted', 'submitted', 'won', 'lost', 'withdrawn')),
  amount_won    numeric,
  created_by    uuid default auth.uid(),
  created_at    timestamptz not null default now(),
  submitted_at  timestamptz,
  decided_at    timestamptz,
  ask_sent_at   timestamptz
);
create index if not exists bids_org_idx on public.bids (org_id, created_at desc);
create index if not exists bids_ask_idx on public.bids (status, submitted_at) where ask_sent_at is null;

alter table public.bids enable row level security;

-- Members of the organisation (and its owner, and super admins) can see and update its bids
drop policy if exists bids_member_all on public.bids;
create policy bids_member_all on public.bids for all
  using (
    org_id in (select m.org_id from public.memberships m where m.user_id = auth.uid() and m.status = 'active')
    or org_id in (select o.id from public.organisations o where o.owner_id = auth.uid())
    or public.auth_is_super_admin()
  )
  with check (
    org_id in (select m.org_id from public.memberships m where m.user_id = auth.uid() and m.status = 'active')
    or org_id in (select o.id from public.organisations o where o.owner_id = auth.uid())
    or public.auth_is_super_admin()
  );
