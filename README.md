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
