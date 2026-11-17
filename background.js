// ========================================
// Media Storage & Constants
// ========================================

const tabMedia = new Map();
const knownVariantUrls = new Set();

// The service worker can be killed at any time: restore what we know on start
const stateReady = chrome.storage.session
  .get("known_variants")
  .then(r => (r.known_variants || []).forEach(u => knownVariantUrls.add(u)))
  .catch(() => {});

const MEDIA_MIME_REGEX =
  /(video\/|application\/vnd\.apple\.mpegurl|application\/x-mpegurl|audio\/mpegurl|application\/dash\+xml)/i;

const MEDIA_EXT_REGEX =
  /\.(mp4|webm|mov|m4v|ogv|m3u8|mpd)(?:$|[?#])/i;

const IGNORE_EXT_REGEX =
  /\.(ts|m4s|fmp4|aac|mp3|vtt|srt|jpg|jpeg|png|webp|gif|json|js|css)(?:$|[?#])/i;

// DASH manifests served without ".mpd" / a DASH content-type (e.g. CHZZK VOD)
const DASH_URL_HINT_REGEX = /\/neonplayer\/vodplay\/.*playback\//i;
const XML_MANIFEST_HINT_REGEX = /(mpd|manifest|playback|dash)/i;

const DIRECT_EXT = { MP4: "mp4", WEBM: "webm", MOV: "mov", M4V: "m4v", OGV: "ogv" };


// ========================================
// Media Normalization
// ========================================

function normalizeMedia(item) {
  if (!item || typeof item.url !== "string") return null;

  let url;
  try {
    url = new URL(item.url);
  } catch {
    return null;
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    return null;
  }

  const type = (item.type || "").toLowerCase();
  const path = url.pathname.toLowerCase();

  let format = "Unknown";

  if (path.endsWith(".m3u8") || type.includes("mpegurl")) {
    format = "HLS";
  } else if (
    path.endsWith(".mpd") ||
    type.includes("dash") ||
    DASH_URL_HINT_REGEX.test(url.href) ||
    (type.includes("xml") && XML_MANIFEST_HINT_REGEX.test(path))
  ) {
    format = "DASH";
  } else if (path.endsWith(".mp4") || type.includes("mp4")) {
    format = "MP4";
  } else if (path.endsWith(".webm") || type.includes("webm")) {
    format = "WebM";
  } else if (path.endsWith(".mov") || type.includes("quicktime")) {
    format = "MOV";
  } else if (path.endsWith(".m4v")) {
    format = "M4V";
  } else if (path.endsWith(".ogv") || type.includes("ogg")) {
    format = "OGV";
  } else if (type.startsWith("video/") && !type.includes("mp2t")) {
    format = type.split("/")[1]?.toUpperCase() || "VIDEO";
  }

  if (format === "Unknown") {
    return null;
  }

  const stream = ["HLS", "DASH"].includes(format);
  const direct = !stream;

  let name = "video";
  try {
    name = decodeURIComponent(url.pathname.split("/").pop() || "") || "video";
  } catch {
    name = url.pathname.split("/").pop() || "video";
  }

  return {
    url: item.url,
    type,
    format,
    title: item.title || name,
    source: item.source || "Network stream",
    tabId: item.tabId,
    frameUrl: item.frameUrl || "",
    variants: item.variants || null,
    direct,
    stream,
    seenAt: Date.now()
  };
}


// ========================================
// Shared Storage Helper
//
// Every detection runs through a per-tab queue. Without it, a master
// playlist and its variant playlists were processed concurrently from the
// same stale snapshot, so one overwrote the other (lost qualities / audio).
// ========================================

const tabQueues = new Map();

function enqueueForTab(tabId, task) {
  const previous = tabQueues.get(tabId) || Promise.resolve();
  const next = previous.then(task, task);
  tabQueues.set(tabId, next.catch(() => {}));
  return next;
}

async function getTabMedia(tabId) {
  if (tabMedia.has(tabId)) return tabMedia.get(tabId);

  const key = `tab_${tabId}`;
  const result = await chrome.storage.session.get(key);
  const data = result[key] || [];
  tabMedia.set(tabId, data);
  return data;
}

function saveMediaItems(tabId, rawItems, defaultFrameUrl = "") {
  if (tabId == null || tabId < 0) return Promise.resolve(0);
  return enqueueForTab(tabId, () => saveMediaItemsNow(tabId, rawItems, defaultFrameUrl));
}

async function saveMediaItemsNow(tabId, rawItems, defaultFrameUrl) {
  await stateReady;
  const current = await getTabMedia(tabId);

  const incoming = (rawItems || [])
    .map(item =>
      normalizeMedia({
        ...item,
        tabId,
        frameUrl: item.frameUrl || defaultFrameUrl
      })
    )
    .filter(item => item && !knownVariantUrls.has(item.url));

  if (!incoming.length) return current.length;

  const mediaMap = new Map(current.map(item => [item.url, item]));
  let knownChanged = false;

  for (const item of incoming) {
    if (mediaMap.has(item.url) || knownVariantUrls.has(item.url)) continue;

    if (item.format === "HLS" && !item.variants) {
      const variants = await parseHlsVariants(item.url);

      if (variants.length > 0) {
        item.hlsKind = "master";
        item.variants = variants;

        for (const v of variants) {
          for (const u of [v.url, v.audioUrl]) {
            if (!u) continue;
            knownVariantUrls.add(u);
            mediaMap.delete(u); // drop variant playlists seen before the master
          }
        }
        knownChanged = true;
      } else {
        item.hlsKind = "media";

        // A master playlist already covers this stream: hide stray variant playlists
        const hasMaster = [...mediaMap.values()].some(i => i.hlsKind === "master");
        if (hasMaster) {
          knownVariantUrls.add(item.url);
          knownChanged = true;
          continue;
        }

        const qMatch = item.url.match(/(\d{3,4}p)/i);
        item.variants = [
          { label: qMatch ? qMatch[1] : "Default", url: item.url, audioUrl: "" }
        ];
      }
    }

    if (item.format === "DASH" && !item.variants) {
      try {
        const parsed = await parseDashInOffscreen(item.url);
        item.variants = parsed.variants?.length ? parsed.variants : null;
      } catch (err) {
        // Not actually an MPD (false positive from the URL/XML hints): ignore
        if (/Not a valid MPD/i.test(err.message)) continue;
        item.variants = null;
      }
    }

    mediaMap.set(item.url, item);
  }

  // Once a master playlist exists, single-track playlists are just its parts
  if ([...mediaMap.values()].some(i => i.hlsKind === "master")) {
    for (const [url, i] of mediaMap) {
      if (i.hlsKind === "media") mediaMap.delete(url);
    }
  }

  const updated = [...mediaMap.values()].slice(-250);
  tabMedia.set(tabId, updated);

  const toStore = { [`tab_${tabId}`]: updated };
  if (knownChanged) toStore.known_variants = [...knownVariantUrls].slice(-2000);
  await chrome.storage.session.set(toStore);

  return updated.length;
}


// ========================================
// Network Stream Sniffer (webRequest)
// ========================================

chrome.webRequest.onHeadersReceived.addListener(
  details => {
    if (details.tabId < 0) return;
    if (IGNORE_EXT_REGEX.test(details.url)) return;

    const contentTypeHeader = details.responseHeaders?.find(
      h => h.name.toLowerCase() === "content-type"
    );
    const contentType = contentTypeHeader?.value || "";

    if (contentType.toLowerCase().includes("video/mp2t")) return;

    const isMediaMime = MEDIA_MIME_REGEX.test(contentType);
    const isMediaExt = MEDIA_EXT_REGEX.test(details.url);
    const isDashHint = DASH_URL_HINT_REGEX.test(details.url);
    const isXmlManifest =
      /xml/i.test(contentType) && XML_MANIFEST_HINT_REGEX.test(details.url);

    if (isMediaMime || isMediaExt || isDashHint || isXmlManifest) {
      saveMediaItems(details.tabId, [
        {
          url: details.url,
          type: contentType,
          source: "Network stream",
          frameUrl: details.initiator || details.documentUrl || ""
        }
      ]).catch(() => {});
    }
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"]
);


// ========================================
// HLS Master Playlist Parser
// ========================================

async function parseHlsVariants(masterUrl) {
  try {
    const res = await fetch(masterUrl);
    if (!res.ok) return [];

    const text = await res.text();
    if (!text.includes("#EXT-X-STREAM-INF")) return [];

    const lines = text.split(/\r?\n/);

    // Separate audio renditions: GROUP-ID -> playlist URL
    const audioGroups = new Map();
    for (const raw of lines) {
      const line = raw.trim();
      if (!line.startsWith("#EXT-X-MEDIA:") || !/TYPE=AUDIO/i.test(line)) continue;

      const group = line.match(/GROUP-ID="([^"]+)"/i)?.[1];
      const uri = line.match(/URI="([^"]+)"/i)?.[1];
      if (!group || !uri) continue;

      const isDefault = /DEFAULT=YES/i.test(line);
      const prev = audioGroups.get(group);
      if (!prev || (isDefault && !prev.isDefault)) {
        audioGroups.set(group, { url: new URL(uri, masterUrl).href, isDefault });
      }
    }

    const variants = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line.startsWith("#EXT-X-STREAM-INF:")) continue;

      const resMatch = line.match(/RESOLUTION=(\d+)x(\d+)/i);
      const bwMatch = line.match(/BANDWIDTH=(\d+)/i);
      const fpsMatch = line.match(/FRAME-RATE=([\d.]+)/i);
      const audioGroup = line.match(/AUDIO="([^"]+)"/i)?.[1];

      let streamUrl = "";
      for (let j = i + 1; j < lines.length; j++) {
        const nextLine = lines[j].trim();
        if (nextLine && !nextLine.startsWith("#")) {
          streamUrl = new URL(nextLine, masterUrl).href;
          i = j;
          break;
        }
      }

      if (!streamUrl) continue;

      const height = resMatch ? Number(resMatch[2]) : 0;
      const bandwidth = bwMatch ? Number(bwMatch[1]) : 0;
      const fps = fpsMatch ? Math.round(Number(fpsMatch[1])) : 0;
      const audioUrl = audioGroup ? audioGroups.get(audioGroup)?.url || "" : "";

      let label = "Auto";
      if (height > 0) {
        label = `${height}p${fps >= 50 ? fps : ""}`;
      } else if (bandwidth > 0) {
        label = `${Math.round(bandwidth / 1000)} kbps`;
      }

      variants.push({ label, height, bandwidth, url: streamUrl, audioUrl });
    }

    variants.sort((a, b) => b.height - a.height || b.bandwidth - a.bandwidth);

    const unique = [];
    const seenLabels = new Set();
    for (const v of variants) {
      if (!seenLabels.has(v.label)) {
        seenLabels.add(v.label);
        unique.push(v);
      }
    }

    return unique;
  } catch {
    return [];
  }
}


// ========================================
// Offscreen Document (segment download + muxing happen there)
// ========================================

let creatingOffscreen = null;

async function ensureOffscreenDocument() {
  const offscreenUrl = chrome.runtime.getURL("offscreen.html");
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [offscreenUrl]
  });

  if (existingContexts.length > 0) return;

  // Concurrent callers must share one createDocument() call
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen
      .createDocument({
        url: "offscreen.html",
        reasons: ["BLOBS"],
        justification: "Download HLS/DASH segments and merge them into a downloadable Blob"
      })
      .finally(() => {
        creatingOffscreen = null;
      });
  }

  await creatingOffscreen;
}

async function sendToOffscreen(payload) {
  const response = await chrome.runtime.sendMessage({
    target: "offscreen",
    ...payload
  });

  if (!response?.ok) throw new Error(response?.error || "Offscreen task failed.");
  return response;
}

async function parseDashInOffscreen(mpdUrl) {
  await ensureOffscreenDocument();
  return sendToOffscreen({ type: "PARSE_MPD", mpdUrl });
}


// ========================================
// Stream Downloader
// ========================================

async function saveBlobAsFile(blobUrl, filename) {
  const downloadId = await chrome.downloads.download({
    url: blobUrl,
    filename,
    conflictAction: "uniquify",
    saveAs: false
  });

  // Free the Blob in the offscreen document once the download finishes
  const onChanged = delta => {
    if (delta.id !== downloadId || !delta.state) return;
    const s = delta.state.current;
    if (s === "complete" || s === "interrupted") {
      chrome.downloads.onChanged.removeListener(onChanged);
      chrome.runtime
        .sendMessage({ target: "offscreen", type: "REVOKE_BLOB", blobUrl })
        .catch(() => {});
    }
  };
  chrome.downloads.onChanged.addListener(onChanged);

  return downloadId;
}

async function downloadStream(jobId, source, title) {
  await ensureOffscreenDocument();

  const base = safeBase(title);
  const res = await sendToOffscreen({ type: "DOWNLOAD_TRACKS", jobId, source });

  const warnings = [];
  if (res.failed > 0) {
    warnings.push(
      `${res.failed} segment(s) failed to download (${res.firstError}); the file may have gaps.`
    );
  }

  // One file (single track, or video+audio merged by ffmpeg)
  if (res.blobUrl) {
    const downloadId = await saveBlobAsFile(res.blobUrl, `${base}.${res.ext}`);
    return { downloadId, warning: warnings.join(" ") || undefined };
  }

  // Fallback: ffmpeg unavailable -> save the two tracks separately
  const downloadId = await saveBlobAsFile(res.video.blobUrl, `${base}.${res.video.ext}`);
  await saveBlobAsFile(res.audio.blobUrl, `${base}_audio.${res.audio.ext}`);

  warnings.push(
    `Could not merge audio into the video (${res.muxError}). ` +
      `Saved video and audio as separate files.`
  );

  return { downloadId, warning: warnings.join(" ") };
}


// ========================================
// Runtime Message Handler
// ========================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target === "offscreen") return false;

  if (message?.type === "MEDIA_FOUND") {
    const tabId = sender.tab?.id ?? message.tabId;
    if (tabId == null) {
      sendResponse({ ok: false });
      return false;
    }

    saveMediaItems(tabId, message.items, sender.url || "")
      .then(count => sendResponse({ ok: true, count }))
      .catch(() => sendResponse({ ok: false }));

    return true;
  }

  if (message?.type === "GET_MEDIA") {
    const tabId = message.tabId;

    getTabMedia(tabId)
      .then(items => sendResponse({ items }))
      .catch(() => sendResponse({ items: [] }));

    return true;
  }

  if (message?.type === "DOWNLOAD_MEDIA") {
    const item = message.item;
    const variant = message.variant || null;
    const targetUrl = message.variantUrl || item?.url;

    if (!item || !targetUrl) {
      sendResponse({ ok: false, error: "Invalid media item." });
      return false;
    }

    if (item.format === "HLS" || item.format === "DASH") {
      const source =
        item.format === "HLS"
          ? { kind: "hls", videoUrl: targetUrl, audioUrl: message.audioUrl || "" }
          : {
              kind: "dash",
              mpdUrl: item.url,
              videoRepId: variant?.repId || "",
              audioRepId: variant?.audioRepId || ""
            };

      downloadStream(message.jobId || targetUrl, source, message.filename || item.title)
        .then(r => sendResponse({ ok: true, downloadId: r.downloadId, warning: r.warning }))
        .catch(err => sendResponse({ ok: false, error: err.message }));

      return true;
    }

    if (item.direct) {
      const ext = DIRECT_EXT[(item.format || "").toUpperCase()] || "mp4";
      const filename = `${safeBase(message.filename || item.title)}.${ext}`;

      chrome.downloads.download(
        {
          url: targetUrl,
          filename,
          conflictAction: "uniquify",
          saveAs: Boolean(message.saveAs)
        },
        downloadId => {
          if (chrome.runtime.lastError) {
            sendResponse({
              ok: false,
              error: chrome.runtime.lastError.message
            });
          } else {
            sendResponse({ ok: true, downloadId });
          }
        }
      );
      return true;
    }

    sendResponse({ ok: false, error: "Unsupported media type." });
    return false;
  }

  if (message?.type === "CLEAR_TAB") {
    const tabId = message.tabId;
    tabMedia.delete(tabId);
    chrome.storage.session.remove(`tab_${tabId}`);
    sendResponse({ ok: true });
    return false;
  }

  return false;
});


// ========================================
// Filename Utilities & Tab Lifecycle
// ========================================

// Returns a filesystem-safe base name WITHOUT extension
function safeBase(name) {
  return (
    String(name || "video")
      .replace(/\.(m3u8|mpd|mp4|webm|mov|m4v|ogv|ts)$/i, "")
      .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
      .replace(/\s+/g, " ")
      .replace(/[. ]+$/, "")
      .trim()
      .slice(0, 150) || "video"
  );
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading" && changeInfo.url) {
    tabMedia.delete(tabId);
    chrome.storage.session.remove(`tab_${tabId}`);
  }
});

chrome.tabs.onRemoved.addListener(tabId => {
  tabMedia.delete(tabId);
  tabQueues.delete(tabId);
  chrome.storage.session.remove(`tab_${tabId}`);
});