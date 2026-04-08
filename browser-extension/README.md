# QuickAsset Browser Extension

This extension works on both Chrome and Edge (Chromium).

## What It Does

- Right-click any image on a webpage.
- Click `添加到 QuickAsset`.
- The image is sent to local QuickAsset endpoint: `http://127.0.0.1:27124/api/import-image`.
- If the configured endpoint is unavailable, extension will auto-discover QuickAsset service on common localhost ports via `/health` and retry.
- If URL-based import fails (proxy/cookie/referer/network differences), extension will fetch image bytes in browser and upload to local fallback endpoint.
- QuickAsset downloads and indexes the file into the currently opened library.

## Install (Developer Mode)

1. Open `chrome://extensions` or `edge://extensions`.
2. Enable `Developer mode`.
3. Click `Load unpacked`.
4. Select this folder: `browser-extension`.

## Requirements

- QuickAsset desktop app must be running.
- A QuickAsset library must be open.
- QuickAsset desktop app must expose web import service on localhost (default `127.0.0.1:27124`).
- Extension host permissions include `http://*/*` and `https://*/*` so background worker can fetch original image bytes for fallback upload.

## Optional Auth Token

If you set environment variable `QUICKASSET_WEB_IMPORT_TOKEN` for the QuickAsset process, configure the same token in extension options:

1. Open extension details.
2. Enter options page.
3. Fill `鉴权 Token`.
4. Save.
