-- Vorlana: the AI back office — donations, budget lines and spend (js/extensions/ai-office.js).
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

alter table public.donations    enable row level security;
alter table public.budget_lines enable row level security;
alter table public.budget_spend enable row level security;

do $$
declare t text;
begin
  foreach t in array array['donations', 'budget_lines', 'budget_spend'] loop
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
