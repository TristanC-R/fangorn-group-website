-- Fangorn Website: enquiries + accounts (admins/users) + storage references
-- Run this in Supabase SQL editor for your project.

create extension if not exists vector;

-- 1) Profiles (role-based access)
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  role text not null default 'user' check (role in ('user', 'admin')),
  created_at timestamptz not null default now()
);

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
      select 1 from public.farms f
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
      select 1 from public.farms f
      where f.id = target_farm_id
        and f.owner_user_id = auth.uid()
    )
    or exists (
      select 1 from public.farm_members fm
      where fm.farm_id = target_farm_id
        and fm.user_id = auth.uid()
        and fm.role in ('operator', 'manager', 'admin')
    );
$$;

alter table public.profiles enable row level security;

drop policy if exists "profiles read own/admin" on public.profiles;
create policy "profiles read own/admin"
on public.profiles
for select
to authenticated
using (auth.uid() = id or public.is_admin());

drop policy if exists "profiles update own" on public.profiles;
create policy "profiles update own"
on public.profiles
for update
to authenticated
using (auth.uid() = id)
with check (auth.uid() = id);

-- Create a profile row automatically when a user signs up.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, role)
  values (new.id, 'user')
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute procedure public.handle_new_user();

-- 2) Enquiries
create table if not exists public.enquiries (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  user_id uuid null references auth.users (id) on delete set null,

  name text not null,
  email text not null,
  company text null,
  phone text null,
  message text not null,

  status text not null default 'new' check (status in ('new', 'triaged', 'in_progress', 'closed'))
);

alter table public.enquiries enable row level security;

-- Anyone (anon or authed) can submit an enquiry.
drop policy if exists "enquiries insert anyone" on public.enquiries;
create policy "enquiries insert anyone"
on public.enquiries
for insert
to anon, authenticated
with check (true);

-- Only admins (or the logged-in owner) can read enquiries.
drop policy if exists "enquiries select admin/owner" on public.enquiries;
create policy "enquiries select admin/owner"
on public.enquiries
for select
to authenticated
using (public.is_admin() or user_id = auth.uid());

-- Only admins can update status.
drop policy if exists "enquiries update admin" on public.enquiries;
create policy "enquiries update admin"
on public.enquiries
for update
to authenticated
using (public.is_admin())
with check (public.is_admin());

-- 3) Enquiry files (references to Storage objects)
create table if not exists public.enquiry_files (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  enquiry_id uuid not null references public.enquiries (id) on delete cascade,

  bucket text not null,
  path text not null,
  filename text not null,
  content_type text null,
  size_bytes bigint null
);

create index if not exists enquiry_files_enquiry_id_idx
on public.enquiry_files (enquiry_id);

alter table public.enquiry_files enable row level security;

-- Anyone can create file references for their submitted enquiry.
drop policy if exists "enquiry_files insert anyone" on public.enquiry_files;
create policy "enquiry_files insert anyone"
on public.enquiry_files
for insert
to anon, authenticated
with check (true);

-- Admins or owners can read.
drop policy if exists "enquiry_files select admin/owner" on public.enquiry_files;
create policy "enquiry_files select admin/owner"
on public.enquiry_files
for select
to authenticated
using (
  public.is_admin()
  or exists (
    select 1 from public.enquiries e
    where e.id = enquiry_id
      and e.user_id = auth.uid()
  )
);

-- 3a) Tilth — farms (one owner per farm row for now)
create table if not exists public.farms (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  owner_user_id uuid not null references auth.users (id) on delete cascade,

  name text not null,
  address_line1 text not null,
  address_line2 text null,
  city text null,
  region text null,
  postcode text null,
  country text null
);

create index if not exists farms_owner_user_id_idx
on public.farms (owner_user_id);

alter table public.farms enable row level security;

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

drop policy if exists "farms insert own" on public.farms;
create policy "farms insert own"
on public.farms
for insert
to authenticated
with check (owner_user_id = auth.uid());

drop policy if exists "farms update own" on public.farms;
create policy "farms update own"
on public.farms
for update
to authenticated
using (owner_user_id = auth.uid())
with check (owner_user_id = auth.uid());

-- 3a2) Tilth — fields (boundary = closed ring of { lat, lng } in WGS84 for 2D map; optional survey object key)
create table if not exists public.tilth_fields (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  farm_id uuid not null references public.farms (id) on delete cascade,

  name text not null,
  boundary jsonb not null default '[]'::jsonb
    check (jsonb_typeof(boundary) = 'array'),

  survey_storage_bucket text null,
  survey_storage_key text null
);

create index if not exists tilth_fields_farm_id_idx
on public.tilth_fields (farm_id);

alter table public.tilth_fields enable row level security;

drop policy if exists "tilth_fields select farm owner/admin" on public.tilth_fields;
create policy "tilth_fields select farm owner/admin"
on public.tilth_fields
for select
to authenticated
using (public.can_read_farm(farm_id));

drop policy if exists "tilth_fields insert farm owner" on public.tilth_fields;
create policy "tilth_fields insert farm owner"
on public.tilth_fields
for insert
to authenticated
with check (public.can_edit_farm(farm_id));

drop policy if exists "tilth_fields update farm owner" on public.tilth_fields;
create policy "tilth_fields update farm owner"
on public.tilth_fields
for update
to authenticated
using (public.can_edit_farm(farm_id))
with check (public.can_edit_farm(farm_id));

drop policy if exists "tilth_fields delete farm owner" on public.tilth_fields;
create policy "tilth_fields delete farm owner"
on public.tilth_fields
for delete
to authenticated
using (public.can_edit_farm(farm_id));

-- 3a3) Tilth — per-field × per-layer extracted data
-- Each row is the pre-extracted vector representation of one map layer's data
-- clipped to one field's polygon. Vector layers (Defra/EA WFS) yield real
-- attributed features; BGS / UKSO raster layers are render+traced server-side
-- into vector polygons (one per colour class) by the Tilth API extractor.
-- The frontend never re-fetches the upstream — it reads this row, renders the
-- features, and that's the entire overlay pipeline.
create table if not exists public.tilth_field_layer_data (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  field_id uuid not null references public.tilth_fields (id) on delete cascade,
  layer_id text not null,

  -- Strategy used to produce this row. Useful for debugging + UI hints.
  -- 'wfs': real upstream vectors (Defra/EA/Natural England/Coal Authority).
  -- 'arcgis_trace': BGS/UKSO render+trace from a rendered PNG.
  -- 'unsupported': layer kind we can't extract (e.g. xyz basemaps).
  strategy text not null check (strategy in ('wfs', 'arcgis_trace', 'unsupported')),

  -- GeoJSON FeatureCollection in EPSG:4326. Each feature carries:
  --   - geometry: Polygon | MultiPolygon | LineString | Point
  --   - properties: { class?, label?, color?, ...upstream attributes }
  features jsonb null,

  -- Bounding box of the source extraction, EPSG:3857 [minx, miny, maxx, maxy].
  -- Cheap pre-filter for the frontend to skip features visibly off-screen.
  bbox jsonb null,

  -- Stamp of the upstream config (URL + key params) at extraction time —
  -- if the layer manifest changes (new sublayer / mapScale / etc.) we
  -- re-extract automatically by comparing this string.
  upstream_version text null,

  -- Status / errors for the UI extraction-progress indicator.
  status text not null default 'pending'
    check (status in ('pending', 'ok', 'partial', 'error')),
  error_message text null,
  feature_count integer null,

  unique (field_id, layer_id)
);

create index if not exists tilth_field_layer_data_field_id_idx
on public.tilth_field_layer_data (field_id);

create index if not exists tilth_field_layer_data_status_idx
on public.tilth_field_layer_data (field_id, status);

alter table public.tilth_field_layer_data enable row level security;

-- Read access: the field's farm owner OR an admin.
drop policy if exists "tilth_field_layer_data select farm owner/admin"
  on public.tilth_field_layer_data;
create policy "tilth_field_layer_data select farm owner/admin"
on public.tilth_field_layer_data
for select
to authenticated
using (
  exists (
    select 1
    from public.tilth_fields tf
    join public.farms f on f.id = tf.farm_id
    where tf.id = tilth_field_layer_data.field_id
      and (f.owner_user_id = auth.uid() or public.is_admin())
  )
);

-- Writes are service-role only (the Tilth API extractor uses the
-- SUPABASE_SERVICE_ROLE_KEY which bypasses RLS). We deliberately don't grant
-- INSERT/UPDATE/DELETE to authenticated users — extracted data is derived,
-- not user-authored, and editing it from the browser would corrupt overlays.

-- Realtime: opt this table into Supabase Realtime so the frontend can react
-- to extractor progress without polling. (No-op if the publication already
-- includes it; safe to re-run.)
do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'tilth_field_layer_data'
  ) then
    alter publication supabase_realtime add table public.tilth_field_layer_data;
  end if;
end $$;

-- 3a4) Tilth — per-field Sentinel-2 NDVI scenes
-- One row per (field, Sentinel-2 scene) caches the per-field statistics
-- computed from Microsoft Planetary Computer (MPC) by the Tilth API. The
-- workspace reads straight from this table, so the browser never has to
-- talk to MPC, parse a STAC catalog, or run a titiler request itself.
--
-- The same item_id can be referenced by multiple fields (one S2 tile
-- typically covers thousands of UK farms), but we still store one row
-- per (field_id, item_id) so the per-field NDVI mean / valid-pixel count
-- can be queried by a single index.
create table if not exists public.tilth_field_ndvi (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  field_id uuid not null references public.tilth_fields (id) on delete cascade,

  -- STAC item identifier from MPC's `sentinel-2-l2a` collection. Looks
  -- like 'S2A_MSIL2A_20240612T110621_R094_T30UWE_20240612T143829'.
  item_id text not null,
  collection text not null default 'sentinel-2-l2a',

  -- Scene acquisition time (UTC). Used as the time axis for the workspace.
  scene_datetime timestamptz not null,
  -- ISO week of the year (1-53) the scene falls into. Pre-computed so the
  -- workspace can group/scrub by week without a date-fns dep.
  scene_week smallint not null,
  scene_year smallint not null,

  -- MPC-reported scene-wide cloud cover (0-100). The ingest filters out
  -- scenes with eo:cloud_cover > Sentinel-2 lookback threshold before
  -- computing per-field stats, but we still keep the original number for UX.
  scene_cloud_pct real null,

  -- Per-field NDVI statistics computed by titiler /statistics
  -- (B08 - B04) / (B08 + B04), with SCL cloud/shadow pixels masked out.
  ndvi_mean real null,
  ndvi_min real null,
  ndvi_max real null,
  ndvi_stddev real null,
  ndvi_median real null,
  -- Number of valid (non-masked) 10m pixels inside the field polygon.
  -- A scene with valid_pixel_count == 0 means the field was entirely
  -- under cloud / shadow / saturated and the row is informational only.
  valid_pixel_count integer null,
  total_pixel_count integer null,

  -- Optional per-field cloud cover from SCL (clouds + shadow + cirrus / total).
  field_cloud_pct real null,

  status text not null default 'ok'
    check (status in ('pending', 'ok', 'no-data', 'error')),
  error_message text null,

  unique (field_id, item_id)
);

create index if not exists tilth_field_ndvi_field_id_idx
on public.tilth_field_ndvi (field_id);

create index if not exists tilth_field_ndvi_field_datetime_idx
on public.tilth_field_ndvi (field_id, scene_datetime desc);

alter table public.tilth_field_ndvi enable row level security;

drop policy if exists "tilth_field_ndvi select farm owner/admin"
  on public.tilth_field_ndvi;
create policy "tilth_field_ndvi select farm owner/admin"
on public.tilth_field_ndvi
for select
to authenticated
using (
  exists (
    select 1
    from public.tilth_fields tf
    join public.farms f on f.id = tf.farm_id
    where tf.id = tilth_field_ndvi.field_id
      and (f.owner_user_id = auth.uid() or public.is_admin())
  )
);

-- Writes are service-role only (the Tilth API ingest path uses the
-- SUPABASE_SERVICE_ROLE_KEY). Same rationale as tilth_field_layer_data.

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'tilth_field_ndvi'
  ) then
    alter publication supabase_realtime add table public.tilth_field_ndvi;
  end if;
end $$;

-- 3a-bis) Per-field Sentinel-1 SAR statistics
--
-- Cloud-piercing radar backscatter from MPC's `sentinel-1-rtc` collection.
-- One row per (field_id, item_id) — same shape as tilth_field_ndvi but
-- carrying VV / VH polarisation stats instead of NDVI. Backscatter is
-- stored in **linear power** (the source of truth from titiler), with
-- decibel mirrors for the values most often used in agronomy. The
-- VH/VV ratio is also persisted because it's a strong vegetation
-- structure signal independent of soil moisture.
--
-- SAR has no cloud cover concept — every scene is usable — but orbit
-- direction matters: ascending (evening pass, ~6pm UTC) and descending
-- (morning, ~6am UTC) scenes have different incidence geometries, so
-- comparing time series within a single orbit_state is more robust.
-- relative_orbit identifies the specific orbit track inside that.
create table if not exists public.tilth_field_sar (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  field_id uuid not null references public.tilth_fields (id) on delete cascade,

  item_id text not null,
  collection text not null default 'sentinel-1-rtc',

  scene_datetime timestamptz not null,
  scene_week smallint not null,
  scene_year smallint not null,

  -- Sentinel-1 sar:orbit_state ('ascending' | 'descending') and
  -- sat:relative_orbit. Both are stored verbatim; useful for grouping
  -- scenes that share an incidence geometry.
  orbit_state text null,
  relative_orbit smallint null,

  -- VV polarisation (vertical send / vertical receive). Surface
  -- roughness + dielectric (wet/dry).
  vv_mean real null,
  vv_mean_db real null,
  vv_median real null,
  vv_stddev real null,

  -- VH polarisation (vertical send / horizontal receive — cross-pol).
  -- Vegetation volume / canopy structure.
  vh_mean real null,
  vh_mean_db real null,
  vh_median real null,
  vh_stddev real null,

  -- Mean of VH/VV ratios (linear and dB). Strong proxy for vegetation
  -- vs bare/wet surfaces independent of total backscatter intensity.
  vh_vv_ratio_mean real null,
  vh_vv_ratio_mean_db real null,

  valid_pixel_count integer null,
  total_pixel_count integer null,

  status text not null default 'ok'
    check (status in ('pending', 'ok', 'no-data', 'error')),
  error_message text null,

  unique (field_id, item_id)
);

create index if not exists tilth_field_sar_field_id_idx
on public.tilth_field_sar (field_id);

create index if not exists tilth_field_sar_field_datetime_idx
on public.tilth_field_sar (field_id, scene_datetime desc);

alter table public.tilth_field_sar enable row level security;

drop policy if exists "tilth_field_sar select farm owner/admin"
  on public.tilth_field_sar;
create policy "tilth_field_sar select farm owner/admin"
on public.tilth_field_sar
for select
to authenticated
using (
  exists (
    select 1
    from public.tilth_fields tf
    join public.farms f on f.id = tf.farm_id
    where tf.id = tilth_field_sar.field_id
      and (f.owner_user_id = auth.uid() or public.is_admin())
  )
);

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'tilth_field_sar'
  ) then
    alter publication supabase_realtime add table public.tilth_field_sar;
  end if;
end $$;

-- 3b) Enquiry responses (admin replies)
create table if not exists public.enquiry_responses (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  enquiry_id uuid not null references public.enquiries (id) on delete cascade,
  author_user_id uuid null references auth.users (id) on delete set null,
  message text not null
);

create index if not exists enquiry_responses_enquiry_id_idx
on public.enquiry_responses (enquiry_id);

alter table public.enquiry_responses enable row level security;

-- Admins can create responses.
drop policy if exists "enquiry_responses insert admin" on public.enquiry_responses;
create policy "enquiry_responses insert admin"
on public.enquiry_responses
for insert
to authenticated
with check (public.is_admin());

-- Admins can read all; owners can read responses to their enquiries.
drop policy if exists "enquiry_responses select admin/owner" on public.enquiry_responses;
create policy "enquiry_responses select admin/owner"
on public.enquiry_responses
for select
to authenticated
using (
  public.is_admin()
  or exists (
    select 1 from public.enquiries e
    where e.id = enquiry_id
      and e.user_id = auth.uid()
  )
);

-- 4) Storage bucket + policies
-- Bucket name (change if you want): enquiry-uploads
insert into storage.buckets (id, name, public)
values ('enquiry-uploads', 'enquiry-uploads', false)
on conflict (id) do nothing;

-- Storage policies are on storage.objects.
-- Allow uploads from anyone to a constrained prefix.
drop policy if exists "enquiry uploads insert" on storage.objects;
create policy "enquiry uploads insert"
on storage.objects
for insert
to anon, authenticated
with check (
  bucket_id = 'enquiry-uploads'
  and name like 'enquiries/%'
);

-- Allow admins to read all uploads.
drop policy if exists "enquiry uploads select admin" on storage.objects;
create policy "enquiry uploads select admin"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'enquiry-uploads'
  and public.is_admin()
);

-- Allow owners to read their own uploads (based on path: enquiries/<enquiry_id>/...)
drop policy if exists "enquiry uploads select owner" on storage.objects;
create policy "enquiry uploads select owner"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'enquiry-uploads'
  and split_part(name, '/', 1) = 'enquiries'
  and exists (
    select 1
    from public.enquiries e
    where e.id::text = split_part(name, '/', 2)
      and e.user_id = auth.uid()
  )
);

-- Allow admins to delete uploads (cleanup).
drop policy if exists "enquiry uploads delete admin" on storage.objects;
create policy "enquiry uploads delete admin"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'enquiry-uploads'
  and public.is_admin()
);

-- Migration: add vegetation/moisture indices to tilth_field_ndvi
alter table public.tilth_field_ndvi add column if not exists evi_mean real null;
alter table public.tilth_field_ndvi add column if not exists ndwi_mean real null;
alter table public.tilth_field_ndvi add column if not exists ndmi_mean real null;
alter table public.tilth_field_ndvi add column if not exists ndre_mean real null;
alter table public.tilth_field_ndvi add column if not exists savi_mean real null;
alter table public.tilth_field_ndvi add column if not exists nbr_mean real null;

-- ═══════════════════════════════════════════════════════════════════════
-- Per-field elevation from Copernicus DEM 30m (via MPC)
-- Static — one row per field, not a time series.
-- ═══════════════════════════════════════════════════════════════════════
create table if not exists public.tilth_field_elevation (
  field_id       uuid not null references public.tilth_fields(id) on delete cascade,
  item_id        text not null default '',
  collection     text not null default 'cop-dem-glo-30',
  elevation_mean real,
  elevation_min  real,
  elevation_max  real,
  elevation_range real,
  elevation_stddev real,
  elevation_median real,
  slope_mean_deg real,
  slope_max_deg  real,
  slope_stddev_deg real,
  aspect_mean_deg real,
  aspect_dominant text,
  twi_mean       real,
  twi_min        real,
  twi_max        real,
  valid_pixel_count integer,
  total_pixel_count integer,
  resolution_m   real default 30,
  status         text not null default 'pending',
  error_message  text,
  updated_at     timestamptz default now(),
  primary key (field_id)
);

alter table public.tilth_field_elevation enable row level security;

drop policy if exists "elevation select own" on public.tilth_field_elevation;
create policy "elevation select own"
on public.tilth_field_elevation for select to authenticated
using (
  exists (
    select 1
    from public.tilth_fields tf
    join public.farms f on f.id = tf.farm_id
    where tf.id = tilth_field_elevation.field_id
      and (f.owner_user_id = auth.uid() or public.is_admin())
  )
);

drop policy if exists "elevation service insert" on public.tilth_field_elevation;
create policy "elevation service insert"
on public.tilth_field_elevation for all to service_role
using (true) with check (true);

do $$ begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'tilth_field_elevation'
  ) then
    alter publication supabase_realtime add table public.tilth_field_elevation;
  end if;
end $$;

-- ═══════════════════════════════════════════════════════════════════════
-- Multi-user collaborative access
-- ═══════════════════════════════════════════════════════════════════════
create table if not exists public.farm_members (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  farm_id uuid not null references public.farms(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'viewer'
    check (role in ('viewer', 'operator', 'manager', 'admin')),
  invited_by uuid null references auth.users(id) on delete set null,
  unique (farm_id, user_id)
);

create index if not exists farm_members_farm_id_idx on public.farm_members(farm_id);
create index if not exists farm_members_user_id_idx on public.farm_members(user_id);

alter table public.farm_members enable row level security;

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

-- Pending invitations (email-based, for users not yet signed up)
create table if not exists public.farm_invites (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  farm_id uuid not null references public.farms(id) on delete cascade,
  email text not null,
  role text not null default 'viewer'
    check (role in ('viewer', 'operator', 'manager', 'admin')),
  invited_by uuid not null references auth.users(id) on delete cascade,
  note text null,
  status text not null default 'pending'
    check (status in ('pending', 'accepted', 'revoked')),
  unique (farm_id, email)
);

alter table public.farm_invites enable row level security;

drop policy if exists "farm_invites select owner" on public.farm_invites;
create policy "farm_invites select owner"
on public.farm_invites for select to authenticated
using (
  exists (
    select 1 from public.farms f
    where f.id = farm_invites.farm_id
      and f.owner_user_id = auth.uid()
  )
  or email = (select auth.jwt() ->> 'email')
);

drop policy if exists "farm_invites insert owner" on public.farm_invites;
create policy "farm_invites insert owner"
on public.farm_invites for insert to authenticated
with check (
  exists (
    select 1 from public.farms f
    where f.id = farm_invites.farm_id
      and f.owner_user_id = auth.uid()
  )
);

drop policy if exists "farm_invites update owner" on public.farm_invites;
create policy "farm_invites update owner"
on public.farm_invites for update to authenticated
using (
  exists (
    select 1 from public.farms f
    where f.id = farm_invites.farm_id
      and f.owner_user_id = auth.uid()
  )
);

-- ═══════════════════════════════════════════════════════════════════════
-- Livestock — animal register
-- ═══════════════════════════════════════════════════════════════════════
create table if not exists public.livestock (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  farm_id uuid not null references public.farms(id) on delete cascade,

  tag_number text not null,
  name text null,
  species text not null check (species in ('cattle','sheep','pig','goat','poultry','horse','other')),
  breed text null,
  sex text not null default 'female' check (sex in ('male','female','castrate')),
  dob date null,
  sire_id uuid null references public.livestock(id) on delete set null,
  dam_id uuid null references public.livestock(id) on delete set null,
  status text not null default 'active'
    check (status in ('active','sold','dead','culled','missing')),
  status_date date null,
  notes text null,
  unique (farm_id, tag_number)
);

create index if not exists livestock_farm_id_idx on public.livestock(farm_id);

alter table public.livestock enable row level security;

drop policy if exists "livestock select farm owner/admin" on public.livestock;
create policy "livestock select farm owner/admin"
on public.livestock for select to authenticated
using (
  exists (
    select 1 from public.farms f
    where f.id = livestock.farm_id
      and (f.owner_user_id = auth.uid() or public.is_admin())
  )
);

drop policy if exists "livestock insert farm owner" on public.livestock;
create policy "livestock insert farm owner"
on public.livestock for insert to authenticated
with check (
  exists (
    select 1 from public.farms f
    where f.id = livestock.farm_id
      and f.owner_user_id = auth.uid()
  )
);

drop policy if exists "livestock update farm owner" on public.livestock;
create policy "livestock update farm owner"
on public.livestock for update to authenticated
using (
  exists (
    select 1 from public.farms f
    where f.id = livestock.farm_id
      and f.owner_user_id = auth.uid()
  )
);

drop policy if exists "livestock delete farm owner" on public.livestock;
create policy "livestock delete farm owner"
on public.livestock for delete to authenticated
using (
  exists (
    select 1 from public.farms f
    where f.id = livestock.farm_id
      and f.owner_user_id = auth.uid()
  )
);

-- ═══════════════════════════════════════════════════════════════════════
-- Livestock movements (BCMS / ScotEID / APHIS compliant)
-- ═══════════════════════════════════════════════════════════════════════
create table if not exists public.livestock_movements (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  farm_id uuid not null references public.farms(id) on delete cascade,
  animal_id uuid null references public.livestock(id) on delete set null,

  direction text not null check (direction in ('on','off')),
  movement_date date not null,
  from_cph text null,
  to_cph text null,
  reason text null,
  haulier text null,
  batch_ref text null,
  animal_count integer not null default 1,
  notes text null
);

create index if not exists livestock_movements_farm_id_idx
  on public.livestock_movements(farm_id);
create index if not exists livestock_movements_animal_id_idx
  on public.livestock_movements(animal_id);

alter table public.livestock_movements enable row level security;

drop policy if exists "livestock_movements select farm owner/admin" on public.livestock_movements;
create policy "livestock_movements select farm owner/admin"
on public.livestock_movements for select to authenticated
using (
  exists (
    select 1 from public.farms f
    where f.id = livestock_movements.farm_id
      and (f.owner_user_id = auth.uid() or public.is_admin())
  )
);

drop policy if exists "livestock_movements insert farm owner" on public.livestock_movements;
create policy "livestock_movements insert farm owner"
on public.livestock_movements for insert to authenticated
with check (
  public.can_edit_farm(livestock_movements.farm_id)
);

drop policy if exists "livestock_movements update farm editor" on public.livestock_movements;
create policy "livestock_movements update farm editor"
on public.livestock_movements for update to authenticated
using (public.can_edit_farm(livestock_movements.farm_id))
with check (public.can_edit_farm(livestock_movements.farm_id));

drop policy if exists "livestock_movements delete farm editor" on public.livestock_movements;
create policy "livestock_movements delete farm editor"
on public.livestock_movements for delete to authenticated
using (public.can_edit_farm(livestock_movements.farm_id));

-- ═══════════════════════════════════════════════════════════════════════
-- Livestock medicines / treatments
-- ═══════════════════════════════════════════════════════════════════════
create table if not exists public.livestock_medicines (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  farm_id uuid not null references public.farms(id) on delete cascade,
  animal_id uuid null references public.livestock(id) on delete set null,

  treatment_date date not null,
  product_name text not null,
  batch_number text null,
  dosage text null,
  route text null check (route in ('oral','injection','pour-on','topical','intramammary','other')),
  withdrawal_meat_days integer null,
  withdrawal_milk_days integer null,
  administered_by text null,
  vet_name text null,
  reason text null,
  notes text null
);

create index if not exists livestock_medicines_farm_id_idx
  on public.livestock_medicines(farm_id);
create index if not exists livestock_medicines_animal_id_idx
  on public.livestock_medicines(animal_id);

alter table public.livestock_medicines enable row level security;

drop policy if exists "livestock_medicines select farm owner/admin" on public.livestock_medicines;
create policy "livestock_medicines select farm owner/admin"
on public.livestock_medicines for select to authenticated
using (
  exists (
    select 1 from public.farms f
    where f.id = livestock_medicines.farm_id
      and (f.owner_user_id = auth.uid() or public.is_admin())
  )
);

drop policy if exists "livestock_medicines insert farm owner" on public.livestock_medicines;
create policy "livestock_medicines insert farm owner"
on public.livestock_medicines for insert to authenticated
with check (
  public.can_edit_farm(livestock_medicines.farm_id)
);

drop policy if exists "livestock_medicines update farm editor" on public.livestock_medicines;
create policy "livestock_medicines update farm editor"
on public.livestock_medicines for update to authenticated
using (public.can_edit_farm(livestock_medicines.farm_id))
with check (public.can_edit_farm(livestock_medicines.farm_id));

drop policy if exists "livestock_medicines delete farm editor" on public.livestock_medicines;
create policy "livestock_medicines delete farm editor"
on public.livestock_medicines for delete to authenticated
using (public.can_edit_farm(livestock_medicines.farm_id));

-- ═══════════════════════════════════════════════════════════════════════
-- Livestock breeding events
-- ═══════════════════════════════════════════════════════════════════════
create table if not exists public.livestock_breeding (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  farm_id uuid not null references public.farms(id) on delete cascade,
  dam_id uuid null references public.livestock(id) on delete set null,
  sire_id uuid null references public.livestock(id) on delete set null,

  event_type text not null check (event_type in ('service','scan','birth','weaning')),
  event_date date not null,
  expected_date date null,
  offspring_count smallint null,
  offspring_alive smallint null,
  scan_result text null,
  notes text null
);

create index if not exists livestock_breeding_farm_id_idx
  on public.livestock_breeding(farm_id);

alter table public.livestock_breeding enable row level security;

drop policy if exists "livestock_breeding select farm owner/admin" on public.livestock_breeding;
create policy "livestock_breeding select farm owner/admin"
on public.livestock_breeding for select to authenticated
using (
  exists (
    select 1 from public.farms f
    where f.id = livestock_breeding.farm_id
      and (f.owner_user_id = auth.uid() or public.is_admin())
  )
);

drop policy if exists "livestock_breeding insert farm owner" on public.livestock_breeding;
create policy "livestock_breeding insert farm owner"
on public.livestock_breeding for insert to authenticated
with check (
  public.can_edit_farm(livestock_breeding.farm_id)
);

drop policy if exists "livestock_breeding update farm editor" on public.livestock_breeding;
create policy "livestock_breeding update farm editor"
on public.livestock_breeding for update to authenticated
using (public.can_edit_farm(livestock_breeding.farm_id))
with check (public.can_edit_farm(livestock_breeding.farm_id));

drop policy if exists "livestock_breeding delete farm editor" on public.livestock_breeding;
create policy "livestock_breeding delete farm editor"
on public.livestock_breeding for delete to authenticated
using (public.can_edit_farm(livestock_breeding.farm_id));

-- ═══════════════════════════════════════════════════════════════════════
-- Farm tasks / calendar
-- ═══════════════════════════════════════════════════════════════════════
create table if not exists public.farm_tasks (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  farm_id uuid not null references public.farms(id) on delete cascade,
  field_id uuid null references public.tilth_fields(id) on delete set null,
  assigned_to uuid null references auth.users(id) on delete set null,

  title text not null,
  description text null,
  category text not null default 'general'
    check (category in ('general','spray','fertiliser','harvest','livestock','maintenance','compliance','meeting','other')),
  priority text not null default 'medium'
    check (priority in ('low','medium','high','urgent')),
  status text not null default 'pending'
    check (status in ('pending','in_progress','done','cancelled')),
  due_date date null,
  due_time time null,
  completed_at timestamptz null,
  recurrence text null check (recurrence in ('daily','weekly','fortnightly','monthly','quarterly','yearly')),
  notes text null
);

create index if not exists farm_tasks_farm_id_idx on public.farm_tasks(farm_id);
create index if not exists farm_tasks_due_date_idx on public.farm_tasks(farm_id, due_date);

alter table public.farm_tasks enable row level security;

drop policy if exists "farm_tasks select farm owner/member" on public.farm_tasks;
create policy "farm_tasks select farm owner/member"
on public.farm_tasks for select to authenticated
using (
  exists (
    select 1 from public.farms f
    where f.id = farm_tasks.farm_id
      and (f.owner_user_id = auth.uid() or public.is_admin())
  )
);

drop policy if exists "farm_tasks insert farm owner" on public.farm_tasks;
create policy "farm_tasks insert farm owner"
on public.farm_tasks for insert to authenticated
with check (
  exists (
    select 1 from public.farms f
    where f.id = farm_tasks.farm_id
      and f.owner_user_id = auth.uid()
  )
);

drop policy if exists "farm_tasks update farm owner" on public.farm_tasks;
create policy "farm_tasks update farm owner"
on public.farm_tasks for update to authenticated
using (
  exists (
    select 1 from public.farms f
    where f.id = farm_tasks.farm_id
      and f.owner_user_id = auth.uid()
  )
);

drop policy if exists "farm_tasks delete farm owner" on public.farm_tasks;
create policy "farm_tasks delete farm owner"
on public.farm_tasks for delete to authenticated
using (
  exists (
    select 1 from public.farms f
    where f.id = farm_tasks.farm_id
      and f.owner_user_id = auth.uid()
  )
);

-- ═══════════════════════════════════════════════════════════════════════
-- Farm inventory (chemical store, seed, fertiliser, fuel)
-- ═══════════════════════════════════════════════════════════════════════
create table if not exists public.farm_inventory (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  farm_id uuid not null references public.farms(id) on delete cascade,

  product_name text not null,
  category text not null default 'chemical'
    check (category in ('chemical','fertiliser','seed','fuel','feed','veterinary','other')),
  unit text not null default 'L',
  quantity_on_hand numeric not null default 0,
  quantity_unit_cost numeric null,
  batch_number text null,
  supplier text null,
  purchase_date date null,
  expiry_date date null,
  storage_location text null,
  mapp_number text null,
  notes text null
);

create index if not exists farm_inventory_farm_id_idx on public.farm_inventory(farm_id);

alter table public.farm_inventory enable row level security;

drop policy if exists "farm_inventory select farm owner/admin" on public.farm_inventory;
create policy "farm_inventory select farm owner/admin"
on public.farm_inventory for select to authenticated
using (
  exists (
    select 1 from public.farms f
    where f.id = farm_inventory.farm_id
      and (f.owner_user_id = auth.uid() or public.is_admin())
  )
);

drop policy if exists "farm_inventory insert farm owner" on public.farm_inventory;
create policy "farm_inventory insert farm owner"
on public.farm_inventory for insert to authenticated
with check (
  exists (
    select 1 from public.farms f
    where f.id = farm_inventory.farm_id
      and f.owner_user_id = auth.uid()
  )
);

drop policy if exists "farm_inventory update farm owner" on public.farm_inventory;
create policy "farm_inventory update farm owner"
on public.farm_inventory for update to authenticated
using (
  exists (
    select 1 from public.farms f
    where f.id = farm_inventory.farm_id
      and f.owner_user_id = auth.uid()
  )
);

drop policy if exists "farm_inventory delete farm owner" on public.farm_inventory;
create policy "farm_inventory delete farm owner"
on public.farm_inventory for delete to authenticated
using (
  exists (
    select 1 from public.farms f
    where f.id = farm_inventory.farm_id
      and f.owner_user_id = auth.uid()
  )
);

-- ═══════════════════════════════════════════════════════════════════════
-- Farm finances (income & expense ledger)
-- ═══════════════════════════════════════════════════════════════════════
create table if not exists public.farm_finances (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  farm_id uuid not null references public.farms(id) on delete cascade,
  field_id uuid null references public.tilth_fields(id) on delete set null,

  txn_type text not null check (txn_type in ('income','expense')),
  txn_date date not null,
  amount numeric not null,
  vat_amount numeric null default 0,
  category text not null default 'other'
    check (category in (
      'grain_sale','livestock_sale','subsidy','contracting_income','other_income',
      'seed','chemical','fertiliser','fuel','vet','contractor','rent','machinery',
      'insurance','labour','feed','other'
    )),
  description text null,
  counterparty text null,
  receipt_path text null,
  invoice_ref text null,
  notes text null
);

create index if not exists farm_finances_farm_id_idx on public.farm_finances(farm_id);
create index if not exists farm_finances_date_idx on public.farm_finances(farm_id, txn_date desc);

alter table public.farm_finances enable row level security;

drop policy if exists "farm_finances select farm owner/admin" on public.farm_finances;
create policy "farm_finances select farm owner/admin"
on public.farm_finances for select to authenticated
using (
  exists (
    select 1 from public.farms f
    where f.id = farm_finances.farm_id
      and (f.owner_user_id = auth.uid() or public.is_admin())
  )
);

drop policy if exists "farm_finances insert farm owner" on public.farm_finances;
create policy "farm_finances insert farm owner"
on public.farm_finances for insert to authenticated
with check (
  exists (
    select 1 from public.farms f
    where f.id = farm_finances.farm_id
      and f.owner_user_id = auth.uid()
  )
);

drop policy if exists "farm_finances update farm owner" on public.farm_finances;
create policy "farm_finances update farm owner"
on public.farm_finances for update to authenticated
using (
  exists (
    select 1 from public.farms f
    where f.id = farm_finances.farm_id
      and f.owner_user_id = auth.uid()
  )
);

drop policy if exists "farm_finances delete farm owner" on public.farm_finances;
create policy "farm_finances delete farm owner"
on public.farm_finances for delete to authenticated
using (
  exists (
    select 1 from public.farms f
    where f.id = farm_finances.farm_id
      and f.owner_user_id = auth.uid()
  )
);

-- ═══════════════════════════════════════════════════════════════════════
-- Farm documents (vault for certificates, receipts, soil analyses)
-- ═══════════════════════════════════════════════════════════════════════
create table if not exists public.farm_documents (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  farm_id uuid not null references public.farms(id) on delete cascade,
  field_id uuid null references public.tilth_fields(id) on delete set null,
  uploaded_by uuid null references auth.users(id) on delete set null,

  title text not null,
  category text not null default 'general'
    check (category in (
      'certificate','soil_analysis','receipt','invoice','tenancy',
      'insurance','spray_test','nptc','organic','red_tractor',
      'scheme_evidence','map','photo','photograph','report','notice',
      'contract','letter','email','asset','vehicle','field_evidence',
      'other','general'
    )),
  bucket text not null default 'farm-documents',
  storage_path text not null,
  filename text not null,
  content_type text null,
  size_bytes bigint null,
  expiry_date date null,
  tags text[] null,
  notes text null
);

create index if not exists farm_documents_farm_id_idx on public.farm_documents(farm_id);

alter table public.farm_documents
  drop constraint if exists farm_documents_category_check;

alter table public.farm_documents
  add constraint farm_documents_category_check
  check (category in (
    'certificate','soil_analysis','receipt','invoice','tenancy',
    'insurance','spray_test','nptc','organic','red_tractor',
    'scheme_evidence','map','photo','photograph','report','notice',
    'contract','letter','email','asset','vehicle','field_evidence',
    'other','general'
  ));

alter table public.farm_documents
  add column if not exists status text not null default 'uploaded'
    check (status in (
      'uploaded','queued','processing','parsed','chunked','embedded',
      'graph_loaded','completed','failed','deleted'
    )),
  add column if not exists error_message text null,
  add column if not exists deleted_at timestamptz null,
  add column if not exists deleted_by uuid null references auth.users(id) on delete set null,
  add column if not exists content_hash text null,
  add column if not exists processing_version text not null default 'docling-v1',
  add column if not exists metadata jsonb not null default '{}'::jsonb;

create index if not exists farm_documents_status_idx on public.farm_documents(farm_id, status);
create index if not exists farm_documents_deleted_at_idx on public.farm_documents(farm_id, deleted_at);
create index if not exists farm_documents_content_hash_idx on public.farm_documents(farm_id, content_hash);

alter table public.farm_documents enable row level security;

drop policy if exists "farm_documents select farm owner/admin" on public.farm_documents;
create policy "farm_documents select farm owner/admin"
on public.farm_documents for select to authenticated
using (public.can_read_farm(farm_id));

drop policy if exists "farm_documents insert farm owner" on public.farm_documents;
create policy "farm_documents insert farm owner"
on public.farm_documents for insert to authenticated
with check (public.can_edit_farm(farm_id));

drop policy if exists "farm_documents update farm editor" on public.farm_documents;
create policy "farm_documents update farm editor"
on public.farm_documents for update to authenticated
using (public.can_edit_farm(farm_id))
with check (public.can_edit_farm(farm_id));

drop policy if exists "farm_documents delete farm owner" on public.farm_documents;
create policy "farm_documents delete farm owner"
on public.farm_documents for delete to authenticated
using (public.can_edit_farm(farm_id));

-- Storage bucket for farm documents
insert into storage.buckets (id, name, public)
values ('farm-documents', 'farm-documents', false)
on conflict (id) do nothing;

drop policy if exists "farm docs upload" on storage.objects;
create policy "farm docs upload"
on storage.objects for insert to authenticated
with check (
  bucket_id = 'farm-documents'
  and split_part(name, '/', 1) ~* '^[0-9a-f-]{36}$'
  and public.can_edit_farm(split_part(name, '/', 1)::uuid)
);

drop policy if exists "farm docs read" on storage.objects;
create policy "farm docs read"
on storage.objects for select to authenticated
using (
  bucket_id = 'farm-documents'
  and split_part(name, '/', 1) ~* '^[0-9a-f-]{36}$'
  and public.can_read_farm(split_part(name, '/', 1)::uuid)
);

drop policy if exists "farm docs delete" on storage.objects;
create policy "farm docs delete"
on storage.objects for delete to authenticated
using (
  bucket_id = 'farm-documents'
  and split_part(name, '/', 1) ~* '^[0-9a-f-]{36}$'
  and public.can_edit_farm(split_part(name, '/', 1)::uuid)
);

-- Processing queue for the document vault. The service-role worker claims
-- rows explicitly; users only see jobs for farms they can read.
create table if not exists public.document_processing_jobs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  farm_id uuid not null references public.farms(id) on delete cascade,
  document_id uuid not null references public.farm_documents(id) on delete cascade,
  status text not null default 'queued'
    check (status in (
      'queued','processing','parsed','chunked','embedded',
      'graph_loaded','completed','failed','cancelled'
    )),
  attempt_count integer not null default 0,
  max_attempts integer not null default 3,
  locked_by text null,
  locked_until timestamptz null,
  started_at timestamptz null,
  completed_at timestamptz null,
  last_error text null,
  processing_version text not null default 'docling-v1',
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists document_processing_jobs_queue_idx
on public.document_processing_jobs(status, locked_until, created_at);

create index if not exists document_processing_jobs_farm_idx
on public.document_processing_jobs(farm_id, status);

create index if not exists document_processing_jobs_document_idx
on public.document_processing_jobs(document_id);

alter table public.document_processing_jobs enable row level security;

drop policy if exists "document_jobs select farm reader" on public.document_processing_jobs;
create policy "document_jobs select farm reader"
on public.document_processing_jobs for select to authenticated
using (public.can_read_farm(farm_id));

drop policy if exists "document_jobs insert farm editor" on public.document_processing_jobs;
create policy "document_jobs insert farm editor"
on public.document_processing_jobs for insert to authenticated
with check (public.can_edit_farm(farm_id));

drop policy if exists "document_jobs update farm editor" on public.document_processing_jobs;
create policy "document_jobs update farm editor"
on public.document_processing_jobs for update to authenticated
using (public.can_edit_farm(farm_id))
with check (public.can_edit_farm(farm_id));

create table if not exists public.document_audit_events (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  farm_id uuid not null references public.farms(id) on delete cascade,
  document_id uuid null references public.farm_documents(id) on delete set null,
  user_id uuid null references auth.users(id) on delete set null,
  action text not null check (action in (
    'upload','view','signed_url','search_exposure','chat_citation',
    'report_usage','delete','restore','failed_access','worker_update',
    'suggested_action','apply_suggested_action','dismiss_suggested_action'
  )),
  ip_address inet null,
  user_agent text null,
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists document_audit_events_farm_idx
on public.document_audit_events(farm_id, created_at desc);

create index if not exists document_audit_events_document_idx
on public.document_audit_events(document_id, created_at desc);

alter table public.document_audit_events enable row level security;

drop policy if exists "document_audit select farm reader" on public.document_audit_events;
create policy "document_audit select farm reader"
on public.document_audit_events for select to authenticated
using (public.can_read_farm(farm_id));

drop policy if exists "document_audit insert farm editor" on public.document_audit_events;
create policy "document_audit insert farm editor"
on public.document_audit_events for insert to authenticated
with check (public.can_edit_farm(farm_id));

create table if not exists public.document_chunks (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  farm_id uuid not null references public.farms(id) on delete cascade,
  document_id uuid not null references public.farm_documents(id) on delete cascade,
  chunk_index integer not null,
  chunk_text text not null,
  token_count integer null,
  page_number integer null,
  section_heading text null,
  table_reference text null,
  figure_reference text null,
  bounding_boxes jsonb not null default '[]'::jsonb,
  source_metadata jsonb not null default '{}'::jsonb,
  docling_metadata jsonb not null default '{}'::jsonb,
  neo4j_chunk_node_id text null,
  unique (farm_id, document_id, chunk_index)
);

create index if not exists document_chunks_farm_document_idx
on public.document_chunks(farm_id, document_id, chunk_index);

create index if not exists document_chunks_text_idx
on public.document_chunks using gin(to_tsvector('english', chunk_text));

alter table public.document_chunks enable row level security;

drop policy if exists "document_chunks select farm reader" on public.document_chunks;
create policy "document_chunks select farm reader"
on public.document_chunks for select to authenticated
using (public.can_read_farm(farm_id));

drop policy if exists "document_chunks insert farm editor" on public.document_chunks;
create policy "document_chunks insert farm editor"
on public.document_chunks for insert to authenticated
with check (public.can_edit_farm(farm_id));

drop policy if exists "document_chunks update farm editor" on public.document_chunks;
create policy "document_chunks update farm editor"
on public.document_chunks for update to authenticated
using (public.can_edit_farm(farm_id))
with check (public.can_edit_farm(farm_id));

drop policy if exists "document_chunks delete farm editor" on public.document_chunks;
create policy "document_chunks delete farm editor"
on public.document_chunks for delete to authenticated
using (public.can_edit_farm(farm_id));

create table if not exists public.document_tables (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  farm_id uuid not null references public.farms(id) on delete cascade,
  document_id uuid not null references public.farm_documents(id) on delete cascade,
  chunk_id uuid null references public.document_chunks(id) on delete set null,
  table_index integer not null,
  page_number integer null,
  label text null,
  caption text null,
  markdown text null,
  plain_text text null,
  rows jsonb not null default '[]'::jsonb,
  bounding_boxes jsonb not null default '[]'::jsonb,
  source_metadata jsonb not null default '{}'::jsonb,
  unique (farm_id, document_id, table_index)
);

create index if not exists document_tables_farm_document_idx
on public.document_tables(farm_id, document_id, table_index);

create index if not exists document_tables_text_idx
on public.document_tables using gin(to_tsvector('english', coalesce(plain_text, '') || ' ' || coalesce(markdown, '')));

alter table public.document_tables enable row level security;

drop policy if exists "document_tables select farm reader" on public.document_tables;
create policy "document_tables select farm reader"
on public.document_tables for select to authenticated
using (public.can_read_farm(farm_id));

drop policy if exists "document_tables write farm editor" on public.document_tables;
create policy "document_tables write farm editor"
on public.document_tables for all to authenticated
using (public.can_edit_farm(farm_id))
with check (public.can_edit_farm(farm_id));

create table if not exists public.document_figures (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  farm_id uuid not null references public.farms(id) on delete cascade,
  document_id uuid not null references public.farm_documents(id) on delete cascade,
  chunk_id uuid null references public.document_chunks(id) on delete set null,
  figure_index integer not null,
  page_number integer null,
  label text null,
  caption text null,
  alt_text text null,
  figure_type text null,
  bounding_boxes jsonb not null default '[]'::jsonb,
  source_metadata jsonb not null default '{}'::jsonb,
  unique (farm_id, document_id, figure_index)
);

create index if not exists document_figures_farm_document_idx
on public.document_figures(farm_id, document_id, figure_index);

create index if not exists document_figures_text_idx
on public.document_figures using gin(to_tsvector('english', coalesce(caption, '') || ' ' || coalesce(alt_text, '') || ' ' || coalesce(label, '')));

alter table public.document_figures enable row level security;

drop policy if exists "document_figures select farm reader" on public.document_figures;
create policy "document_figures select farm reader"
on public.document_figures for select to authenticated
using (public.can_read_farm(farm_id));

drop policy if exists "document_figures write farm editor" on public.document_figures;
create policy "document_figures write farm editor"
on public.document_figures for all to authenticated
using (public.can_edit_farm(farm_id))
with check (public.can_edit_farm(farm_id));

create table if not exists public.document_chunk_embeddings (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  farm_id uuid not null references public.farms(id) on delete cascade,
  document_id uuid not null references public.farm_documents(id) on delete cascade,
  chunk_id uuid not null references public.document_chunks(id) on delete cascade,
  embedding_model text not null,
  embedding_dimensions integer not null default 1536,
  embedding vector(1536) not null,
  metadata jsonb not null default '{}'::jsonb,
  unique (chunk_id, embedding_model)
);

create index if not exists document_chunk_embeddings_farm_idx
on public.document_chunk_embeddings(farm_id, embedding_model);

create index if not exists document_chunk_embeddings_vector_idx
on public.document_chunk_embeddings using ivfflat (embedding vector_cosine_ops)
with (lists = 100);

alter table public.document_chunk_embeddings enable row level security;

drop policy if exists "document_embeddings select farm reader" on public.document_chunk_embeddings;
create policy "document_embeddings select farm reader"
on public.document_chunk_embeddings for select to authenticated
using (public.can_read_farm(farm_id));

drop policy if exists "document_embeddings insert farm editor" on public.document_chunk_embeddings;
create policy "document_embeddings insert farm editor"
on public.document_chunk_embeddings for insert to authenticated
with check (public.can_edit_farm(farm_id));

drop policy if exists "document_embeddings update farm editor" on public.document_chunk_embeddings;
create policy "document_embeddings update farm editor"
on public.document_chunk_embeddings for update to authenticated
using (public.can_edit_farm(farm_id))
with check (public.can_edit_farm(farm_id));

drop policy if exists "document_embeddings delete farm editor" on public.document_chunk_embeddings;
create policy "document_embeddings delete farm editor"
on public.document_chunk_embeddings for delete to authenticated
using (public.can_edit_farm(farm_id));

create table if not exists public.document_extracted_entities (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  farm_id uuid not null references public.farms(id) on delete cascade,
  document_id uuid not null references public.farm_documents(id) on delete cascade,
  chunk_id uuid null references public.document_chunks(id) on delete set null,
  entity_type text not null,
  entity_value text not null,
  normalised_value text null,
  confidence numeric null,
  extraction_method text null,
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists document_entities_farm_idx
on public.document_extracted_entities(farm_id, entity_type, normalised_value);

alter table public.document_extracted_entities enable row level security;

drop policy if exists "document_entities select farm reader" on public.document_extracted_entities;
create policy "document_entities select farm reader"
on public.document_extracted_entities for select to authenticated
using (public.can_read_farm(farm_id));

drop policy if exists "document_entities write farm editor" on public.document_extracted_entities;
create policy "document_entities write farm editor"
on public.document_extracted_entities for all to authenticated
using (public.can_edit_farm(farm_id))
with check (public.can_edit_farm(farm_id));

create table if not exists public.document_suggested_actions (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  farm_id uuid not null references public.farms(id) on delete cascade,
  document_id uuid not null references public.farm_documents(id) on delete cascade,
  action_type text not null check (action_type in (
    'calendar_reminder',
    'finance_transaction',
    'inventory_item',
    'spray_record'
  )),
  title text not null,
  summary text null,
  confidence numeric null,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (status in ('pending','applied','dismissed')),
  applied_at timestamptz null,
  applied_by uuid null references auth.users(id) on delete set null,
  dismissed_at timestamptz null,
  dismissed_by uuid null references auth.users(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists document_suggested_actions_farm_status_idx
on public.document_suggested_actions(farm_id, status, created_at desc);

create index if not exists document_suggested_actions_document_idx
on public.document_suggested_actions(document_id, status);

create unique index if not exists document_suggested_actions_unique_pending_idx
on public.document_suggested_actions(farm_id, document_id, action_type, ((payload->>'sourceKey')))
where status = 'pending' and payload ? 'sourceKey';

alter table public.document_suggested_actions enable row level security;

drop policy if exists "document_suggested_actions select farm reader" on public.document_suggested_actions;
create policy "document_suggested_actions select farm reader"
on public.document_suggested_actions for select to authenticated
using (public.can_read_farm(farm_id));

drop policy if exists "document_suggested_actions write farm editor" on public.document_suggested_actions;
create policy "document_suggested_actions write farm editor"
on public.document_suggested_actions for all to authenticated
using (public.can_edit_farm(farm_id))
with check (public.can_edit_farm(farm_id));

create table if not exists public.assistant_chat_sessions (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  farm_id uuid not null references public.farms(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  title text null,
  scope text not null default 'whole_farm',
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists assistant_chat_sessions_farm_user_idx
on public.assistant_chat_sessions(farm_id, user_id, created_at desc);

alter table public.assistant_chat_sessions enable row level security;

drop policy if exists "assistant_chat_sessions select own farm" on public.assistant_chat_sessions;
create policy "assistant_chat_sessions select own farm"
on public.assistant_chat_sessions for select to authenticated
using (user_id = auth.uid() and public.can_read_farm(farm_id));

drop policy if exists "assistant_chat_sessions write own farm" on public.assistant_chat_sessions;
create policy "assistant_chat_sessions write own farm"
on public.assistant_chat_sessions for all to authenticated
using (user_id = auth.uid() and public.can_read_farm(farm_id))
with check (user_id = auth.uid() and public.can_read_farm(farm_id));

create table if not exists public.assistant_chat_messages (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  farm_id uuid not null references public.farms(id) on delete cascade,
  chat_session_id uuid not null references public.assistant_chat_sessions(id) on delete cascade,
  user_id uuid null references auth.users(id) on delete set null,
  role text not null check (role in ('user','assistant','system')),
  content text not null,
  sources jsonb not null default '[]'::jsonb,
  suggested_actions jsonb not null default '[]'::jsonb,
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists assistant_chat_messages_session_idx
on public.assistant_chat_messages(chat_session_id, created_at);

alter table public.assistant_chat_messages enable row level security;

drop policy if exists "assistant_chat_messages select farm reader" on public.assistant_chat_messages;
create policy "assistant_chat_messages select farm reader"
on public.assistant_chat_messages for select to authenticated
using (public.can_read_farm(farm_id));

drop policy if exists "assistant_chat_messages insert farm reader" on public.assistant_chat_messages;
create policy "assistant_chat_messages insert farm reader"
on public.assistant_chat_messages for insert to authenticated
with check (public.can_read_farm(farm_id));

create table if not exists public.assistant_suggested_actions (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  farm_id uuid not null references public.farms(id) on delete cascade,
  user_id uuid null references auth.users(id) on delete set null,
  origin text not null default 'platform_assistant',
  origin_id uuid null,
  action_type text not null check (action_type in (
    'calendar_reminder',
    'finance_transaction',
    'inventory_item',
    'inventory_adjustment',
    'field_observation',
    'spray_record',
    'contact',
    'compliance_checklist',
    'market_watchlist',
    'livestock_medicine',
    'livestock_movement'
  )),
  title text not null,
  summary text null,
  confidence numeric null,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (status in ('pending','applied','dismissed')),
  applied_at timestamptz null,
  applied_by uuid null references auth.users(id) on delete set null,
  dismissed_at timestamptz null,
  dismissed_by uuid null references auth.users(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists assistant_suggested_actions_farm_status_idx
on public.assistant_suggested_actions(farm_id, status, created_at desc);

alter table public.assistant_suggested_actions enable row level security;

drop policy if exists "assistant_suggested_actions select farm reader" on public.assistant_suggested_actions;
create policy "assistant_suggested_actions select farm reader"
on public.assistant_suggested_actions for select to authenticated
using (public.can_read_farm(farm_id));

drop policy if exists "assistant_suggested_actions write farm editor" on public.assistant_suggested_actions;
create policy "assistant_suggested_actions write farm editor"
on public.assistant_suggested_actions for all to authenticated
using (public.can_edit_farm(farm_id))
with check (public.can_edit_farm(farm_id));

create table if not exists public.assistant_generated_reports (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  farm_id uuid not null references public.farms(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete set null,
  report_type text not null,
  title text null,
  prompt text not null,
  content text not null,
  sources jsonb not null default '[]'::jsonb,
  suggested_actions jsonb not null default '[]'::jsonb,
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists assistant_generated_reports_farm_idx
on public.assistant_generated_reports(farm_id, created_at desc);

alter table public.assistant_generated_reports enable row level security;

drop policy if exists "assistant_generated_reports select farm reader" on public.assistant_generated_reports;
create policy "assistant_generated_reports select farm reader"
on public.assistant_generated_reports for select to authenticated
using (public.can_read_farm(farm_id));

drop policy if exists "assistant_generated_reports insert farm reader" on public.assistant_generated_reports;
create policy "assistant_generated_reports insert farm reader"
on public.assistant_generated_reports for insert to authenticated
with check (public.can_read_farm(farm_id));

create table if not exists public.document_chat_sessions (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  farm_id uuid not null references public.farms(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  title text null,
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists document_chat_sessions_farm_user_idx
on public.document_chat_sessions(farm_id, user_id, created_at desc);

alter table public.document_chat_sessions enable row level security;

drop policy if exists "document_chat_sessions select farm reader" on public.document_chat_sessions;
create policy "document_chat_sessions select farm reader"
on public.document_chat_sessions for select to authenticated
using (user_id = auth.uid() and public.can_read_farm(farm_id));

drop policy if exists "document_chat_sessions write own farm" on public.document_chat_sessions;
create policy "document_chat_sessions write own farm"
on public.document_chat_sessions for all to authenticated
using (user_id = auth.uid() and public.can_read_farm(farm_id))
with check (user_id = auth.uid() and public.can_read_farm(farm_id));

create table if not exists public.document_chat_messages (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  farm_id uuid not null references public.farms(id) on delete cascade,
  chat_session_id uuid not null references public.document_chat_sessions(id) on delete cascade,
  user_id uuid null references auth.users(id) on delete set null,
  role text not null check (role in ('user','assistant','system')),
  content text not null,
  source_chunks jsonb not null default '[]'::jsonb,
  source_documents jsonb not null default '[]'::jsonb,
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists document_chat_messages_session_idx
on public.document_chat_messages(chat_session_id, created_at);

alter table public.document_chat_messages enable row level security;

drop policy if exists "document_chat_messages select farm reader" on public.document_chat_messages;
create policy "document_chat_messages select farm reader"
on public.document_chat_messages for select to authenticated
using (public.can_read_farm(farm_id));

drop policy if exists "document_chat_messages insert farm reader" on public.document_chat_messages;
create policy "document_chat_messages insert farm reader"
on public.document_chat_messages for insert to authenticated
with check (public.can_read_farm(farm_id));

create table if not exists public.document_generated_reports (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  farm_id uuid not null references public.farms(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete set null,
  title text null,
  prompt text not null,
  content text not null,
  source_chunks jsonb not null default '[]'::jsonb,
  source_documents jsonb not null default '[]'::jsonb,
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists document_generated_reports_farm_idx
on public.document_generated_reports(farm_id, created_at desc);

alter table public.document_generated_reports enable row level security;

drop policy if exists "document_reports select farm reader" on public.document_generated_reports;
create policy "document_reports select farm reader"
on public.document_generated_reports for select to authenticated
using (public.can_read_farm(farm_id));

drop policy if exists "document_reports insert farm reader" on public.document_generated_reports;
create policy "document_reports insert farm reader"
on public.document_generated_reports for insert to authenticated
with check (public.can_read_farm(farm_id));

create or replace function public.document_vault_match_chunks(
  p_farm_id uuid,
  p_query_embedding vector(1536),
  p_embedding_model text,
  p_match_count integer default 10
)
returns table (
  chunk_id uuid,
  document_id uuid,
  chunk_text text,
  page_number integer,
  section_heading text,
  similarity double precision,
  metadata jsonb
)
language sql
stable
as $$
  select
    c.id as chunk_id,
    c.document_id,
    c.chunk_text,
    c.page_number,
    c.section_heading,
    1 - (e.embedding <=> p_query_embedding) as similarity,
    jsonb_build_object(
      'chunk', c.source_metadata,
      'docling', c.docling_metadata,
      'embedding', e.metadata
    ) as metadata
  from public.document_chunk_embeddings e
  join public.document_chunks c on c.id = e.chunk_id
  join public.farm_documents d on d.id = c.document_id
  where e.farm_id = p_farm_id
    and c.farm_id = p_farm_id
    and d.farm_id = p_farm_id
    and d.deleted_at is null
    and e.embedding_model = p_embedding_model
  order by e.embedding <=> p_query_embedding
  limit greatest(1, least(coalesce(p_match_count, 10), 50));
$$;

-- ═══════════════════════════════════════════════════════════════════════
-- Farm contacts / suppliers directory
-- ═══════════════════════════════════════════════════════════════════════
create table if not exists public.farm_contacts (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  farm_id uuid not null references public.farms(id) on delete cascade,

  name text not null,
  company text null,
  role text null check (role in (
    'agronomist','vet','grain_merchant','seed_rep','chemical_rep',
    'contractor','fuel_supplier','machinery_dealer','accountant',
    'landlord','tenant','rpa_officer','organic_body','other'
  )),
  phone text null,
  email text null,
  address text null,
  notes text null
);

create index if not exists farm_contacts_farm_id_idx on public.farm_contacts(farm_id);

alter table public.farm_contacts enable row level security;

drop policy if exists "farm_contacts select farm owner/admin" on public.farm_contacts;
create policy "farm_contacts select farm owner/admin"
on public.farm_contacts for select to authenticated
using (
  exists (
    select 1 from public.farms f
    where f.id = farm_contacts.farm_id
      and (f.owner_user_id = auth.uid() or public.is_admin())
  )
);

drop policy if exists "farm_contacts insert farm owner" on public.farm_contacts;
create policy "farm_contacts insert farm owner"
on public.farm_contacts for insert to authenticated
with check (
  exists (
    select 1 from public.farms f
    where f.id = farm_contacts.farm_id
      and f.owner_user_id = auth.uid()
  )
);

drop policy if exists "farm_contacts update farm owner" on public.farm_contacts;
create policy "farm_contacts update farm owner"
on public.farm_contacts for update to authenticated
using (
  exists (
    select 1 from public.farms f
    where f.id = farm_contacts.farm_id
      and f.owner_user_id = auth.uid()
  )
);

drop policy if exists "farm_contacts delete farm owner" on public.farm_contacts;
create policy "farm_contacts delete farm owner"
on public.farm_contacts for delete to authenticated
using (
  exists (
    select 1 from public.farms f
    where f.id = farm_contacts.farm_id
      and f.owner_user_id = auth.uid()
  )
);

-- ═══════════════════════════════════════════════════════════════════════
-- Farm app data — synced JSON backing store for local-first modules
-- ═══════════════════════════════════════════════════════════════════════
create table if not exists public.farm_app_data (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  farm_id uuid not null references public.farms(id) on delete cascade,
  namespace text not null,
  data jsonb not null default '{}'::jsonb,
  unique (farm_id, namespace)
);

create index if not exists farm_app_data_farm_id_idx
on public.farm_app_data(farm_id);

alter table public.farm_app_data enable row level security;

drop policy if exists "farm_app_data select farm owner/member/admin" on public.farm_app_data;
create policy "farm_app_data select farm owner/member/admin"
on public.farm_app_data for select to authenticated
using (
  public.is_admin()
  or exists (
    select 1 from public.farms f
    where f.id = farm_app_data.farm_id
      and f.owner_user_id = auth.uid()
  )
  or exists (
    select 1 from public.farm_members fm
    where fm.farm_id = farm_app_data.farm_id
      and fm.user_id = auth.uid()
  )
);

drop policy if exists "farm_app_data insert farm owner/manager/admin" on public.farm_app_data;
create policy "farm_app_data insert farm owner/manager/admin"
on public.farm_app_data for insert to authenticated
with check (
  exists (
    select 1 from public.farms f
    where f.id = farm_app_data.farm_id
      and f.owner_user_id = auth.uid()
  )
  or exists (
    select 1 from public.farm_members fm
    where fm.farm_id = farm_app_data.farm_id
      and fm.user_id = auth.uid()
      and fm.role in ('operator', 'manager', 'admin')
  )
);

drop policy if exists "farm_app_data update farm owner/manager/admin" on public.farm_app_data;
create policy "farm_app_data update farm owner/manager/admin"
on public.farm_app_data for update to authenticated
using (
  exists (
    select 1 from public.farms f
    where f.id = farm_app_data.farm_id
      and f.owner_user_id = auth.uid()
  )
  or exists (
    select 1 from public.farm_members fm
    where fm.farm_id = farm_app_data.farm_id
      and fm.user_id = auth.uid()
      and fm.role in ('operator', 'manager', 'admin')
  )
)
with check (
  exists (
    select 1 from public.farms f
    where f.id = farm_app_data.farm_id
      and f.owner_user_id = auth.uid()
  )
  or exists (
    select 1 from public.farm_members fm
    where fm.farm_id = farm_app_data.farm_id
      and fm.user_id = auth.uid()
      and fm.role in ('operator', 'manager', 'admin')
  )
);

drop policy if exists "farm_app_data delete farm owner/admin" on public.farm_app_data;
create policy "farm_app_data delete farm owner/admin"
on public.farm_app_data for delete to authenticated
using (
  exists (
    select 1 from public.farms f
    where f.id = farm_app_data.farm_id
      and f.owner_user_id = auth.uid()
  )
  or exists (
    select 1 from public.farm_members fm
    where fm.farm_id = farm_app_data.farm_id
      and fm.user_id = auth.uid()
      and fm.role = 'admin'
  )
);

-- ═══════════════════════════════════════════════════════════════════════
-- One-way Google Calendar sync (Tilth tasks → Google Calendar)
-- ═══════════════════════════════════════════════════════════════════════
create table if not exists public.google_calendar_connections (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  farm_id uuid not null references public.farms(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  google_email text null,
  google_calendar_id text null,
  access_token text null,
  refresh_token text null,
  token_expires_at timestamptz null,
  oauth_state text null,
  status text not null default 'pending'
    check (status in ('pending','connected','revoked','error')),
  last_synced_at timestamptz null,
  error_message text null,
  unique (farm_id, user_id)
);

create index if not exists google_calendar_connections_farm_id_idx
on public.google_calendar_connections(farm_id);

create unique index if not exists google_calendar_connections_oauth_state_idx
on public.google_calendar_connections(oauth_state)
where oauth_state is not null;

alter table public.google_calendar_connections enable row level security;

drop policy if exists "google_calendar_connections select own" on public.google_calendar_connections;
create policy "google_calendar_connections select own"
on public.google_calendar_connections for select to authenticated
using (user_id = auth.uid() or public.is_admin());

drop policy if exists "google_calendar_connections delete own" on public.google_calendar_connections;
create policy "google_calendar_connections delete own"
on public.google_calendar_connections for delete to authenticated
using (user_id = auth.uid());

create table if not exists public.google_calendar_event_mappings (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  connection_id uuid not null references public.google_calendar_connections(id) on delete cascade,
  farm_id uuid not null references public.farms(id) on delete cascade,
  task_id text not null,
  google_event_id text not null,
  last_task_hash text null,
  last_synced_at timestamptz null,
  unique (connection_id, task_id)
);

create index if not exists google_calendar_event_mappings_farm_id_idx
on public.google_calendar_event_mappings(farm_id);

alter table public.google_calendar_event_mappings enable row level security;

drop policy if exists "google_calendar_event_mappings select own" on public.google_calendar_event_mappings;
create policy "google_calendar_event_mappings select own"
on public.google_calendar_event_mappings for select to authenticated
using (
  exists (
    select 1 from public.google_calendar_connections c
    where c.id = google_calendar_event_mappings.connection_id
      and c.user_id = auth.uid()
  )
);

