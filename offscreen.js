// Offscreen document
//  - downloads HLS / DASH tracks segment by segment
//  - optionally muxes video + audio into one file with ffmpeg.wasm
//  - hands Blob URLs back to the service worker (chrome.downloads is NOT
//    available in offscreen documents)

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== "offscreen") return false;

  const run = task => {
    task()
      .then(result => sendResponse({ ok: true, ...result }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  };

  switch (message.type) {
    case "PARSE_MPD":
      return run(() => parseMpdVariants(message.mpdUrl));

    case "DOWNLOAD_TRACKS":
      return run(() => downloadSource(message.jobId, message.source));

    case "REVOKE_BLOB":
      URL.revokeObjectURL(message.blobUrl);
      sendResponse({ ok: true });
      return false;

    default:
      return false;
  }
});


// ========================================
// Helpers
// ========================================

const MIME_BY_EXT = {
  mp4: "video/mp4",
  m4a: "audio/mp4",
  ts: "video/mp2t",
  webm: "video/webm",
  mkv: "video/x-matroska"
};

function makeBlobUrl(parts, ext) {
  const url = URL.createObjectURL(
    new Blob(parts, { type: MIME_BY_EXT[ext] || "application/octet-stream" })
  );
  // Safety net in case the background never sends REVOKE_BLOB
  setTimeout(() => URL.revokeObjectURL(url), 10 * 60_000);
  return url;
}

function concatChunks(chunks) {
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(new Uint8Array(c.buffer ? c.buffer : c, c.byteOffset || 0, c.byteLength), offset);
    offset += c.byteLength;
  }
  return out;
}


// ========================================
// HLS playlist -> track
// ========================================

async function loadHlsTrack(m3u8Url, kind) {
  const res = await fetch(m3u8Url);
  if (!res.ok) throw new Error(`Playlist fetch failed (${res.status})`);

  const text = await res.text();

  if (text.includes("#EXT-X-STREAM-INF")) {
    throw new Error("This is a master playlist. Reload the page and pick a quality.");
  }

  if (/#EXT-X-KEY:(?![^\n]*METHOD=NONE)/i.test(text)) {
    throw new Error("Encrypted (AES/DRM) streams are not supported.");
  }

  const segments = [];
  let fmp4 = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith("#EXT-X-MAP:")) {
      const uriMatch = line.match(/URI="([^"]+)"/i);
      if (uriMatch) {
        segments.push({ url: new URL(uriMatch[1], m3u8Url).href });
        fmp4 = true;
      }
    } else if (!line.startsWith("#")) {
      segments.push({ url: new URL(line, m3u8Url).href });
    }
  }

  if (!segments.length) {
    throw new Error("No video segments found in playlist.");
  }

  return {
    kind,
    segments,
    ext: fmp4 ? (kind === "audio" ? "m4a" : "mp4") : "ts"
  };
}


// ========================================
// DASH (MPD) -> tracks
// ========================================

const kids = (el, name) =>
  el ? Array.from(el.children).filter(c => c.localName === name) : [];
const kid = (el, name) => kids(el, name)[0] || null;

function isoDurationToSeconds(str) {
  const m = /^P(?:[\d.]+Y)?(?:[\d.]+M)?(?:([\d.]+)D)?(?:T(?:([\d.]+)H)?(?:([\d.]+)M)?(?:([\d.]+)S)?)?$/.exec(
    str || ""
  );
  if (!m) return 0;
  return (
    parseFloat(m[1] || 0) * 86400 +
    parseFloat(m[2] || 0) * 3600 +
    parseFloat(m[3] || 0) * 60 +
    parseFloat(m[4] || 0)
  );
}

function fillTemplate(template, vars) {
  return template.replace(
    /\$(RepresentationID|Number|Bandwidth|Time)(?:%0(\d+)d)?\$|\$\$/g,
    (match, key, width) => {
      if (match === "$$") return "$";
      let value = String(vars[key] ?? "");
      if (width) value = value.padStart(Number(width), "0");
      return value;
    }
  );
}

function segmentsFromTemplate(st, { repId, bandwidth, baseUrl, totalDur }) {
  const mediaTpl = st.getAttribute("media");
  const initTpl = st.getAttribute("initialization");
  if (!mediaTpl) throw new Error("SegmentTemplate has no media URL.");

  const timescale = Number(st.getAttribute("timescale")) || 1;
  const startNumber = st.hasAttribute("startNumber")
    ? Number(st.getAttribute("startNumber"))
    : 1;

  const baseVars = { RepresentationID: repId, Bandwidth: bandwidth };
  const url = vars => new URL(fillTemplate(mediaTpl, { ...baseVars, ...vars }), baseUrl).href;

  const segments = [];

  if (initTpl) {
    segments.push({ url: new URL(fillTemplate(initTpl, baseVars), baseUrl).href });
  }

  const timeline = kid(st, "SegmentTimeline");

  if (timeline) {
    let number = startNumber;
    let time = 0;

    for (const s of kids(timeline, "S")) {
      if (s.hasAttribute("t")) time = Number(s.getAttribute("t"));
      const d = Number(s.getAttribute("d"));
      let repeat = Number(s.getAttribute("r") || 0);

      if (repeat < 0) {
        repeat = Math.max(0, Math.ceil((totalDur * timescale - time) / d) - 1);
      }

      for (let i = 0; i <= repeat; i++) {
        segments.push({ url: url({ Number: number, Time: time }) });
        number++;
        time += d;
      }
    }
  } else {
    const duration = Number(st.getAttribute("duration"));
    if (!duration || !totalDur) {
      throw new Error("Cannot determine DASH segment count (missing duration).");
    }

    const count = st.hasAttribute("endNumber")
      ? Number(st.getAttribute("endNumber")) - startNumber + 1
      : Math.ceil((totalDur * timescale) / duration);

    for (let i = 0; i < count; i++) {
      segments.push({ url: url({ Number: startNumber + i, Time: i * duration }) });
    }
  }

  return segments;
}

function segmentsFromList(sl, baseUrl) {
  const segments = [];

  const init = kid(sl, "Initialization");
  if (init) {
    const src = init.getAttribute("sourceURL");
    segments.push({
      url: src ? new URL(src, baseUrl).href : baseUrl,
      range: init.getAttribute("range") || undefined
    });
  }

  for (const su of kids(sl, "SegmentURL")) {
    const media = su.getAttribute("media");
    segments.push({
      url: media ? new URL(media, baseUrl).href : baseUrl,
      range: su.getAttribute("mediaRange") || undefined
    });
  }

  return segments;
}

async function loadDashTracks(mpdUrl) {
  const res = await fetch(mpdUrl);
  if (!res.ok) throw new Error(`MPD fetch failed (${res.status})`);

  const text = await res.text();
  const doc = new DOMParser().parseFromString(text, "application/xml");
  const mpd = doc.documentElement;

  if (!mpd || mpd.localName !== "MPD" || doc.getElementsByTagName("parsererror").length) {
    throw new Error("Not a valid MPD manifest.");
  }

  if (mpd.getAttribute("type") === "dynamic") {
    throw new Error("Live (dynamic) DASH streams are not supported.");
  }

  const period = kid(mpd, "Period");
  if (!period) throw new Error("MPD has no Period.");

  // Only the first Period is used
  const totalDur =
    isoDurationToSeconds(period.getAttribute("duration")) ||
    isoDurationToSeconds(mpd.getAttribute("mediaPresentationDuration"));

  const tracks = [];

  for (const aset of kids(period, "AdaptationSet")) {
    for (const rep of kids(aset, "Representation")) {
      const attr = name => rep.getAttribute(name) ?? aset.getAttribute(name);

      const width = Number(attr("width")) || 0;
      const height = Number(attr("height")) || 0;
      const mimeAttr = attr("mimeType") || "";

      let contentType =
        aset.getAttribute("contentType") || mimeAttr.split("/")[0] || "";
      if (!contentType && height) contentType = "video";

      const kind = contentType === "video" ? "video" : contentType === "audio" ? "audio" : null;
      if (!kind) continue; // subtitles etc.

      let baseUrl = mpdUrl;
      for (const el of [mpd, period, aset, rep]) {
        const b = kid(el, "BaseURL")?.textContent.trim();
        if (b) baseUrl = new URL(b, baseUrl).href;
      }

      const repId = rep.getAttribute("id") || "";
      const bandwidth = Number(rep.getAttribute("bandwidth")) || 0;

      const template =
        kid(rep, "SegmentTemplate") || kid(aset, "SegmentTemplate") || kid(period, "SegmentTemplate");
      const list =
        kid(rep, "SegmentList") || kid(aset, "SegmentList") || kid(period, "SegmentList");

      let segments;
      if (template) {
        segments = segmentsFromTemplate(template, { repId, bandwidth, baseUrl, totalDur });
      } else if (list) {
        segments = segmentsFromList(list, baseUrl);
      } else if (baseUrl !== mpdUrl) {
        // BaseURL (+ SegmentBase): the file itself is the whole track
        segments = [{ url: baseUrl }];
      } else {
        continue;
      }

      tracks.push({
        kind,
        id: repId,
        lang: aset.getAttribute("lang") || rep.getAttribute("lang") || "",
        label: kid(aset, "Label")?.textContent.trim() || "",
        role: kids(aset, "Role").map(r => r.getAttribute("value")).join(","),
        bandwidth,
        width,
        height,
        ext: mimeAttr.includes("webm") ? "webm" : kind === "audio" ? "m4a" : "mp4",
        segments
      });
    }
  }

  if (!tracks.length) {
    throw new Error("No downloadable video/audio tracks found in the MPD.");
  }

  return tracks;
}

const ORIGINAL_HINT = /original|원본/i;
const DUBBED_HINT = /dubbed|dubbing|auto-?dub|더빙/i;

function pickPreferredAudio(tracks) {
  return (
    tracks.find(t => t.original) ||
    tracks.find(t => !t.dubbed) ||
    tracks[0] ||
    null
  );
}

async function parseMpdVariants(mpdUrl) {
  const tracks = await loadDashTracks(mpdUrl);

  const videos = tracks
    .filter(t => t.kind === "video")
    .sort((a, b) => b.height - a.height || b.bandwidth - a.bandwidth);

  // Best-bandwidth audio representation per language / label / role
  const audioTracks = new Map();
  for (const a of tracks
    .filter(t => t.kind === "audio")
    .sort((x, y) => y.bandwidth - x.bandwidth)) {
    const key = `${a.lang}|${a.label}|${a.role}`.toLowerCase();
    if (audioTracks.has(key)) continue;

    audioTracks.set(key, {
      key,
      id: a.id,
      label: a.label || a.lang || a.id || "Audio",
      lang: a.lang,
      original: ORIGINAL_HINT.test(a.label) || /\bmain\b/i.test(a.role),
      dubbed: DUBBED_HINT.test(a.label) || /\bdub\b/i.test(a.role)
    });
  }

  const audioList = [...audioTracks.values()];
  const preferred = pickPreferredAudio(audioList);

  const audioOptions = audioList.map(t => ({
    key: t.key,
    label: t.label,
    lang: t.lang,
    preferred: t === preferred
  }));

  const audioByKey = Object.fromEntries(audioList.map(t => [t.key, t.id]));

  const seen = new Set();
  const variants = [];

  for (const v of videos) {
    const label = v.height ? `${v.height}p` : `${Math.round(v.bandwidth / 1000)} kbps`;
    if (seen.has(label)) continue;
    seen.add(label);

    variants.push({
      label,
      height: v.height,
      bandwidth: v.bandwidth,
      url: mpdUrl,
      repId: v.id,
      audioRepId: preferred?.id || "",
      audioByKey
    });
  }

  return { variants, audioOptions };
}

function pickDashTracks(tracks, videoRepId, audioRepId) {
  const videos = tracks
    .filter(t => t.kind === "video")
    .sort((a, b) => b.height - a.height || b.bandwidth - a.bandwidth);
  const audios = tracks
    .filter(t => t.kind === "audio")
    .sort((a, b) => b.bandwidth - a.bandwidth);

  const video = videos.find(t => t.id === videoRepId) || videos[0] || null;
  const audio = audios.find(t => t.id === audioRepId) || audios[0] || null;

  if (!video && !audio) throw new Error("No tracks to download.");

  // Audio-only manifest: treat the audio track as the main track
  return video ? { video, audio } : { video: audio, audio: null };
}


// ========================================
// Segment downloader
// ========================================

async function readStream(response, onFraction) {
  const length = Number(response.headers.get("content-length")) || 0;
  if (!response.body) return [await response.arrayBuffer()];

  const reader = response.body.getReader();
  const pieces = [];
  let received = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    pieces.push(value);
    received += value.byteLength;
    if (length) onFraction(received / length);
  }

  return pieces;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Permanent client errors: retrying will not help
const PERMANENT_HTTP = /HTTP (401|403|404|410)\b/;

async function fetchWithRetry(seg) {
  const headers = seg.range ? { Range: `bytes=${seg.range}` } : undefined;
  let lastError = "";

  for (let attempt = 0; attempt < 3; attempt++) {
    for (const init of [{ credentials: "include", mode: "cors", headers }, { headers }]) {
      try {
        const r = await fetch(seg.url, init);
        if (r.ok) return { response: r };
        lastError = `HTTP ${r.status}`;
      } catch (err) {
        lastError = err?.message || "network error";
      }
    }

    if (PERMANENT_HTTP.test(lastError)) break;
    await sleep(400 * (attempt + 1));
  }

  let host = "";
  try {
    host = new URL(seg.url).hostname;
  } catch {}

  return { error: `${lastError}${host ? ` from ${host}` : ""}` };
}

async function fetchTrack(jobId, track, from, to) {
  const segments = track.segments;
  const total = segments.length;
  const parts = new Array(total);
  const CONCURRENCY = 4;

  let cursor = 0;
  let completed = 0;
  let failed = 0;
  let aborted = false;
  let firstError = "";
  let lastPercent = -1;

  const report = fraction => {
    const percent = Math.round(from + (to - from) * fraction);
    if (percent === lastPercent) return;
    lastPercent = percent;
    chrome.runtime
      .sendMessage({ type: "MERGE_PROGRESS", jobId, percent, completed, total })
      .catch(() => {});
  };

  async function worker() {
    while (cursor < total && !aborted) {
      const idx = cursor++;
      const { response, error } = await fetchWithRetry(segments[idx]);

      if (!response) {
        console.warn(`Skipping failed segment ${idx + 1}: ${error}`);
        failed++;
        firstError = firstError || error;
        parts[idx] = [];

        // Every segment so far has failed: the server is refusing us. Stop early.
        if (failed >= 6 && failed === completed + 1) aborted = true;
      } else if (total === 1) {
        parts[idx] = await readStream(response, report);
      } else {
        parts[idx] = [await response.arrayBuffer()];
      }

      completed++;
      report(completed / total);
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, total) }, worker));

  if (aborted || failed === total) {
    throw new Error(`All segments failed to download (${firstError}).`);
  }

  return { chunks: parts.flat(), ext: track.ext, failed, firstError };
}


// ========================================
// Mux video + audio with ffmpeg.wasm (stream copy, no re-encoding)
// ========================================

async function muxWithFfmpeg(video, audio) {
  if (typeof FFmpegWASM === "undefined") {
    throw new Error("ffmpeg.wasm files not found in lib/ffmpeg/");
  }

  const ffmpeg = new FFmpegWASM.FFmpeg();

  try {
    await ffmpeg.load({
      coreURL: chrome.runtime.getURL("lib/ffmpeg/ffmpeg-core.js"),
      wasmURL: chrome.runtime.getURL("lib/ffmpeg/ffmpeg-core.wasm")
    });

    const vName = `video.${video.ext}`;
    const aName = `audio.${audio.ext}`;

    const outExt =
      video.ext === "webm" && audio.ext === "webm"
        ? "webm"
        : video.ext === "webm" || audio.ext === "webm"
          ? "mkv"
          : "mp4";
    const outName = `out.${outExt}`;

    await ffmpeg.writeFile(vName, concatChunks(video.chunks));
    await ffmpeg.writeFile(aName, concatChunks(audio.chunks));

    const args = ["-i", vName, "-i", aName, "-map", "0:v:0", "-map", "1:a:0", "-c", "copy"];
    if (outExt === "mp4") args.push("-movflags", "+faststart");
    args.push(outName);

    const code = await ffmpeg.exec(args);
    if (code !== 0) throw new Error(`ffmpeg exited with code ${code}`);

    const data = await ffmpeg.readFile(outName);
    return { blobUrl: makeBlobUrl([data], outExt), ext: outExt };
  } finally {
    try {
      ffmpeg.terminate();
    } catch {}
  }
}


// ========================================
// Job runner
// ========================================

async function resolveSource(source) {
  if (source.kind === "dash") {
    const tracks = await loadDashTracks(source.mpdUrl);
    return pickDashTracks(tracks, source.videoRepId, source.audioRepId);
  }

  const video = await loadHlsTrack(source.videoUrl, "video");
  const audio =
    source.audioUrl && source.audioUrl !== source.videoUrl
      ? await loadHlsTrack(source.audioUrl, "audio")
      : null;

  return { video, audio };
}

async function downloadSource(jobId, source) {
  const { video, audio } = await resolveSource(source);

  // Single track: just save it
  if (!audio) {
    const v = await fetchTrack(jobId, video, 0, 100);
    return {
      blobUrl: makeBlobUrl(v.chunks, v.ext),
      ext: v.ext,
      failed: v.failed,
      firstError: v.firstError
    };
  }

  const v = await fetchTrack(jobId, video, 0, 45);
  const a = await fetchTrack(jobId, audio, 45, 85);
  const failed = v.failed + a.failed;
  const firstError = v.firstError || a.firstError;

  try {
    const out = await muxWithFfmpeg(v, a);
    return { ...out, muxed: true, failed, firstError };
  } catch (err) {
    console.warn("Mux failed, falling back to separate files:", err);

    // Fallback: hand back both tracks so nothing is lost
    return {
      muxed: false,
      muxError: err.message,
      failed,
      firstError,
      video: { blobUrl: makeBlobUrl(v.chunks, v.ext), ext: v.ext },
      audio: { blobUrl: makeBlobUrl(a.chunks, a.ext), ext: a.ext }
    };
  }
}