
// ========================================
// DOM Utilities
// ========================================

const $ = id => document.getElementById(id);


// ========================================
// Application State
// ========================================

let activeTabId = null;
let mediaItems = [];


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

  return String(value).replace(
    /[&<>"']/g,
    character => entities[character]
  );
}


// ========================================
// Media Filtering
// ========================================

function getFilteredMedia() {
  const query = $("search").value.toLowerCase();
  const format = $("filter").value;

  return mediaItems.filter(item => {
    const matchesFormat =
      format === "all" ||
      item.format === format;

    const searchTarget = (
      item.title + " " +
      item.url + " " +
      item.format
    ).toLowerCase();

    const matchesSearch = searchTarget.includes(query);

    return matchesFormat && matchesSearch;
  });
}


// ========================================
// Media Description
// ========================================

function getMediaDetail(item) {
  if (item.stream) {
    return "Streaming manifest · not a standalone video file";
  }

  if (item.blob) {
    return "Temporary page URL · direct download unavailable";
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

      <h2>
        ${hasMedia ? "No matching videos" : "Looking for videos"}
      </h2>

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
// Media Item Template
// ========================================

function createMediaCard(item, index) {
  const name = item.title || filenameFromUrl(item.url);
  const detail = getMediaDetail(item);

  return `
    <article class="item">

      <div class="item-head">

        <div class="file-icon">
          ${escapeHtml(item.format)}
        </div>

        <div class="meta">

          <div
            class="filename"
            title="${escapeHtml(name)}"
          >
            ${escapeHtml(name)}
          </div>

          <div class="sub">
            ${escapeHtml(item.source)}
            ·
            ${escapeHtml(detail)}
          </div>

        </div>

        <span class="tag">
          ${escapeHtml(item.format)}
        </span>

      </div>

      <div class="actions">

        <button
          class="action primary"
          data-download="${index}"
          ${item.direct ? "" : "disabled"}
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

      ${
        item.stream
          ? `
            <p class="hint">
              HLS/DASH is detected, but this build does not
              decrypt streams or combine segmented media.
            </p>
          `
          : ""
      }

      ${
        item.blob
          ? `
            <p class="hint">
              Blob URLs are scoped to the page and cannot be
              downloaded directly by the extension background worker.
            </p>
          `
          : ""
      }

    </article>
  `;
}


// ========================================
// Main Rendering
// ========================================

function render() {
  const filtered = getFilteredMedia();

  // Update total media count
  $("count").textContent = mediaItems.length;

  // Display empty state
  if (!filtered.length) {
    renderEmptyState();
    return;
  }

  // Render media cards
  $("results").innerHTML = filtered
    .map((item, index) => createMediaCard(item, index))
    .join("");

  // Register card events
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

        downloadItem(filtered[index], button);
      });

    });


  // Copy URL buttons
  $("results")
    .querySelectorAll("[data-copy]")
    .forEach(button => {

      button.addEventListener("click", async () => {
        const index = Number(button.dataset.copy);
        const item = filtered[index];

        try {
          await navigator.clipboard.writeText(item.url);

          button.textContent = "Copied";
        } catch {
          button.textContent = "Copy failed";
        }

      });

    });

}


// ========================================
// Download Manager
// ========================================

function downloadItem(item, button) {
  chrome.runtime.sendMessage(
    {
      type: "DOWNLOAD_MEDIA",
      item,
      filename: item.title || filenameFromUrl(item.url),
      saveAs: false
    },
    response => {

      // Handle Chrome runtime errors
      if (chrome.runtime.lastError) {
        alert(chrome.runtime.lastError.message);
        return;
      }

      // Handle download errors
      if (!response?.ok) {
        alert(response?.error || "Could not start download.");
        return;
      }

      // Update download button
      button.textContent = "✓ Started";

      setTimeout(() => {
        button.textContent = "↓ Download";
      }, 1800);

    }
  );
}


// ========================================
// Media Loading
// ========================================

async function load() {

  // Show scanning state
  $("results").innerHTML = `
    <div class="empty">
      <div class="empty-icon">◌</div>
      <h2>Scanning this page</h2>
      <p>Collecting video resources…</p>
    </div>
  `;

  // Get active browser tab
  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true
  });

  activeTabId = tab?.id;

  // Validate current page
  if (!tab || !/^https?:/.test(tab.url || "")) {
    mediaItems = [];

    $("results").innerHTML = `
      <div class="empty">
        <div class="empty-icon">!</div>
        <h2>Page unavailable</h2>
        <p>
          Open a regular website to scan its media resources.
        </p>
      </div>
    `;

    $("count").textContent = "0";

    return;
  }

  // Request media list from background
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
  if (activeTabId == null) {
    return;
  }

  chrome.runtime.sendMessage(
    {
      type: "GET_MEDIA",
      tabId: activeTabId
    },
    response => {

      if (!response?.items) {
        return;
      }

      // Update only when media count changes
      if (response.items.length !== mediaItems.length) {
        mediaItems = response.items;

        render();
      }

    }
  );
}


// ========================================
// Popup Event Listeners
// ========================================

// Refresh button
$("refresh").addEventListener("click", load);


// Search input
$("search").addEventListener("input", render);


// Format filter
$("filter").addEventListener("change", render);


// Open Chrome downloads
$("openDownloads").addEventListener("click", () => {
  chrome.tabs.create({
    url: "chrome://downloads"
  });
});


// ========================================
// Application Initialization
// ========================================

// Initial media scan
load();


// Periodic media synchronization
setInterval(syncMedia, 1800);