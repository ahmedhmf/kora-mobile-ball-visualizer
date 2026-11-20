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

## Automatic public-read MP4 uploads without login or manual approval

Once a KORA 3D ball finishes loading its artwork, the frontend automatically
renders an 8-second, portrait 720×1280 H.264 MP4. It requests an upload ticket
from the Supabase Edge Function `kora-wall-ticket`, uploads the MP4 **directly
to Storage** using a signed, single-object upload URL, and completes the ticket.
The Edge Function performs best-effort MP4 format checks and then registers a
wall metadata row with `event_screen_consent=true` and `approved=true`.
No login, consent checkbox, operator field, upload button, or manual approval
is required. The separate MP4 download button remains available.

**Public means public:** Bucket `kora-wall-media` is public-read, so anyone
with the object URL can watch the video. The wall's approval flag no longer
provides privacy or content review. This is appropriate only for non-identifiable,
authorized promotional artwork. Do not use this setup for participant media
without appropriate permission.

### Deployment setup (required before uploads work)

1. Configure `public/kora-wall-config.json` with your Supabase URL and **public**
   publishable key (not a service-role/secret key).
2. Run [`supabase/automatic-wall-upload.sql`](supabase/automatic-wall-upload.sql)
   in Supabase SQL Editor. It configures the public-read bucket and server-only
   ticket reservation/completion RPCs. Audit and remove other permissive
   Storage INSERT policies; no anonymous direct write policy is required.
3. Deploy [`supabase/functions/kora-wall-ticket/index.ts`](supabase/functions/kora-wall-ticket/index.ts)
   as a Supabase Edge Function called `kora-wall-ticket` with JWT verification
   disabled (it intentionally has no user login).
4. Set its **private Supabase Edge Function secrets**:
   `SUPABASE_SERVICE_ROLE_KEY` (server only),
   `KORA_EVENT_SLUG` (e.g. `event-1`),
   `KORA_RATE_SALT` (long random server-side string), and
   `KORA_ALLOWED_ORIGINS` (comma-separated HTTPS frontend origins).
   Supabase supplies `SUPABASE_URL`. Never publish the server secret.
5. Test one MP4 end to end. The function must be reachable at
   `https://YOUR-PROJECT.supabase.co/functions/v1/kora-wall-ticket`.
   The Angular app derives this URL automatically from `supabaseUrl`.

**Security:** The ticket endpoint is deliberately public and uses IP/global
quotas, an origin allowlist, unpredictable paths and one-use signed upload
credentials. Origin and IP headers are not authentication; put a bot-management
or verified-client challenge in front of the function for an unattended public
event. The MP4 structural parser is not a substitute for full decoding,
security scanning, or content moderation. Automatic approval means unsuitable
or forged-but-structurally-valid clips may appear on the TV. Use trusted
transcoding or abuse screening if this is a public-facing production event.
Unregistered objects and expired tickets need a privileged cleanup job.

The legacy `supabase/direct-wall-upload.sql` is deprecated for this mode.
