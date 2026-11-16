
(() => {
  // ========================================
  // Initialization
  // ========================================

  if (window.__vdAdvancedInstalled) return;

  window.__vdAdvancedInstalled = true;

  const seen = new Set();
  const batch = [];

  let flushTimer;


  // ========================================
  // Video Format Detection
  // ========================================

  function classify(url, type = "") {
    const lower = (url + " " + type).toLowerCase();

    if (/\.m3u8(?:$|[?#])|mpegurl/.test(lower)) {
      return "HLS";
    }

    if (/\.mpd(?:$|[?#])|dash\+xml/.test(lower)) {
      return "DASH";
    }

    if (/\.mp4(?:$|[?#])|video\/mp4/.test(lower)) {
      return "MP4";
    }

    if (/\.webm(?:$|[?#])|video\/webm/.test(lower)) {
      return "WebM";
    }

    if (/\.mov(?:$|[?#])|quicktime/.test(lower)) {
      return "MOV";
    }

    if (/\.m4v(?:$|[?#])/.test(lower)) {
      return "M4V";
    }

    if (/\.ogv(?:$|[?#])|video\/ogg/.test(lower)) {
      return "OGV";
    }

    if (url.startsWith("blob:")) {
      return "BLOB";
    }

    return "Unknown";
  }


  // ========================================
  // Filename Extraction
  // ========================================

  function filenameFromURL(url) {
    try {
      const parsed = new URL(url);
      const filename = parsed.pathname.split("/").pop();

      return decodeURIComponent(filename) || "video";
    } catch {
      return "video";
    }
  }


  // ========================================
  // Media Registration
  // ========================================

  function add(
    url,
    type = "",
    source = "Page resource",
    title = ""
  ) {
    // Validate URL
    if (
      !url ||
      typeof url !== "string" ||
      seen.has(url)
    ) {
      return;
    }

    // Allow supported protocols
    if (!/^(https?:|blob:|data:)/i.test(url)) {
      return;
    }

    // Detect video format
    const format = classify(url, type);

    const looksVideo =
      format !== "Unknown" ||
      type.toLowerCase().startsWith("video/");

    if (!looksVideo) {
      return;
    }

    // Prevent duplicate detection
    seen.add(url);

    // Add media to batch
    batch.push({
      url,
      type,
      source,
      title: title || filenameFromURL(url)
    });

    // Schedule batch transmission
    clearTimeout(flushTimer);

    flushTimer = setTimeout(flush, 180);
  }


  // ========================================
  // Batch Transmission
  // ========================================

  function flush() {
    if (!batch.length) {
      return;
    }

    const items = batch.splice(0, batch.length);

    chrome.runtime.sendMessage(
      {
        type: "MEDIA_FOUND",
        items
      },
      () => void chrome.runtime.lastError
    );
  }


  // ========================================
  // HTML5 Video Detection
  // ========================================

  function scanVideos() {
    document.querySelectorAll("video").forEach(video => {

      // Current video source
      add(
        video.currentSrc,
        video.getAttribute("type") || "",
        "HTML5 video"
      );

      // Video element source
      add(
        video.src,
        video.getAttribute("type") || "",
        "HTML5 video"
      );

      // Nested source elements
      video.querySelectorAll("source").forEach(source => {
        add(
          source.src,
          source.type || "",
          "Video source"
        );
      });

    });
  }


  // ========================================
  // Video Link Detection
  // ========================================

  function scanLinks() {
    document.querySelectorAll("a[href]").forEach(a => {
      const href = a.href;

      if (/\.(mp4|webm|mov|m4v|ogv|m3u8|mpd)(?:$|[?#])/i.test(href)) {
        add(
          href,
          "",
          "Video link",
          a.textContent.trim()
        );
      }
    });
  }


  // ========================================
  // Network Resource Detection
  // ========================================

  function scanNetworkResources() {
    try {
      performance
        .getEntriesByType("resource")
        .forEach(entry => {

          const url = entry.name;

          if (/\.(mp4|webm|mov|m4v|ogv|m3u8|mpd)(?:$|[?#])/i.test(url)) {
            add(
              url,
              entry.initiatorType || "",
              "Network resource"
            );
          }

        });

    } catch {
      // Ignore performance API errors
    }
  }


  // ========================================
  // Main Scanner
  // ========================================

  function scan() {
    scanVideos();
    scanLinks();
    scanNetworkResources();
  }


  // ========================================
  // DOM Mutation Observer
  // ========================================

  scan();

  const observer = new MutationObserver(() => {
    scan();
  });

  observer.observe(
    document.documentElement,
    {
      childList: true,
      subtree: true
    }
  );


  // ========================================
  // Performance Observer
  // ========================================

  const perfObserver = new PerformanceObserver(list => {

    for (const entry of list.getEntries()) {
      const url = entry.name;

      if (/\.(mp4|webm|mov|m4v|ogv|m3u8|mpd)(?:$|[?#])/i.test(url)) {
        add(
          url,
          entry.initiatorType || "",
          "Network resource"
        );
      }
    }

  });

  try {
    perfObserver.observe({
      type: "resource",
      buffered: true
    });
  } catch {
    // Ignore unsupported observer options
  }


  // ========================================
  // Event Listeners
  // ========================================

  window.addEventListener(
    "load",
    scan,
    { once: true }
  );


  // ========================================
  // Periodic Scanning
  // ========================================

  setInterval(scan, 5000);

})();