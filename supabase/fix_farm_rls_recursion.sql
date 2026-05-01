-- Fix farm/member RLS recursion.
-- Run this once in the Supabase SQL editor if the app shows:
-- "infinite recursion detected in policy for relation \"farms\"".

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.role = 'admin'
  );
$$;

create or replace function public.is_farm_member(target_farm_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.farm_members fm
    where fm.farm_id = target_farm_id
      and fm.user_id = auth.uid()
  );
$$;

create or replace function public.can_manage_farm_members(target_farm_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.farms f
    where f.id = target_farm_id
      and f.owner_user_id = auth.uid()
  );
$$;

create or replace function public.can_read_farm(target_farm_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_admin()
    or exists (
      select 1
      from public.farms f
      where f.id = target_farm_id
        and f.owner_user_id = auth.uid()
    )
    or public.is_farm_member(target_farm_id);
$$;

create or replace function public.can_edit_farm(target_farm_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
      select 1
      from public.farms f
      where f.id = target_farm_id
        and f.owner_user_id = auth.uid()
    )
    or exists (
      select 1
      from public.farm_members fm
      where fm.farm_id = target_farm_id
        and fm.user_id = auth.uid()
        and fm.role in ('operator', 'manager', 'admin')
    );
$$;

drop policy if exists "farms select own/admin" on public.farms;
create policy "farms select own/admin"
on public.farms
for select
to authenticated
using (
  owner_user_id = auth.uid()
  or public.is_admin()
  or public.is_farm_member(id)
);

drop policy if exists "farm_members select own farm" on public.farm_members;
create policy "farm_members select own farm"
on public.farm_members for select to authenticated
using (
  user_id = auth.uid()
  or public.can_manage_farm_members(farm_id)
);

drop policy if exists "farm_members insert owner" on public.farm_members;
create policy "farm_members insert owner"
on public.farm_members for insert to authenticated
with check (
  public.can_manage_farm_members(farm_id)
);

drop policy if exists "farm_members update owner" on public.farm_members;
create policy "farm_members update owner"
on public.farm_members for update to authenticated
using (
  public.can_manage_farm_members(farm_id)
);

drop policy if exists "farm_members delete owner" on public.farm_members;
create policy "farm_members delete owner"
on public.farm_members for delete to authenticated
using (
  public.can_manage_farm_members(farm_id)
);
