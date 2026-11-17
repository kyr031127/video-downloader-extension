# Video Downloader

A Chrome Manifest V3 extension that scans ordinary web pages for HTML5 video sources and video-like network resources.

## Supported detection
- HTML5 `<video>`, `<source>` and direct video links
- Resource Performance API entries ending in common video extensions
- MP4, WebM, MOV, M4V, OGV
- HLS (`.m3u8`) and DASH (`.mpd`) manifest detection

## Download limitations
- Direct HTTP/HTTPS video files can be sent to Chrome Downloads.
- HLS/DASH manifests are detected but this build does not assemble segments into a playable file.
- Blob/data URLs are shown but cannot be downloaded directly by the background worker.
- DRM, encrypted streams, paywalls, authentication restrictions and site protections are not bypassed.
- Some sites hide media behind signed requests, Media Source Extensions, service workers, cross-origin restrictions, or custom players. Detection is best-effort, not universal.
- The extension does not intercept or modify network traffic and does not upload browsing data.

## Permissions
- `downloads`: start direct downloads
- `tabs`, `activeTab`: identify the current tab
- `<all_urls>` host access: run the detector on pages across sites

## Troubleshooting
If the extension does not detect a video, reload the page after installing the extension and play the video. Chrome internal pages, Chrome Web Store pages, and some protected frames cannot run content scripts.
