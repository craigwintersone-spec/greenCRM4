-- Vorlana: allow the new Starter plan ('group') if the plan column is restricted. Safe to run twice.
do $$
declare c record;
begin
  for c in
    select con.conname from pg_constraint con
    join pg_class t on t.oid = con.conrelid join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public' and t.relname = 'organisations' and con.contype = 'c'
      and pg_get_constraintdef(con.oid) ilike '%plan%'
  loop
    execute format('alter table public.organisations drop constraint %I', c.conname);
  end loop;
end $$;
alter table public.organisations add constraint organisations_plan_check
  check (plan is null or plan in ('free', 'group', 'starter', 'pro', 'network'));
