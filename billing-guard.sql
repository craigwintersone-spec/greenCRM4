-- Vorlana: only Vorlana itself (the server or a super admin) can change an organisation's plan, status, trial or payment details.
-- Owners can still save all their other settings as normal. Safe to run twice.
create or replace function public.vl_protect_org_billing()
returns trigger language plpgsql set search_path = public as $$
declare k text;
  protected text[] := array['self_serve','trial_ends','signed_up_by','stripe_customer','stripe_subscription','billing_interval',
                            'billing_status','cancel_at_period_end','subscription_ended_at','stripe_account','stripe_ready'];
begin
  -- the server (service role), the SQL editor (no signed-in user) and super admins may change anything
  if coalesce(auth.role(), '') in ('', 'service_role') or public.auth_is_super_admin() then
    return new;
  end if;
  new.plan := old.plan;
  new.status := old.status;
  new.owner_id := old.owner_id;
  new.settings := coalesce(new.settings, '{}'::jsonb);
  foreach k in array protected loop
    if old.settings ? k then new.settings := jsonb_set(new.settings, array[k], old.settings -> k, true);
    else new.settings := new.settings - k; end if;
  end loop;
  return new;
end $$;

drop trigger if exists vl_protect_org_billing on public.organisations;
create trigger vl_protect_org_billing before update on public.organisations
  for each row execute function public.vl_protect_org_billing();
