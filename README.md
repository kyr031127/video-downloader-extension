# Video Downloader

A personal Chrome extension that detects video sources on web pages.

## Features
- Detects HTML5 <video> and <source> elements
- Finds direct links to video files
- Scans browser performance entries for video-related resources
- Supports common video formats: MP4, WebM, MOV, M4V, OGV
- Detects HLS (`.m3u8`) and DASH (`.mpd`) streams

## Limitations
- Direct HTTP/HTTPS video files can be downloaded using Chrome Downloads.
- HLS and DASH streams can be detected, but this version does not combine their segments into a playable video file.
- Blob and data URLs can be detected, but cannot be downloaded directly.
- DRM-protected or encrypted streams are not supported.
- The extension does not bypass paywalls, authentication requirements, or website restrictions.
- Some websites use custom players, Media Source Extensions, service workers, or other methods that may prevent video detection.

Video detection depends on how each website delivers its media, so not every video will be detected.

## Permissions
- `downloads`: Used to download video files.
- `tabs`: Used to identify the current browser tab.
- `activeTab`: Used to access the active tab.
- `<all_urls>` Allows the extension to detect media on different websites.

## Development Notes
This extension is built with Chrome Manifest V3.

To test changes, reload the extension from chrome://extensions and refresh the page being tested.