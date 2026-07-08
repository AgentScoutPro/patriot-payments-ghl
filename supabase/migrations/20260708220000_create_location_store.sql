-- Replaces the ephemeral location_store.json file (wiped on every Render deploy)
-- with a durable table. Keys mirror the original JSON store: either a raw
-- locationId, or "company_<id>" for company-level token entries.

create table if not exists public.location_store (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

comment on table public.location_store is
  'Persistent replacement for the old location_store.json file used by the Patriot Payments GHL backend. Stores OAuth tokens and Accept Blue credentials per GHL location/company.';

-- Keep updated_at current on every write
create or replace function public.set_location_store_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_location_store_updated_at on public.location_store;
create trigger trg_location_store_updated_at
  before update on public.location_store
  for each row
  execute function public.set_location_store_updated_at();

-- This table is written only by the backend's service role key, never by
-- end users, so lock it down with RLS and grant no public access.
alter table public.location_store enable row level security;
