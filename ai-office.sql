-- Vorlana: the AI back office — donations (and the accounts they sync from), budget lines and spend (js/extensions/ai-office.js, api/donations.js).
-- Same access rules as the bid tracker: members of the organisation, its owner, and super admins. Safe to run twice.

create table if not exists public.donations (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organisations(id) on delete cascade,
  donor_name   text not null,
  donor_email  text,
  amount       numeric not null check (amount >= 0),
  gift_date    date not null default current_date,
  method       text,
  gift_aid     boolean not null default false,
  fund         text,                       -- empty = unrestricted
  restricted   boolean not null default false,
  thanked_at   timestamptz,
  notes        text,
  created_by   uuid default auth.uid(),
  created_at   timestamptz not null default now()
);
create index if not exists donations_org_idx on public.donations (org_id, gift_date desc);

-- where a gift came from (manual, csv, justgiving, stripe, paypal) and its id there, so the same gift is never saved twice
alter table public.donations add column if not exists source      text not null default 'manual';
alter table public.donations add column if not exists external_id text;
create unique index if not exists donations_ext_uidx on public.donations (org_id, source, external_id);

-- connected donation accounts (JustGiving, Stripe, PayPal). Holds read-only login details, so row-level security
-- is on with NO policies: only the server (service role, /api/donations) can read or write it, never the browser.
create table if not exists public.donation_links (
  org_id        uuid not null references public.organisations(id) on delete cascade,
  provider      text not null check (provider in ('justgiving', 'stripe', 'paypal')),
  config        jsonb not null default '{}'::jsonb,
  last_sync_at  timestamptz,
  last_error    text,
  last_count    integer default 0,
  created_by    uuid,
  created_at    timestamptz not null default now(),
  primary key (org_id, provider)
);
alter table public.donation_links enable row level security;

create table if not exists public.budget_lines (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organisations(id) on delete cascade,
  contract_id  text not null,
  name         text not null,
  amount       numeric not null default 0 check (amount >= 0),
  created_at   timestamptz not null default now()
);
create index if not exists budget_lines_org_idx on public.budget_lines (org_id, contract_id);

create table if not exists public.budget_spend (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organisations(id) on delete cascade,
  line_id      uuid not null references public.budget_lines(id) on delete cascade,
  spend_date   date not null default current_date,
  amount       numeric not null check (amount >= 0),
  note         text,
  created_by   uuid default auth.uid(),
  created_at   timestamptz not null default now()
);
create index if not exists budget_spend_org_idx on public.budget_spend (org_id, spend_date desc);

-- spend that arrives by itself: fixed costs posted monthly, and bank statement payments sorted by remembered payees
alter table public.budget_spend alter column line_id drop not null;            -- a bank payment waits here until it is sorted
alter table public.budget_spend add column if not exists source      text not null default 'manual';   -- manual, fixed, bank
alter table public.budget_spend add column if not exists external_id text;
alter table public.budget_spend add column if not exists description text;
alter table public.budget_spend add column if not exists ignored     boolean not null default false;   -- "not a project cost"
create unique index if not exists budget_spend_ext_uidx on public.budget_spend (org_id, source, external_id);

create table if not exists public.budget_recurring (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organisations(id) on delete cascade,
  line_id      uuid not null references public.budget_lines(id) on delete cascade,
  amount       numeric not null check (amount >= 0),
  start_date   date not null default current_date,
  end_date     date,
  note         text,
  created_at   timestamptz not null default now()
);
create table if not exists public.spend_rules (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organisations(id) on delete cascade,
  match        text not null,                                                   -- the payee, tidied ("screwfix direct")
  line_id      uuid references public.budget_lines(id) on delete cascade,       -- empty = not a project cost
  created_at   timestamptz not null default now(),
  unique (org_id, match)
);

-- Gift Aid claims (HMRC schedule) and thank-yous sent from Vorlana
alter table public.donations add column if not exists donor_house          text;
alter table public.donations add column if not exists donor_postcode       text;
alter table public.donations add column if not exists gift_aid_claimed_at  timestamptz;
alter table public.donations add column if not exists thanks_sent_at       timestamptz;

-- key dates: insurance, annual return, policy reviews, DBS renewals (shown on the funding calendar and the morning checks)
create table if not exists public.key_dates (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references public.organisations(id) on delete cascade,
  title          text not null,
  due_date       date not null,
  repeat_months  integer,                      -- 12 = every year; empty = once
  done_at        timestamptz,
  created_at     timestamptz not null default now()
);

-- company partners: what a charity offers companies (team days, things to fund), and the enquiries that come in.
-- The public page reads open offers through /api/office (service role); enquiries are written the same way.
create table if not exists public.company_offers (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organisations(id) on delete cascade,
  kind         text not null default 'team_day' check (kind in ('team_day', 'fund')),
  title        text not null,
  description  text,
  offer_date   date,
  places       integer,
  amount       numeric,
  area         text,
  cause        text,
  open         boolean not null default true,
  created_at   timestamptz not null default now()
);
create table if not exists public.company_enquiries (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organisations(id) on delete cascade,
  offer_id     uuid references public.company_offers(id) on delete set null,
  company      text not null,
  contact_name text,
  email        text not null,
  phone        text,
  people       integer,
  message      text,
  status       text not null default 'new',
  created_at   timestamptz not null default now()
);

-- after a company's team day: what happened, and the impact report sent to them
alter table public.company_enquiries add column if not exists day_date       date;
alter table public.company_enquiries add column if not exists day_people     integer;
alter table public.company_enquiries add column if not exists day_hours      numeric;
alter table public.company_enquiries add column if not exists report_text    text;
alter table public.company_enquiries add column if not exists report_sent_at timestamptz;

alter table public.donations    enable row level security;
alter table public.key_dates         enable row level security;
alter table public.company_offers    enable row level security;
alter table public.company_enquiries enable row level security;
alter table public.budget_recurring enable row level security;
alter table public.spend_rules      enable row level security;
alter table public.budget_lines enable row level security;
alter table public.budget_spend enable row level security;

do $$
declare t text;
begin
  foreach t in array array['donations', 'budget_lines', 'budget_spend', 'budget_recurring', 'spend_rules', 'key_dates', 'company_offers', 'company_enquiries'] loop
    execute format('drop policy if exists %I on public.%I', t || '_member_all', t);
    execute format($p$create policy %I on public.%I for all
      using (
        org_id in (select m.org_id from public.memberships m where m.user_id = auth.uid() and m.status = 'active')
        or org_id in (select o.id from public.organisations o where o.owner_id = auth.uid())
        or public.auth_is_super_admin()
      )
      with check (
        org_id in (select m.org_id from public.memberships m where m.user_id = auth.uid() and m.status = 'active')
        or org_id in (select o.id from public.organisations o where o.owner_id = auth.uid())
        or public.auth_is_super_admin()
      )$p$, t || '_member_all', t);
  end loop;
end $$;
