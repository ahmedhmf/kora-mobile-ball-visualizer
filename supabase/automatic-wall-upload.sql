-- KORA public-read, no-login automatic MP4 publishing.
-- Use this INSTEAD of direct-wall-upload.sql. Run in Supabase SQL Editor.
-- Uploaded videos are public to anyone with an object URL, not just the TV.
-- Only server-minted signed upload tokens can write to the bucket.

update storage.buckets
set public = true,
    file_size_limit = 20971520,
    allowed_mime_types = array['video/mp4', 'image/jpeg']::text[]
where id = 'kora-wall-media';

-- Link an optional validated JPEG poster to each MP4 for Smart TV fallback.
alter table public.kora_wall_ball_videos
  add column if not exists poster_storage_path text;
-- A poster may be absent for older recordings.
alter table public.kora_wall_ball_videos
  drop constraint if exists ball_video_poster_path_valid;
alter table public.kora_wall_ball_videos
  add constraint ball_video_poster_path_valid check (
    poster_storage_path is null or
    poster_storage_path = regexp_replace(storage_path, '[.]mp4$', '.jpg')
  );

-- Remove the previous operator-only policy. Audit and remove OTHER broad
-- Storage INSERT policies separately (permissive RLS policies combine with OR).
drop policy if exists "kora_wall_operator_mp4_insert" on storage.objects;

alter table public.kora_wall_ball_videos enable row level security;
revoke insert, update, delete on public.kora_wall_ball_videos from anon, authenticated;

create table if not exists public.kora_wall_upload_tickets (
  id uuid primary key,
  storage_path text not null unique,
  ip_hash text not null,
  secret_hash text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '2 hours'),
  completed_at timestamptz
);
create index if not exists kora_wall_ticket_ip_idx on public.kora_wall_upload_tickets(ip_hash,created_at desc);
alter table public.kora_wall_upload_tickets enable row level security;
revoke all on public.kora_wall_upload_tickets from anon, authenticated;

-- Only the Supabase Edge Function with its secret server key can reserve.
create or replace function public.kora_reserve_wall_upload(
  p_id uuid, p_path text, p_ip_hash text, p_secret_hash text
) returns void language plpgsql security definer set search_path = ''
as $kora$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Server credential required' using errcode='42501';
  end if;
  if p_path !~ '^balls/[A-Za-z0-9_-]{1,64}/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}[.]mp4$'
    or p_ip_hash !~ '^[a-f0-9]{64}$'
    or p_secret_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'Invalid upload ticket' using errcode='22023';
  end if;

  -- Serialize all quota decisions so concurrent requests cannot evade limits.
  perform pg_catalog.pg_advisory_xact_lock(6728224);
  if (select count(*) from public.kora_wall_upload_tickets
      where ip_hash=p_ip_hash and created_at>now()-interval '1 hour') >= 6
    or (select count(*) from public.kora_wall_upload_tickets
      where created_at>now()-interval '1 hour') >= 100 then
    raise exception 'Upload quota exceeded' using errcode='P0001';
  end if;
  insert into public.kora_wall_upload_tickets (id,storage_path,ip_hash,secret_hash)
  values (p_id,p_path,p_ip_hash,p_secret_hash);
end;
$kora$;

-- Obtain only the server-reserved path after proof of the ticket secret.
-- Never grant this endpoint to anonymous clients.
create or replace function public.kora_lookup_wall_upload(
  p_id uuid, p_secret_hash text
) returns text language plpgsql security definer set search_path = ''
as $kora$
declare
  v_path text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Server credential required' using errcode='42501';
  end if;
  select storage_path into v_path from public.kora_wall_upload_tickets
    where id=p_id and secret_hash=p_secret_hash
      and completed_at is null and expires_at>now();
  return v_path;
end;
$kora$;

-- This is called by the Edge Function ONLY AFTER it retrieves and validates
-- the Storage object's MP4 structure. There is no manual approval step.
-- No browser-supplied consent/approval field is ever accepted.
create or replace function public.kora_complete_wall_upload(
  p_id uuid, p_secret_hash text
) returns void language plpgsql security definer set search_path = ''
as $kora$
declare
  v_ticket public.kora_wall_upload_tickets%rowtype;
  v_object storage.objects%rowtype;
  v_poster storage.objects%rowtype;
  v_poster_path text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Server credential required' using errcode='42501';
  end if;

  select * into v_ticket from public.kora_wall_upload_tickets
  where id=p_id and secret_hash=p_secret_hash for update;
  if not found or v_ticket.completed_at is not null or v_ticket.expires_at<now() then
    raise exception 'Ticket expired or already completed' using errcode='42501';
  end if;

  select * into v_object from storage.objects
  where bucket_id='kora-wall-media' and name=v_ticket.storage_path for update;
  if not found
    or coalesce(v_object.metadata->>'mimetype','') <> 'video/mp4'
    or coalesce((v_object.metadata->>'size')::bigint,0) <= 0
    or coalesce((v_object.metadata->>'size')::bigint,0) > 20971520 then
    raise exception 'Missing or oversized MP4' using errcode='22023';
  end if;

  v_poster_path := regexp_replace(v_ticket.storage_path, '[.]mp4
  -- uploaded_at is generated by the database default.
  update public.kora_wall_upload_tickets set completed_at=now() where id=p_id;
end;
$kora$;

revoke all on function public.kora_reserve_wall_upload(uuid,text,text,text) from public,anon,authenticated;
revoke all on function public.kora_complete_wall_upload(uuid,text) from public,anon,authenticated;
revoke all on function public.kora_lookup_wall_upload(uuid,text) from public,anon,authenticated;
grant execute on function public.kora_reserve_wall_upload(uuid,text,text,text) to service_role;
grant execute on function public.kora_complete_wall_upload(uuid,text) to service_role;
grant execute on function public.kora_lookup_wall_upload(uuid,text) to service_role;

-- Media is NOT human-moderated. Automatic parser validation cannot guarantee
-- content suitability or 100% reliable playback; use additional server-side
-- AV validation/transcoding or abuse screening for an unattended public TV.
-- Configure scheduled cleanup of orphaned objects and expired upload tickets.
, '.jpg')
  );

-- Remove the previous operator-only policy. Audit and remove OTHER broad
-- Storage INSERT policies separately (permissive RLS policies combine with OR).
drop policy if exists "kora_wall_operator_mp4_insert" on storage.objects;

alter table public.kora_wall_ball_videos enable row level security;
revoke insert, update, delete on public.kora_wall_ball_videos from anon, authenticated;

create table if not exists public.kora_wall_upload_tickets (
  id uuid primary key,
  storage_path text not null unique,
  ip_hash text not null,
  secret_hash text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '2 hours'),
  completed_at timestamptz
);
create index if not exists kora_wall_ticket_ip_idx on public.kora_wall_upload_tickets(ip_hash,created_at desc);
alter table public.kora_wall_upload_tickets enable row level security;
revoke all on public.kora_wall_upload_tickets from anon, authenticated;

-- Only the Supabase Edge Function with its secret server key can reserve.
create or replace function public.kora_reserve_wall_upload(
  p_id uuid, p_path text, p_ip_hash text, p_secret_hash text
) returns void language plpgsql security definer set search_path = ''
as $kora$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Server credential required' using errcode='42501';
  end if;
  if p_path !~ '^balls/[A-Za-z0-9_-]{1,64}/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}[.]mp4$'
    or p_ip_hash !~ '^[a-f0-9]{64}$'
    or p_secret_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'Invalid upload ticket' using errcode='22023';
  end if;

  -- Serialize all quota decisions so concurrent requests cannot evade limits.
  perform pg_catalog.pg_advisory_xact_lock(6728224);
  if (select count(*) from public.kora_wall_upload_tickets
      where ip_hash=p_ip_hash and created_at>now()-interval '1 hour') >= 6
    or (select count(*) from public.kora_wall_upload_tickets
      where created_at>now()-interval '1 hour') >= 100 then
    raise exception 'Upload quota exceeded' using errcode='P0001';
  end if;
  insert into public.kora_wall_upload_tickets (id,storage_path,ip_hash,secret_hash)
  values (p_id,p_path,p_ip_hash,p_secret_hash);
end;
$kora$;

-- Obtain only the server-reserved path after proof of the ticket secret.
-- Never grant this endpoint to anonymous clients.
create or replace function public.kora_lookup_wall_upload(
  p_id uuid, p_secret_hash text
) returns text language plpgsql security definer set search_path = ''
as $kora$
declare
  v_path text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Server credential required' using errcode='42501';
  end if;
  select storage_path into v_path from public.kora_wall_upload_tickets
    where id=p_id and secret_hash=p_secret_hash
      and completed_at is null and expires_at>now();
  return v_path;
end;
$kora$;

-- This is called by the Edge Function ONLY AFTER it retrieves and validates
-- the Storage object's MP4 structure. There is no manual approval step.
-- No browser-supplied consent/approval field is ever accepted.
create or replace function public.kora_complete_wall_upload(
  p_id uuid, p_secret_hash text
) returns void language plpgsql security definer set search_path = ''
as $kora$
declare
  v_ticket public.kora_wall_upload_tickets%rowtype;
  v_object storage.objects%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Server credential required' using errcode='42501';
  end if;

  select * into v_ticket from public.kora_wall_upload_tickets
  where id=p_id and secret_hash=p_secret_hash for update;
  if not found or v_ticket.completed_at is not null or v_ticket.expires_at<now() then
    raise exception 'Ticket expired or already completed' using errcode='42501';
  end if;

  select * into v_object from storage.objects
  where bucket_id='kora-wall-media' and name=v_ticket.storage_path for update;
  if not found
    or coalesce(v_object.metadata->>'mimetype','') <> 'video/mp4'
    or coalesce((v_object.metadata->>'size')::bigint,0) <= 0
    or coalesce((v_object.metadata->>'size')::bigint,0) > 20971520 then
    raise exception 'Missing or oversized MP4' using errcode='22023';
  end if;

  insert into public.kora_wall_ball_videos
    (storage_path, event_screen_consent, approved)
  values (v_ticket.storage_path, true, true);
  -- uploaded_at is generated by the database default.
  update public.kora_wall_upload_tickets set completed_at=now() where id=p_id;
end;
$kora$;

revoke all on function public.kora_reserve_wall_upload(uuid,text,text,text) from public,anon,authenticated;
revoke all on function public.kora_complete_wall_upload(uuid,text) from public,anon,authenticated;
revoke all on function public.kora_lookup_wall_upload(uuid,text) from public,anon,authenticated;
grant execute on function public.kora_reserve_wall_upload(uuid,text,text,text) to service_role;
grant execute on function public.kora_complete_wall_upload(uuid,text) to service_role;
grant execute on function public.kora_lookup_wall_upload(uuid,text) to service_role;

-- Media is NOT human-moderated. Automatic parser validation cannot guarantee
-- content suitability or 100% reliable playback; use additional server-side
-- AV validation/transcoding or abuse screening for an unattended public TV.
-- Configure scheduled cleanup of orphaned objects and expired upload tickets.
, '.jpg');
  select * into v_poster from storage.objects
  where bucket_id='kora-wall-media' and name=v_poster_path for update;
  if not found
    or coalesce(v_poster.metadata->>'mimetype','') <> 'image/jpeg'
    or coalesce((v_poster.metadata->>'size')::bigint,0) < 100
    or coalesce((v_poster.metadata->>'size')::bigint,0) > 2097152 then
    raise exception 'Missing or invalid ball poster' using errcode='22023';
  end if;

  insert into public.kora_wall_ball_videos
    (storage_path, poster_storage_path, event_screen_consent, approved)
  values (v_ticket.storage_path, v_poster_path, true, true);
  -- uploaded_at is generated by the database default.
  update public.kora_wall_upload_tickets set completed_at=now() where id=p_id;
end;
$kora$;

revoke all on function public.kora_reserve_wall_upload(uuid,text,text,text) from public,anon,authenticated;
revoke all on function public.kora_complete_wall_upload(uuid,text) from public,anon,authenticated;
revoke all on function public.kora_lookup_wall_upload(uuid,text) from public,anon,authenticated;
grant execute on function public.kora_reserve_wall_upload(uuid,text,text,text) to service_role;
grant execute on function public.kora_complete_wall_upload(uuid,text) to service_role;
grant execute on function public.kora_lookup_wall_upload(uuid,text) to service_role;

-- Media is NOT human-moderated. Automatic parser validation cannot guarantee
-- content suitability or 100% reliable playback; use additional server-side
-- AV validation/transcoding or abuse screening for an unattended public TV.
-- Configure scheduled cleanup of orphaned objects and expired upload tickets.
, '.jpg')
  );

-- Remove the previous operator-only policy. Audit and remove OTHER broad
-- Storage INSERT policies separately (permissive RLS policies combine with OR).
drop policy if exists "kora_wall_operator_mp4_insert" on storage.objects;

alter table public.kora_wall_ball_videos enable row level security;
revoke insert, update, delete on public.kora_wall_ball_videos from anon, authenticated;

create table if not exists public.kora_wall_upload_tickets (
  id uuid primary key,
  storage_path text not null unique,
  ip_hash text not null,
  secret_hash text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '2 hours'),
  completed_at timestamptz
);
create index if not exists kora_wall_ticket_ip_idx on public.kora_wall_upload_tickets(ip_hash,created_at desc);
alter table public.kora_wall_upload_tickets enable row level security;
revoke all on public.kora_wall_upload_tickets from anon, authenticated;

-- Only the Supabase Edge Function with its secret server key can reserve.
create or replace function public.kora_reserve_wall_upload(
  p_id uuid, p_path text, p_ip_hash text, p_secret_hash text
) returns void language plpgsql security definer set search_path = ''
as $kora$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Server credential required' using errcode='42501';
  end if;
  if p_path !~ '^balls/[A-Za-z0-9_-]{1,64}/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}[.]mp4$'
    or p_ip_hash !~ '^[a-f0-9]{64}$'
    or p_secret_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'Invalid upload ticket' using errcode='22023';
  end if;

  -- Serialize all quota decisions so concurrent requests cannot evade limits.
  perform pg_catalog.pg_advisory_xact_lock(6728224);
  if (select count(*) from public.kora_wall_upload_tickets
      where ip_hash=p_ip_hash and created_at>now()-interval '1 hour') >= 6
    or (select count(*) from public.kora_wall_upload_tickets
      where created_at>now()-interval '1 hour') >= 100 then
    raise exception 'Upload quota exceeded' using errcode='P0001';
  end if;
  insert into public.kora_wall_upload_tickets (id,storage_path,ip_hash,secret_hash)
  values (p_id,p_path,p_ip_hash,p_secret_hash);
end;
$kora$;

-- Obtain only the server-reserved path after proof of the ticket secret.
-- Never grant this endpoint to anonymous clients.
create or replace function public.kora_lookup_wall_upload(
  p_id uuid, p_secret_hash text
) returns text language plpgsql security definer set search_path = ''
as $kora$
declare
  v_path text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Server credential required' using errcode='42501';
  end if;
  select storage_path into v_path from public.kora_wall_upload_tickets
    where id=p_id and secret_hash=p_secret_hash
      and completed_at is null and expires_at>now();
  return v_path;
end;
$kora$;

-- This is called by the Edge Function ONLY AFTER it retrieves and validates
-- the Storage object's MP4 structure. There is no manual approval step.
-- No browser-supplied consent/approval field is ever accepted.
create or replace function public.kora_complete_wall_upload(
  p_id uuid, p_secret_hash text
) returns void language plpgsql security definer set search_path = ''
as $kora$
declare
  v_ticket public.kora_wall_upload_tickets%rowtype;
  v_object storage.objects%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Server credential required' using errcode='42501';
  end if;

  select * into v_ticket from public.kora_wall_upload_tickets
  where id=p_id and secret_hash=p_secret_hash for update;
  if not found or v_ticket.completed_at is not null or v_ticket.expires_at<now() then
    raise exception 'Ticket expired or already completed' using errcode='42501';
  end if;

  select * into v_object from storage.objects
  where bucket_id='kora-wall-media' and name=v_ticket.storage_path for update;
  if not found
    or coalesce(v_object.metadata->>'mimetype','') <> 'video/mp4'
    or coalesce((v_object.metadata->>'size')::bigint,0) <= 0
    or coalesce((v_object.metadata->>'size')::bigint,0) > 20971520 then
    raise exception 'Missing or oversized MP4' using errcode='22023';
  end if;

  insert into public.kora_wall_ball_videos
    (storage_path, event_screen_consent, approved)
  values (v_ticket.storage_path, true, true);
  -- uploaded_at is generated by the database default.
  update public.kora_wall_upload_tickets set completed_at=now() where id=p_id;
end;
$kora$;

revoke all on function public.kora_reserve_wall_upload(uuid,text,text,text) from public,anon,authenticated;
revoke all on function public.kora_complete_wall_upload(uuid,text) from public,anon,authenticated;
revoke all on function public.kora_lookup_wall_upload(uuid,text) from public,anon,authenticated;
grant execute on function public.kora_reserve_wall_upload(uuid,text,text,text) to service_role;
grant execute on function public.kora_complete_wall_upload(uuid,text) to service_role;
grant execute on function public.kora_lookup_wall_upload(uuid,text) to service_role;

-- Media is NOT human-moderated. Automatic parser validation cannot guarantee
-- content suitability or 100% reliable playback; use additional server-side
-- AV validation/transcoding or abuse screening for an unattended public TV.
-- Configure scheduled cleanup of orphaned objects and expired upload tickets.
