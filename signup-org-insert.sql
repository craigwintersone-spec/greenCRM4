-- Vorlana: let the sign-up server (service role) and the SQL editor create organisations.
-- Signed-in people work exactly as before: they must be signed in, and they become the owner.
create or replace function public.require_auth_for_org_insert()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if coalesce(auth.role(), '') in ('', 'service_role') and auth.uid() is null then
    return new;   -- the server or the SQL editor: keep the owner_id it set
  end if;
  if auth.uid() is null then
    raise exception 'You must be signed in to create an organisation';
  end if;
  new.owner_id := auth.uid();
  return new;
end $$;
