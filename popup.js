// ========================================
// DOM Utilities
// ========================================

const $ = id => document.getElementById(id);


// ========================================
// Application State
// ========================================

let activeTabId = null;
let activeTabTitle = "";
let mediaItems = [];

const activeJobs = new Map();

chrome.runtime.onMessage.addListener(message => {
  if (message?.type === "MERGE_PROGRESS") {
    activeJobs.set(message.jobId, `⏳ ${message.percent}%`);
    const btn = document.querySelector(`[data-job="${CSS.escape(message.jobId)}"]`);
    if (btn) {
      btn.textContent = `⏳ ${message.percent}%`;
    }
  }
});


// ========================================
// URL Utilities
// ========================================

function filenameFromUrl(url) {
  try {
    const parsed = new URL(url);
    const filename = parsed.pathname.split("/").pop();
    return decodeURIComponent(filename) || "video";
  } catch {
    return "video";
  }
}


// ========================================
// HTML Security Utilities
// ========================================

function escapeHtml(value) {
  const entities = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  };

  return String(value).replace(/[&<>"']/g, character => entities[character]);
}


// ========================================
// Media Filtering
// ========================================

function getFilteredMedia() {
  const query = $("search").value.toLowerCase();
  const format = $("filter").value;

  return mediaItems.filter(item => {
    const matchesFormat = format === "all" || item.format === format;

    const searchTarget = (
      item.title +
      " " +
      item.url +
      " " +
      item.format
    ).toLowerCase();

    return matchesFormat && searchTarget.includes(query);
  });
}


// ========================================
// Media Description
// ========================================

function getMediaDetail(item) {
  const count = item.variants?.length || 0;

  if (item.format === "HLS") {
    if (item.hlsKind === "master") {
      return `HLS stream · ${count} quality option${count === 1 ? "" : "s"}`;
    }
    return "HLS single-track playlist · may have no audio (reload page to capture the full manifest)";
  }

  if (item.format === "DASH") {
    return count
      ? `DASH stream · ${count} quality option${count === 1 ? "" : "s"}`
      : "DASH manifest · ready to merge & download";
  }

  if (item.direct) {
    return "Direct file · download available";
  }

  return "Detected media resource";
}


// ========================================
// Empty State
// ========================================

function renderEmptyState() {
  const hasMedia = mediaItems.length > 0;

  $("results").innerHTML = `
    <div class="empty">
      <div class="empty-icon">◉</div>
      <h2>${hasMedia ? "No matching videos" : "Looking for videos"}</h2>
      <p>
        ${
          hasMedia
            ? "Try another search or format."
            : "Play a video or refresh this page to discover media resources."
        }
      </p>
    </div>
  `;
}


// ========================================
// Display Name (show the video title instead of "index.m3u8")
// ========================================

function cleanPageTitle(title) {
  return String(title || "")
    .replace(/^\(\d+\)\s*/, "") // YouTube notification prefix: "(3) "
    .replace(/\s*[-–—|·]\s*(YouTube|CHZZK|치지직)\s*$/i, "")
    .trim();
}

function displayName(item) {
  const generic =
    item.stream ||
    /^(index|master|playlist|manifest|chunklist)\.(m3u8|mpd)$/i.test(item.title || "");
  return (
    (generic && cleanPageTitle(activeTabTitle)) ||
    item.title ||
    filenameFromUrl(item.url)
  );
}


// ========================================
// Media Item Template
// ========================================

function createMediaCard(item, index) {
  const name = displayName(item);
  const detail = getMediaDetail(item);
  const hasVariants = Array.isArray(item.variants) && item.variants.length > 0;
  const canDownload =
    item.direct || item.format === "HLS" || item.format === "DASH";

  const variantSelectHtml = hasVariants
    ? `
      <select class="quality-select" data-quality="${index}" aria-label="Select quality">
        ${item.variants
          .map(
            (v, vIdx) =>
              `<option value="${vIdx}">${escapeHtml(v.label)}</option>`
          )
          .join("")}
      </select>
    `
    : "";

  const audioOptions = Array.isArray(item.audioOptions) ? item.audioOptions : [];
  const audioSelectHtml =
    audioOptions.length > 1
      ? `
      <select class="audio-select" data-audio="${index}" aria-label="Select audio track" title="Audio track">
        ${audioOptions
          .map(
            o =>
              `<option value="${escapeHtml(o.key)}"${o.preferred ? " selected" : ""}>♪ ${escapeHtml(o.label)}</option>`
          )
          .join("")}
      </select>
    `
      : "";

  return `
    <article class="item">
      <div class="item-head">
        <div class="file-icon">${escapeHtml(item.format)}</div>

        <div class="meta">
          <div class="filename" title="${escapeHtml(name)}">
            ${escapeHtml(name)}
          </div>
          <div class="sub">
            ${escapeHtml(item.source)} · ${escapeHtml(detail)}
          </div>
        </div>

        <span class="tag">${escapeHtml(item.format)}</span>
      </div>

      <div class="actions">
        ${variantSelectHtml}
        ${audioSelectHtml}

        <button
          class="action primary"
          data-download="${index}"
          data-job="${escapeHtml(item.url)}"
          ${canDownload ? "" : "disabled"}
        >
          ↓ Download
        </button>

        <button
          class="action"
          data-copy="${index}"
        >
          Copy URL
        </button>
      </div>
    </article>
  `;
}


// ========================================
// Main Rendering
// ========================================

function render() {
  const filtered = getFilteredMedia();

  $("count").textContent = mediaItems.length;

  if (!filtered.length) {
    renderEmptyState();
    return;
  }

  $("results").innerHTML = filtered
    .map((item, index) => createMediaCard(item, index))
    .join("");

  bindMediaEvents(filtered);
}


// ========================================
// Media Event Handlers
// ========================================

function bindMediaEvents(filtered) {
  // Download buttons
  $("results")
    .querySelectorAll("[data-download]")
    .forEach(button => {
      button.addEventListener("click", () => {
        const index = Number(button.dataset.download);
        const item = filtered[index];
        const select = $("results").querySelector(`[data-quality="${index}"]`);
        const variantIndex = select ? Number(select.value) : 0;
        const selectedVariant = item.variants?.[variantIndex];

        const audioSelect = $("results").querySelector(`[data-audio="${index}"]`);

        downloadItem(item, selectedVariant, button, audioSelect?.value);
      });
    });

  // Copy URL buttons
  $("results")
    .querySelectorAll("[data-copy]")
    .forEach(button => {
      button.addEventListener("click", async () => {
        const index = Number(button.dataset.copy);
        const item = filtered[index];
        const select = $("results").querySelector(`[data-quality="${index}"]`);
        const variantIndex = select ? Number(select.value) : 0;
        // A master playlist URL plays with sound in VLC / mpv / ffmpeg;
        // a single quality URL is video-only
        const targetUrl =
          item.hlsKind === "master"
            ? item.url
            : item.variants?.[variantIndex]?.url || item.url;

        try {
          await navigator.clipboard.writeText(targetUrl);
          button.textContent = "Copied";
          setTimeout(() => {
            button.textContent = "Copy URL";
          }, 1500);
        } catch {
          button.textContent = "Copy failed";
        }
      });
    });
}


// ========================================
// Download Manager
// ========================================

async function downloadItem(item, selectedVariant, button, audioKey) {
  const jobId = item.url;
  activeJobs.set(jobId, "⏳ 0%");
  button.disabled = true;
  button.textContent = "⏳ 0%";

  // Use the page (video) title as the file name
  const tab = await chrome.tabs.get(activeTabId).catch(() => null);
  const pageTitle = cleanPageTitle(tab?.title);

  const variantUrl = selectedVariant?.url || item.url;
  const qualitySuffix =
    selectedVariant?.label && selectedVariant.label !== "Default"
      ? `_${selectedVariant.label}`
      : "";

  // Chosen audio track (the preferred one needs no suffix)
  const audioChoice = audioKey ? selectedVariant?.audioByKey?.[audioKey] || "" : "";
  const audioOption = item.audioOptions?.find(o => o.key === audioKey);
  const audioSuffix =
    audioOption && !audioOption.preferred ? `_${audioOption.lang || audioOption.label}` : "";

  const baseTitle =
    pageTitle ||
    (item.title || filenameFromUrl(item.url)).replace(
      /\.(m3u8|mpd|mp4|webm|mov|m4v|ogv)$/i,
      ""
    );

  chrome.runtime.sendMessage(
    {
      type: "DOWNLOAD_MEDIA",
      jobId,
      item,
      variantUrl,
      audioUrl: selectedVariant?.audioUrl || "",
      variant: selectedVariant || null,
      audioChoice,
      filename: `${baseTitle}${qualitySuffix}${audioSuffix}`,
      saveAs: false
    },
    response => {
      activeJobs.delete(jobId);
      button.disabled = false;

      if (chrome.runtime.lastError) {
        button.textContent = "↓ Download";
        alert(chrome.runtime.lastError.message);
        return;
      }

      if (!response?.ok) {
        button.textContent = "↓ Download";
        alert(response?.error || "Could not start download.");
        return;
      }

      button.textContent = "✓ Saved";
      if (response.warning) alert(response.warning);
      setTimeout(() => {
        button.textContent = "↓ Download";
      }, 2000);
    }
  );
}


// ========================================
// Media Loading
// ========================================

async function load() {
  $("results").innerHTML = `
    <div class="empty">
      <div class="empty-icon">◌</div>
      <h2>Scanning this page</h2>
      <p>Collecting video resources…</p>
    </div>
  `;

  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true
  });

  activeTabId = tab?.id;
  activeTabTitle = tab?.title || "";

  if (!tab || !/^https?:/.test(tab.url || "")) {
    mediaItems = [];
    $("results").innerHTML = `
      <div class="empty">
        <div class="empty-icon">!</div>
        <h2>Page unavailable</h2>
        <p>Open a regular website to scan its media resources.</p>
      </div>
    `;
    $("count").textContent = "0";
    return;
  }

  setTimeout(() => {
    chrome.runtime.sendMessage(
      {
        type: "GET_MEDIA",
        tabId: tab.id
      },
      response => {
        mediaItems = response?.items || [];
        render();
      }
    );
  }, 250);
}


// ========================================
// Media Synchronization
// ========================================

function syncMedia() {
  if (activeTabId == null) return;

  chrome.tabs
    .get(activeTabId)
    .then(t => {
      if (t && t.title !== activeTabTitle) {
        activeTabTitle = t.title || "";
        render();
      }
    })
    .catch(() => {});

  chrome.runtime.sendMessage(
    {
      type: "GET_MEDIA",
      tabId: activeTabId
    },
    response => {
      if (!response?.items) return;

      const sig = items =>
        items.map(i => `${i.url}|${i.variants?.length || 0}`).join("\n");

      if (sig(response.items) !== sig(mediaItems)) {
        mediaItems = response.items;
        render();
      }
    }
  );
}


// ========================================
// Popup Event Listeners
// ========================================

$("refresh").addEventListener("click", load);
$("search").addEventListener("input", render);
$("filter").addEventListener("change", render);
$("openDownloads").addEventListener("click", () => {
  chrome.tabs.create({ url: "chrome://downloads" });
});


// ========================================
// Application Initialization
// ========================================

load();
setInterval(syncMedia, 1800);