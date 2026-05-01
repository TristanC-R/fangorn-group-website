-- Add first-class table and figure/image evidence for the Document Vault.
-- Run after the base schema when upgrading an existing Supabase project.

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
