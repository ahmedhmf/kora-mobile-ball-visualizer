-- KORA: direct authenticated MP4 uploads to private Supabase Storage.
-- Run this entire file in Supabase Dashboard > SQL Editor.
-- NOTE: Review and remove any existing overly permissive Storage INSERT policies:
-- permissive policies combine with OR, and can bypass this restriction.

-- The bucket must already exist. Keep it private and limit uploads to MP4/100 MiB.
update storage.buckets
set public = false,
    file_size_limit = 104857600,
    allowed_mime_types = array['video/mp4']::text[]
where id = 'kora-wall-media';

-- The client must never directly control consent/approval metadata.
alter table public.kora_wall_ball_videos enable row level security;
revoke insert, update, delete on public.kora_wall_ball_videos from anon, authenticated;

-- The Storage INSERT policy calls this function to authorize a proposed path.
-- app_metadata is set by a Supabase administrator, never by the participant.
create or replace function public.kora_can_upload_wall_ball(p_path text)
returns boolean
language plpgsql
security definer
set search_path = ''
stable
as $kora$
declare
  v_event text;
begin
  if auth.uid() is null then
    return false;
  end if;

  if coalesce(auth.jwt() -> 'app_metadata' ->> 'kora_wall_operator', 'false') <> 'true' then
    return false;
  end if;

  -- Only balls/<event-slug>/<random-v4-uuid>.mp4 (bucket-relative).
  if p_path !~ '^balls/[A-Za-z0-9_-]{1,64}/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}[.]mp4$' then
    return false;
  end if;

  v_event := split_part(p_path, '/', 2);
  if not (
    coalesce(auth.jwt() -> 'app_metadata' -> 'kora_wall_events', '[]'::jsonb)
    ? v_event
  ) then
    return false;
  end if;

  -- Best-effort 12-per-hour operator quota. For strict/concurrent limits,
  -- use a trusted rate-limited service or transactional counter.
  if (
    select count(*)
    from storage.objects
    where bucket_id = 'kora-wall-media'
      and owner_id = auth.uid()::text
      and created_at >= now() - interval '1 hour'
  ) >= 12 then
    return false;
  end if;

  return true;
end;
$kora$;

revoke all on function public.kora_can_upload_wall_ball(text) from public;
grant execute on function public.kora_can_upload_wall_ball(text) to authenticated;

drop policy if exists "kora_wall_operator_mp4_insert" on storage.objects;
create policy "kora_wall_operator_mp4_insert"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'kora-wall-media'
  and public.kora_can_upload_wall_ball(name)
);

-- Called after successful browser-to-Storage upload. No client approval/consent
-- arguments; registration always sets true/false under a trusted SQL function.
create or replace function public.register_kora_wall_ball_video(p_storage_path text)
returns void
language plpgsql
security definer
set search_path = ''
as $kora$
declare
  v_storage storage.objects%rowtype;
begin
  -- Do NOT call kora_can_upload_wall_ball here: its hourly quota already
  -- counts the newly uploaded object, so doing so would reject the 12th upload.
  if auth.uid() is null
    or coalesce(auth.jwt() -> 'app_metadata' ->> 'kora_wall_operator', 'false') <> 'true'
    or p_storage_path !~ '^balls/[A-Za-z0-9_-]{1,64}/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}[.]mp4$'
    or not (
      coalesce(auth.jwt() -> 'app_metadata' -> 'kora_wall_events', '[]'::jsonb)
      ? split_part(p_storage_path, '/', 2)
    )
  then
    raise exception 'Unauthorized event video registration' using errcode = '42501';
  end if;

  -- Confirm the authenticated operator owns this exact Storage object.
  select * into v_storage
  from storage.objects
  where bucket_id = 'kora-wall-media' and name = p_storage_path
  for update;

  if not found or v_storage.owner_id is distinct from auth.uid()::text then
    raise exception 'MP4 object not found or not owned by operator' using errcode = '42501';
  end if;

  if coalesce(v_storage.metadata ->> 'mimetype', '') <> 'video/mp4'
    or coalesce((v_storage.metadata ->> 'size')::bigint, 0) <= 0
    or coalesce((v_storage.metadata ->> 'size')::bigint, 0) > 104857600
  then
    raise exception 'MP4 metadata outside bucket constraints' using errcode = '22023';
  end if;

  -- The wall must NOT show videos until a trusted moderation/validation process
  -- has independently checked the MP4 bytes and changed approved to true.
  insert into public.kora_wall_ball_videos
    (storage_path, event_screen_consent, approved)
  values
    (p_storage_path, true, false);
  -- uploaded_at uses the database column default.
end;
$kora$;

revoke all on function public.register_kora_wall_ball_video(text) from public;
grant execute on function public.register_kora_wall_ball_video(text) to authenticated;

-- A browser-supplied content-type isn't proof of valid H.264 MP4 bytes.
-- A trusted validator/moderator must check or transcode before approval.
-- Arrange privileged cleanup of unregistered orphan Storage objects.
