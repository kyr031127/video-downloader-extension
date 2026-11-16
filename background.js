
// ========================================
// Media Storage
// ========================================

const tabMedia = new Map();


// ========================================
// Media Normalization
// ========================================

function normalizeMedia(item) {
  if (!item || typeof item.url !== "string") {
    return null;
  }

  let url;

  try {
    url = new URL(item.url);
  } catch {
    return null;
  }

  const allowedProtocols = [
    "http:",
    "https:",
    "blob:",
    "data:"
  ];

  if (!allowedProtocols.includes(url.protocol)) {
    return null;
  }

  const type = (item.type || "").toLowerCase();
  const path = url.pathname.toLowerCase();

  // Detect video format
  let format = "Unknown";

  if (path.endsWith(".mp4") || type.includes("mp4")) {
    format = "MP4";
  } else if (path.endsWith(".webm") || type.includes("webm")) {
    format = "WebM";
  } else if (path.endsWith(".mov") || type.includes("quicktime")) {
    format = "MOV";
  } else if (path.endsWith(".m3u8") || type.includes("mpegurl")) {
    format = "HLS";
  } else if (path.endsWith(".mpd") || type.includes("dash")) {
    format = "DASH";
  } else if (path.endsWith(".m4v")) {
    format = "M4V";
  } else if (path.endsWith(".ogv") || type.includes("ogg")) {
    format = "OGV";
  }

  // Determine download type
  const stream = ["HLS", "DASH"].includes(format);

  const direct =
    ["http:", "https:"].includes(url.protocol) &&
    !stream;

  const blob =
    url.protocol === "blob:" ||
    url.protocol === "data:";

  // Extract filename
  let name = "video";

  try {
    name = decodeURIComponent(
      url.pathname.split("/").pop() || ""
    ) || "video";
  } catch {
    name = url.pathname.split("/").pop() || "video";
  }

  return {
    url: item.url,
    type,
    format,
    title: item.title || name,
    source: item.source || "Page resource",
    tabId: item.tabId,
    frameUrl: item.frameUrl || "",
    direct,
    stream,
    blob,
    seenAt: Date.now()
  };
}


// ========================================
// Runtime Message Handler
// ========================================

chrome.runtime.onMessage.addListener(
  (message, sender, sendResponse) => {

    // ------------------------------------
    // MEDIA_FOUND
    // ------------------------------------

    if (message?.type === "MEDIA_FOUND") {
      const tabId = sender.tab?.id ?? message.tabId;

      if (tabId == null) {
        return;
      }

      const current = tabMedia.get(tabId) || [];

      const incoming = (message.items || [])
        .map(item =>
          normalizeMedia({
            ...item,
            tabId,
            frameUrl: sender.url || ""
          })
        )
        .filter(Boolean);

      // Merge existing and incoming media
      const mediaMap = new Map(
        current.map(item => [item.url, item])
      );

      for (const item of incoming) {
        mediaMap.set(item.url, item);
      }

      // Limit stored media to 250 items
      const updated = [...mediaMap.values()].slice(-250);

      tabMedia.set(tabId, updated);

      chrome.storage.session.set({
        [`tab_${tabId}`]: updated
      });

      sendResponse({
        ok: true,
        count: updated.length
      });

      return true;
    }


    // ------------------------------------
    // GET_MEDIA
    // ------------------------------------

    if (message?.type === "GET_MEDIA") {
      const tabId = message.tabId;
      const cached = tabMedia.get(tabId);

      // Return cached media
      if (cached) {
        sendResponse({
          items: cached
        });
      } else {
        // Load media from session storage
        chrome.storage.session.get(
          `tab_${tabId}`,
          result => {
            const data = result[`tab_${tabId}`] || [];

            tabMedia.set(tabId, data);

            sendResponse({
              items: data
            });
          }
        );
      }

      return true;
    }


    // ------------------------------------
    // DOWNLOAD_MEDIA
    // ------------------------------------

    if (message?.type === "DOWNLOAD_MEDIA") {
      const item = normalizeMedia(message.item);

      // Validate downloadable resource
      if (!item || !item.direct) {
        sendResponse({
          ok: false,
          error: "This resource is not a directly downloadable video file."
        });

        return true;
      }

      const filename = safeFilename(
        message.filename || item.title || "video"
      );

      // Start Chrome download
      chrome.downloads.download(
        {
          url: item.url,
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
            sendResponse({
              ok: true,
              downloadId
            });
          }
        }
      );

      return true;
    }


    // ------------------------------------
    // CLEAR_TAB
    // ------------------------------------

    if (message?.type === "CLEAR_TAB") {
      const tabId = message.tabId;

      tabMedia.delete(tabId);

      chrome.storage.session.remove(
        `tab_${tabId}`
      );

      sendResponse({
        ok: true
      });

      return true;
    }
  }
);


// ========================================
// Filename Utilities
// ========================================

function safeFilename(name) {
  let clean = String(name)
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
    .trim();

  if (!clean) {
    clean = "video";
  }

  // Add default MP4 extension
  if (!/\.[a-z0-9]{2,5}$/i.test(clean)) {
    clean += ".mp4";
  }

  return clean.slice(0, 180);
}


// ========================================
// Tab Cleanup
// ========================================

chrome.tabs.onRemoved.addListener(tabId => {
  tabMedia.delete(tabId);

  chrome.storage.session.remove(
    `tab_${tabId}`
  );
});