# KORA Mobile Ball Visualizer — Angular Scanner

Angular mobile-first prototype for scanning a printed KORA A3 sheet, preparing a **continuous 1024 × 1024 UV atlas**, and viewing it on the exact KORA 32-panel OBJ.

## Start

Requires a supported recent Node.js release and a browser with WebGL.

```bash
npm install
npm start
```

For production compilation:

```bash
npm run build
```

Camera capture requires localhost or HTTPS in the browser.

## What is included

- Angular standalone application with scan, capture, review, processing, and interactive Babylon.js viewer screens.
- Rear-facing camera request, full intrinsic-frame capture, media-track cleanup, and photo/PDF fallback.
- Imported original PDF rasterizer, paper straightener and worker, 32-panel registration, and KORA UV alignment from the pinned read-only reference.
- Distinct UV-ready 1024 × 1024 import; scans always use the original 1:1 preparation pipeline.
- Babylon.js texture uses `invertY: true` as in the reference.
- Progressive status and recoverable review screen on processing failure.
- Web app manifest and SVG icon.

## Known outstanding work

This is a **first implementation**, not a verified full scanner release.

1. The exact OBJ is **33 MB**. The new viewer currently fetches it from the pinned reference repository at runtime. Copy `public/3d-models/32-CLB.obj` from [the reference commit](https://github.com/ahmedhmf/kora-ball-viewer/tree/08c7765525aa8692b207d535b6cfce9027e6c345) into this repository, change the `url` in `src/app/ball-viewer.component.ts` to `new URL('3d-models/32-CLB.obj', document.baseURI).toString()`, and validate texture parity before shipping. An offline build cannot rely on GitHub's raw endpoint.
2. The inherited page detector was tailored to the older WhatsApp image. Add a general four-corner page detector and an optional manual page-corner correction.
3. A manifest is present; **a production service worker, offline behavior and iOS/Android install testing are not implemented yet**.
4. Test with the known-good 1024 JPEG, original A3 WhatsApp PDF and real phone photos upright/upside-down, including seam checks on the Emam Ashour and Foden panels. The fixture files from the handoff were not attached here.
5. Build success and camera/model behavior have not been independently verified in this environment. A GitHub Actions build check is provided to surface integration errors.

## Reference

The working source remains unchanged:
[ahmedhmf/kora-ball-viewer at 08c7765525aa8692b207d535b6cfce9027e6c345](https://github.com/ahmedhmf/kora-ball-viewer/tree/08c7765525aa8692b207d535b6cfce9027e6c345).

The image-preparation services and paper worker were copied from that pinned source. The only substantive edits in those reference files are base-path-relative URLs for the PDF and paper workers.

## Rotating MP4 export

After an artwork atlas has loaded on the ball, choose **Download rotating MP4**. The viewer renders a deterministic, silent **8-second 1280 × 720 (16:9), 30 FPS H.264 MP4** with a full 360° horizontal turn and a gentle tilt. The existing on-screen orbit is restored afterward. Export uses the browser's WebCodecs `VideoEncoder` and the `mp4-muxer` MP4 container library; it doesn't upload artwork to a server. On unsupported browsers/devices (including those without H.264 WebCodecs encoding), export shows an explicit error rather than generating a mislabeled file. Keep the app foregrounded until the download starts. Real-device export compatibility and Instagram upload have not yet been verified.

## Instagram Reel branding

The export is now **720 × 1280 (9:16)**, 30 fps, 8 seconds, H.264 MP4. A deterministic smoke overlay drifts around the model, and a compact vector tracing of the uploaded KORA wordmark appears centered at the top over a pale backing panel (the supplied logo has black lettering). The smoke and branding are applied only in the export compositor, not to the source artwork or UV atlas. The portrait output is silent. The original full-resolution logo remains in the chat attachment; the repository contains a scaled vector trace for predictable mobile rendering.

## KORA brand palette

The app UI, loading indicators, camera guide, decorative ball preview, PWA icon, and video-export environment now use KORA black and brand red **#FF0006**. Previous green radial gradients, glow, and smoke are replaced with equivalent red-toned effects. White logo and user-uploaded artwork/UV atlas remain unchanged.

## Application branding assets

The mobile header uses the existing transparent white KORA logo at `public/branding/kora-wordmark.svg`. The welcome screen uses a lightweight WebP copy of the supplied white/red/black KORA ball at `public/branding/kora-home-ball.webp` (240 × 240 pixels), replacing the illustrative CSS sphere. The 3D model/texture pipeline and MP4 export remain unchanged.

## Direct-to-Supabase MP4 uploads

The **finished 9:16 H.264 MP4** is uploaded **directly from Angular to the private Supabase Storage bucket** `kora-wall-media`; no Node server or upload endpoint is required. The app uploads **MP4 only**, never the scanned image, PDF or UV atlas. `Download MP4` stays available without publishing.

### Supabase setup (required)

1. Create/verify a **private** bucket `kora-wall-media`; its size limit is **100 MiB**, MIME allowance `video/mp4`.
2. In **Supabase Dashboard → SQL Editor**, run [`supabase/direct-wall-upload.sql`](supabase/direct-wall-upload.sql). It installs a narrowly scoped `storage.objects` INSERT policy for authenticated event operators and an authenticated, server-executed `register_kora_wall_ball_video` RPC that verifies the uploaded object and writes the metadata record.
3. Configure [`public/kora-wall-config.json`](public/kora-wall-config.json) with **only** the project URL and public/publishable key:

   ```json
   {
     "supabaseUrl": "https://YOUR-PROJECT.supabase.co",
     "supabasePublishableKey": "YOUR_PUBLIC_PUBLISHABLE_KEY"
   }
   ```

4. In Supabase Auth, use administrator-only tooling to set the authenticated operator's `app_metadata`: `{"kora_wall_operator":true,"kora_wall_events":["event-1"]}`. Sign in again to refresh JWT claims. Event slugs must contain only letters, digits, `_` or `-`.
5. Ensure `public.kora_wall_ball_videos` has the original columns, unique `storage_path`, and a default `uploaded_at` timestamp. Verify moderation and wall feed are active.

### Security and moderation

The browser generates `balls/<event-slug>/<random-v4-uuid>.mp4` and calls `supabase.storage.from('kora-wall-media').upload(path, mp4, {contentType:'video/mp4',upsert:false})`. After Storage confirms success, it calls `supabase.rpc('register_kora_wall_ball_video',{p_storage_path:path})`. **Both** the operator/event restrictions and the values `event_screen_consent=true, approved=false` are enforced by database code, never trusted from the browser. This is an authorized non-live promotional workflow; the consent flag here is not evidence of participant permission.

**Important security difference:** Pure browser-to-Storage uploads cannot provide trusted FFmpeg/FFprobe validation or transcoding. The SQL function verifies object existence, ownership, MIME, size and path, but **not actual codec or MP4 bytes**. Keep uploaded objects `approved=false` until a trusted moderation/validation worker or operator checks/re-encodes H.264/yuv420p and faststart. A malformed or spoofed client upload must never become wall-visible solely because the MIME says `video/mp4`. Schedule privileged cleanup for failed registration orphans. Audit other Storage INSERT policies: permissive RLS policies are OR-combined, so any broad existing upload policy must be removed or narrowed.

Never put a service-role/secret key in the frontend. Anonymous visitors cannot upload without authorization; only the published key and authenticated operator session are used. For production scale, enforce stronger per-event/user rate limits and object cleanup/validation.
