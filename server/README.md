# Trusted KORA wall MP4 upload server

This is a **separate Node.js deployment**, not an API route served by Angular. Do not expose its environment to the public browser.

### Setup
1. Deploy an HTTPS-capable Node.js 20+ host with **FFmpeg and FFprobe** installed.
2. Copy `.env.example` to host environment variables and securely configure `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `KORA_EVENT_SLUGS`, and `ALLOWED_ORIGINS`. Never commit the secret.
3. Install with `cd server && npm install`, then `npm start`. Terminate TLS at a trusted reverse proxy.
4. In Supabase Auth, an administrator must set `app_metadata.kora_wall_operator=true and app_metadata.kora_wall_events=['event-1']` on approved operator accounts. This is NOT user_metadata, which users can edit. Do not allow participants direct upload without a separate authorized participant policy.
5. Make the private `kora-wall-media` bucket exist with a 100 MiB limit and `video/mp4` MIME allowance. Ensure `public.kora_wall_ball_videos` exists and has a default `uploaded_at` timestamp. Keep the wall-feed and moderation logic independent.
6. Set the Angular public runtime configuration file `public/kora-wall-config.json` with public project URL, public anon/publishable key, and the externally accessible HTTPS `uploadEndpoint` (`https://your-server/api/wall/balls`). This file must NOT contain the service role key.

The upload route requires a valid operator Supabase Auth bearer token with administrator-set membership for the specific event. It limits request size (100 MiB), enforces an event allowlist and safe slug, checks actual MP4 bytes with ffprobe, transcodes with H.264/`yuv420p`/`faststart`, uploads with a UUID path and `upsert:false`, and inserts metadata **only after** Storage success.

### Moderation
An operator attests to explicitly received TV-display permission via a separate UI checkbox. The server records `event_screen_consent=true`, `approved=false`. **No client input sets approval**. The existing trusted moderation process must later set `approved=true` before the wall feed includes it. If display consent is refused, do not upload.

### Operational controls
- This starter uses an in-memory per-IP rate limiter and an in-process concurrency limit. For horizontally scaled production, replace with shared Redis-backed quotas keyed by verified operator and event, plus a global quota.
- Configure monitoring, cleanup of orphaned private objects, security logs without participant data, abuse protection, and credential rotation.
- The upload route is deliberately operator-only. Anonymous public PWA submissions require an additional protected event-specific participation authorization mechanism; do not remove the role check.
- The Angular app and server are deployed separately. The default public config intentionally leaves publishing disabled until credentials and endpoint are configured.
