// Public YouTube channel resolution, RSS ingestion, and bounded public-caption
// processing helpers. This module intentionally uses only PocketBase's embedded
// JS APIs and fixed YouTube/OpenRouter endpoints. It is required inside each
// hook/cron callback because PocketBase isolates callback VMs.

const YOUTUBE_PAGE_TIMEOUT_SECONDS = 10;
const YOUTUBE_RSS_TIMEOUT_SECONDS = 10;
const YOUTUBE_CAPTION_TIMEOUT_SECONDS = 15;
const OPENROUTER_TIMEOUT_SECONDS = 60;
// Handle pages currently exceed 1 MB (for example, @GoogleDevelopers is about
// 1.61 MB). Keep a separate, bounded allowance for allowlisted HTML pages;
// RSS feeds and caption responses retain stricter caps.
const MAX_YOUTUBE_PAGE_BODY_CHARS = 2000000;
const MAX_HTTP_BODY_CHARS = 1000000;
const MAX_RECENT_VIDEOS = 20;
const MAX_POLLED_CHANNELS = 20;
const MAX_PENDING_VIDEOS_PER_CHANNEL = 2;
const MAX_CAPTION_ATTEMPTS = 3;
const IMPORTING_STALE_MS = 60 * 60 * 1000;
const MAX_CAPTION_EVENTS = 2400;
const MAX_TRANSCRIPT_PASSAGES = 160;
const MAX_PASSAGE_CHARS = 1800;
const MAX_BRIEF_TRANSCRIPT_CHARS = 16000;

function textResponse(response) {
  if (response && typeof response.raw === "string") return response.raw;
  // PocketBase versions have exposed the response body under raw; retain this
  // fallback to make an unexpected adapter shape fail closed rather than parse
  // an object as feed or caption content.
  if (response && typeof response.body === "string") return response.body;
  return "";
}

function conciseError(error) {
  const message = error && error.message ? String(error.message) : String(error || "Unknown error");
  return message.replace(/[\r\n\t]+/g, " ").trim().slice(0, 360);
}

function terminalError(message, kind) {
  const error = new Error(message);
  error.terminalKind = kind || "unavailable";
  return error;
}

function channelIdFromValue(value) {
  const match = String(value || "").match(/^UC[A-Za-z0-9_-]{20,30}$/);
  return match ? match[0] : "";
}

function videoIdFromValue(value) {
  const match = String(value || "").match(/^[A-Za-z0-9_-]{6,32}$/);
  return match ? match[0] : "";
}

function normalizedSource(value) {
  let raw = typeof value === "string" ? value.trim() : "";
  if (!raw) throw new Error("A public YouTube URL or @handle is required");
  if (raw.length > 2000) throw new Error("The YouTube URL is too long");

  // A bare handle is deliberately converted to a fixed allowlisted host.
  if (/^@[A-Za-z0-9._-]{1,100}$/.test(raw)) {
    return { pageUrl: "https://www.youtube.com/" + raw, channelId: "" };
  }
  if (/^(?:www\.|m\.)?youtube\.com\//i.test(raw)) raw = "https://" + raw;

  // Do not use URL/Node helpers in the embedded VM. HTTPS and a small exact
  // host allowlist prevent a pasted source from becoming an SSRF target.
  const match = raw.match(/^https:\/\/([^\/?#]+)(\/[^?#]*)?(?:[?#][\s\S]*)?$/i);
  if (!match) throw new Error("Use a public https://youtube.com channel URL or @handle");
  const host = match[1].toLowerCase();
  if (["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"].indexOf(host) === -1) {
    throw new Error("Only public YouTube hosts are allowed");
  }

  const path = match[2] || "/";
  const channelMatch = path.match(/^\/channel\/(UC[A-Za-z0-9_-]{20,30})(?:\/|$)/);
  if (channelMatch) {
    // /channel/UC... contains the authoritative public channel ID itself.
    return { pageUrl: "https://www.youtube.com/channel/" + channelMatch[1], channelId: channelMatch[1] };
  }
  if (!/^\/@[A-Za-z0-9._-]{1,100}(?:\/|$)/.test(path) &&
      !/^\/(?:c|user)\/[A-Za-z0-9._-]{1,100}(?:\/|$)/.test(path)) {
    throw new Error("The URL must identify a public YouTube channel or handle");
  }
  // Drop user-controlled query strings/fragments before the fetch. Page paths
  // are retained only after being constrained by the expressions above.
  return { pageUrl: "https://www.youtube.com" + path, channelId: "" };
}

function fetchPublicPageChannelId(source) {
  if (source.channelId) return source.channelId;
  const response = $http.send({
    url: source.pageUrl,
    method: "GET",
    timeout: YOUTUBE_PAGE_TIMEOUT_SECONDS,
    headers: { "Accept": "text/html,application/xhtml+xml" },
  });
  if (!response || response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error("YouTube channel page returned " + (response ? response.statusCode : "no response"));
  }
  const body = textResponse(response);
  if (!body || body.length > MAX_YOUTUBE_PAGE_BODY_CHARS) throw new Error("YouTube channel page was unreadable");

  // These are public page metadata shapes. We only accept the verified UC...
  // identifier returned by YouTube; a handle is never transformed or guessed.
  const patterns = [
    /"channelId"\s*:\s*"(UC[A-Za-z0-9_-]{20,30})"/,
    /"externalId"\s*:\s*"(UC[A-Za-z0-9_-]{20,30})"/,
    /itemprop=["']channelId["'][^>]*content=["'](UC[A-Za-z0-9_-]{20,30})["']/i,
    /content=["'](UC[A-Za-z0-9_-]{20,30})["'][^>]*itemprop=["']channelId["']/i,
    /youtube\.com\/channel\/(UC[A-Za-z0-9_-]{20,30})/i,
  ];
  for (const pattern of patterns) {
    const found = body.match(pattern);
    if (found && channelIdFromValue(found[1])) return found[1];
  }
  throw new Error("YouTube did not expose a channel ID for this public URL");
}

function decodeXml(value) {
  return String(value || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&quot;/gi, "\"")
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, decimal) => String.fromCharCode(parseInt(decimal, 10)));
}

function tagText(xml, name) {
  const escapedName = name.replace(/:/g, "\\:");
  const match = String(xml || "").match(new RegExp("<" + escapedName + "(?:\\s[^>]*)?>([\\s\\S]*?)</" + escapedName + "\\s*>", "i"));
  if (!match) return "";
  return decodeXml(match[1].replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
}

function rssEntries(feed, expectedChannelId) {
  if (!feed || feed.length > MAX_HTTP_BODY_CHARS || !/<feed(?:\s|>)/i.test(feed)) {
    throw new Error("YouTube RSS returned an unreadable feed");
  }
  const entries = [];
  const entryPattern = /<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry\s*>/gi;
  let match;
  while ((match = entryPattern.exec(feed)) && entries.length < MAX_RECENT_VIDEOS) {
    const entry = match[1];
    const entryChannelId = tagText(entry, "yt:channelId");
    if (entryChannelId && entryChannelId !== expectedChannelId) continue;
    const videoId = videoIdFromValue(tagText(entry, "yt:videoId"));
    const title = tagText(entry, "title").slice(0, 300);
    const publishedRaw = tagText(entry, "published");
    const publishedAt = new Date(publishedRaw);
    if (!videoId || !title || isNaN(publishedAt.getTime())) continue;
    entries.push({
      videoId: videoId,
      title: title,
      publishedAt: publishedAt.toISOString(),
    });
  }
  return entries;
}

function readRss(channelId) {
  // The feed endpoint is fixed, and channelId is verified above before it is
  // interpolated, so user input cannot change this request's destination.
  const response = $http.send({
    url: "https://www.youtube.com/feeds/videos.xml?channel_id=" + channelId,
    method: "GET",
    timeout: YOUTUBE_RSS_TIMEOUT_SECONDS,
    headers: { "Accept": "application/atom+xml,application/xml,text/xml" },
  });
  if (!response || response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error("YouTube RSS returned " + (response ? response.statusCode : "no response"));
  }
  return rssEntries(textResponse(response), channelId);
}

function findVideo(app, channelId, youtubeVideoId) {
  try {
    return app.findFirstRecordByFilter(
      "videos",
      "channel = {:channel} && youtube_video_id = {:youtubeVideoId}",
      { channel: channelId, youtubeVideoId: youtubeVideoId },
    );
  } catch (_) {
    return null;
  }
}

function upsertVideo(app, channel, entry) {
  let video = findVideo(app, channel.id, entry.videoId);
  if (video) {
    // Existing manual content is not rewritten. The only safe repair is a
    // missing source-published timestamp for a prior RSS-imported record.
    if (!video.getString("youtube_published_at")) {
      video.set("youtube_published_at", entry.publishedAt);
      app.save(video);
    }
    return false;
  }

  const videos = app.findCollectionByNameOrId("videos");
  video = new Record(videos);
  video.set("workspace", channel.getString("workspace"));
  video.set("channel", channel.id);
  video.set("title", entry.title);
  video.set("source_url", "https://www.youtube.com/watch?v=" + entry.videoId);
  video.set("manual_source", false);
  video.set("youtube_video_id", entry.videoId);
  video.set("youtube_published_at", entry.publishedAt);
  // New RSS videos join a durable queue. A later poll continues this queue if
  // a channel's historical feed contains more videos than one run may process.
  video.set("caption_status", "queued");
  video.set("caption_status_detail", "Queued to import public captions.");
  video.set("caption_attempts", 0);
  video.set("brief_status", "pending");
  video.set("brief_status_detail", "Waiting for an imported transcript.");
  video.set("brief_attempts", 0);
  try {
    app.save(video);
    return true;
  } catch (error) {
    // A create/update hook and cron can overlap. The database partial unique
    // index is authoritative; treat a duplicate race as a successful upsert.
    if (findVideo(app, channel.id, entry.videoId)) return false;
    throw error;
  }
}

function saveChannelState(app, channel, state) {
  if (Object.prototype.hasOwnProperty.call(state, "channelId")) {
    channel.set("youtube_channel_id", state.channelId);
  }
  if (Object.prototype.hasOwnProperty.call(state, "lastSyncedAt")) {
    channel.set("youtube_last_synced_at", state.lastSyncedAt);
  }
  if (Object.prototype.hasOwnProperty.call(state, "status")) {
    channel.set("youtube_sync_status", String(state.status || "").slice(0, 500));
  }
  app.save(channel);
}

function logWarning(app, message, channelId) {
  try {
    app.logger().warn(message, "channel", channelId);
  } catch (_) {
    // Sync status is the user-readable error channel; logging must not affect
    // a request or the rest of a scheduled poll.
  }
}

function objectAfterMarker(body, marker) {
  const found = marker.exec(body);
  if (!found) return null;
  let start = found.index + found[0].length;
  while (start < body.length && /\s/.test(body.charAt(start))) start++;
  if (body.charAt(start) !== "{") return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < body.length; index++) {
    const char = body.charAt(index);
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") inString = true;
    else if (char === "{") depth++;
    else if (char === "}") {
      depth--;
      if (depth === 0) {
        const raw = body.slice(start, index + 1);
        try {
          return JSON.parse(raw);
        } catch (_) {
          throw new Error("YouTube player data was malformed");
        }
      }
    }
  }
  throw new Error("YouTube player data was incomplete");
}

function playerCaptionTracks(watchPage) {
  // The watch page is fetched only from the fixed URL below. Parse the exact
  // embedded player object with brace/string accounting instead of evaluating
  // page script or trusting arbitrary script content.
  const player = objectAfterMarker(watchPage, /(?:var\s+)?ytInitialPlayerResponse\s*=\s*/);
  if (!player || typeof player !== "object") throw new Error("YouTube player data was unavailable");
  const captions = player.captions;
  const renderer = captions && captions.playerCaptionsTracklistRenderer;
  if (!renderer || !Array.isArray(renderer.captionTracks)) return [];
  return renderer.captionTracks;
}

function verifiedTimedtextUrl(value, expectedVideoId) {
  const baseUrl = typeof value === "string" ? value : "";
  // Only the fixed https www.youtube.com timedtext endpoint is permitted. The
  // expected v parameter ties the page-supplied track to this RSS video.
  const match = baseUrl.match(/^https:\/\/www\.youtube\.com\/api\/timedtext\?([A-Za-z0-9%._~!$'()*+,;=:@/&-]+)$/);
  if (!match || /(?:^|&)fmt=/i.test(match[1])) return "";
  const parts = match[1].split("&");
  let videoMatches = 0;
  for (const part of parts) {
    const equalAt = part.indexOf("=");
    const name = equalAt === -1 ? part : part.slice(0, equalAt);
    const valuePart = equalAt === -1 ? "" : part.slice(equalAt + 1);
    if (name === "v") {
      videoMatches++;
      if (valuePart !== expectedVideoId) return "";
    }
  }
  if (videoMatches !== 1) return "";
  return baseUrl + "&fmt=json3";
}

function supportedLanguage(value) {
  const language = typeof value === "string" ? value.trim() : "";
  return /^[A-Za-z0-9_-]{1,35}$/.test(language) ? language : "und";
}

function chooseCaptionTrack(tracks, expectedVideoId) {
  if (!Array.isArray(tracks) || tracks.length === 0) {
    throw terminalError("Public captions are not available for this video.", "unavailable");
  }
  let fallback = null;
  let sawMalformedTrack = false;
  for (const track of tracks) {
    if (!track || typeof track !== "object") {
      sawMalformedTrack = true;
      continue;
    }
    const url = verifiedTimedtextUrl(track.baseUrl, expectedVideoId);
    if (!url) {
      sawMalformedTrack = true;
      continue;
    }
    const language = supportedLanguage(track.languageCode);
    const candidate = { url: url, language: language };
    if (/^en(?:[-_].*)?$/i.test(language)) return candidate;
    if (!fallback) fallback = candidate;
  }
  if (fallback) return fallback;
  if (sawMalformedTrack) throw new Error("YouTube caption track data was unsafe or malformed");
  throw terminalError("Public captions are not available for this video.", "unavailable");
}

function normalizedCaptionText(value) {
  return decodeXml(String(value || "").replace(/<[^>]*>/g, ""))
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function boundedPassages(captionJson) {
  if (!captionJson || !Array.isArray(captionJson.events)) {
    throw new Error("YouTube captions returned malformed json3 data");
  }
  const passages = [];
  let current = null;
  let previousText = "";

  function flush() {
    if (!current || !current.text) return;
    current.text = current.text.slice(0, MAX_PASSAGE_CHARS).trim();
    if (current.text) passages.push(current);
    current = null;
  }

  for (let index = 0; index < captionJson.events.length && index < MAX_CAPTION_EVENTS; index++) {
    if (passages.length >= MAX_TRANSCRIPT_PASSAGES) break;
    const event = captionJson.events[index];
    if (!event || !Array.isArray(event.segs)) continue;
    const text = normalizedCaptionText(event.segs.map((segment) => segment && segment.utf8 ? segment.utf8 : "").join(""));
    if (!text || text === previousText) continue;
    previousText = text;
    const startMs = Number(event.tStartMs);
    const durationMs = Number(event.dDurationMs);
    if (!isFinite(startMs) || startMs < 0 || startMs > 864000000 || !isFinite(durationMs) || durationMs < 0) continue;
    const start = Math.round((startMs / 1000) * 1000) / 1000;
    const end = Math.round(((startMs + durationMs) / 1000) * 1000) / 1000;
    const gap = current ? start - current.end_seconds : 0;
    const combinedLength = current ? current.text.length + 1 + text.length : text.length;
    if (!current || gap > 12 || combinedLength > MAX_PASSAGE_CHARS) {
      flush();
      if (passages.length >= MAX_TRANSCRIPT_PASSAGES) break;
      current = { start_seconds: start, end_seconds: Math.max(start, end), text: text };
    } else {
      current.text += " " + text;
      current.end_seconds = Math.max(current.end_seconds, end, start);
    }
  }
  flush();
  if (!passages.length) {
    throw terminalError("Public captions did not contain readable transcript text.", "unavailable");
  }
  return passages;
}

function existingPassages(app, videoId, limit) {
  return app.findRecordsByFilter(
    "transcript_passages",
    "video = {:video}",
    "position",
    limit || 1,
    0,
    { video: videoId },
  );
}

function setCaptionState(app, video, state) {
  video.set("caption_status", state.status);
  video.set("caption_status_detail", String(state.detail || "").slice(0, 500));
  if (Object.prototype.hasOwnProperty.call(state, "language")) video.set("caption_language", state.language || "");
  if (Object.prototype.hasOwnProperty.call(state, "attempts")) video.set("caption_attempts", state.attempts);
  if (Object.prototype.hasOwnProperty.call(state, "lastAttemptAt")) video.set("caption_last_attempt_at", state.lastAttemptAt || "");
  if (Object.prototype.hasOwnProperty.call(state, "completedAt")) video.set("caption_completed_at", state.completedAt || "");
  app.save(video);
}

function setBriefState(app, video, state) {
  video.set("brief_status", state.status);
  video.set("brief_status_detail", String(state.detail || "").slice(0, 500));
  if (Object.prototype.hasOwnProperty.call(state, "attempts")) video.set("brief_attempts", state.attempts);
  if (Object.prototype.hasOwnProperty.call(state, "lastAttemptAt")) video.set("brief_last_attempt_at", state.lastAttemptAt || "");
  if (Object.prototype.hasOwnProperty.call(state, "completedAt")) video.set("brief_completed_at", state.completedAt || "");
  app.save(video);
}

function hasBrief(app, videoId) {
  try {
    return app.findRecordsByFilter("video_briefs", "video = {:video}", "-updated", 1, 0, { video: videoId }).length > 0;
  } catch (_) {
    // Some legacy data may predate audit fields; a brief's existence remains
    // enough to preserve it and prevent the automatic pipeline from replacing it.
    return app.findRecordsByFilter("video_briefs", "video = {:video}", "-id", 1, 0, { video: videoId }).length > 0;
  }
}

function boundedBriefTranscript(passages) {
  let transcript = "";
  for (const passage of passages) {
    const line = "[" + passage.getFloat("start_seconds") + "s-" + passage.getFloat("end_seconds") + "s] " + passage.getString("text").trim() + "\n";
    if (transcript.length + line.length > MAX_BRIEF_TRANSCRIPT_CHARS) {
      transcript += line.slice(0, Math.max(0, MAX_BRIEF_TRANSCRIPT_CHARS - transcript.length));
      break;
    }
    transcript += line;
  }
  return transcript.trim();
}

function processBrief(app, video) {
  const currentStatus = video.getString("brief_status");
  if (["ready", "failed", "not_applicable"].indexOf(currentStatus) !== -1) return;
  if (hasBrief(app, video.id)) {
    setBriefState(app, video, {
      status: "ready",
      detail: "An existing brief was retained.",
      completedAt: new Date().toISOString(),
    });
    return;
  }

  const attempts = Math.max(0, video.getInt("brief_attempts")) + 1;
  setBriefState(app, video, {
    status: "importing",
    detail: "Generating a source-grounded brief from the imported transcript.",
    attempts: attempts,
    lastAttemptAt: new Date().toISOString(),
  });

  try {
    const passages = existingPassages(app, video.id, MAX_TRANSCRIPT_PASSAGES);
    const transcript = boundedBriefTranscript(passages);
    if (!transcript) throw new Error("The imported transcript was empty");
    const apiKey = $os.getenv("OPENROUTER_API_KEY");
    if (!apiKey) throw new Error("Automatic briefs are not configured on this backend");
    const model = $os.getenv("OPENROUTER_MODEL") || "openrouter/free";
    const provider = $http.send({
      url: "https://openrouter.ai/api/v1/chat/completions",
      method: "POST",
      timeout: OPENROUTER_TIMEOUT_SECONDS,
      headers: {
        "Authorization": "Bearer " + apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: model,
        temperature: 0,
        messages: [
          {
            role: "system",
            content: "Write a concise plain-text brief using only the supplied transcript. Do not add facts, citations, speakers, or claims not explicitly supported by it. If the transcript is insufficient, say so plainly. Keep the brief under 1200 characters.",
          },
          { role: "user", content: "Transcript:\n" + transcript },
        ],
      }),
    });
    if (!provider || provider.statusCode < 200 || provider.statusCode >= 300) {
      throw new Error("Automatic brief provider returned " + (provider ? provider.statusCode : "no response"));
    }
    const summary = provider.json && provider.json.choices && provider.json.choices[0] && provider.json.choices[0].message && provider.json.choices[0].message.content;
    if (typeof summary !== "string" || !summary.trim()) throw new Error("Automatic brief provider returned no readable text");
    // Check again immediately before the write so a manually-created brief is
    // always retained rather than replaced by an automatic one.
    if (hasBrief(app, video.id)) {
      setBriefState(app, video, {
        status: "ready",
        detail: "An existing brief was retained.",
        completedAt: new Date().toISOString(),
      });
      return;
    }
    const briefs = app.findCollectionByNameOrId("video_briefs");
    const brief = new Record(briefs);
    brief.set("workspace", video.getString("workspace"));
    brief.set("video", video.id);
    brief.set("title", "Automatic brief: " + video.getString("title").slice(0, 270));
    brief.set("summary", summary.trim().slice(0, 1200));
    app.save(brief);
    setBriefState(app, video, {
      status: "ready",
      detail: "Generated from the imported public-caption transcript.",
      completedAt: new Date().toISOString(),
    });
  } catch (error) {
    // Transcript availability is already durable. Do not retry provider errors
    // automatically and risk rate-limit storms; expose the terminal status.
    setBriefState(app, video, {
      status: "failed",
      detail: "Automatic brief failed: " + conciseError(error),
      completedAt: new Date().toISOString(),
    });
    logWarning(app, "Automatic YouTube brief failed: " + conciseError(error), video.getString("channel"));
  }
}

function processCaptions(app, video) {
  // Any existing transcript may be a manually entered intake. It is preserved
  // exactly as-is; automatic ingestion neither overwrites nor appends to it.
  const existing = existingPassages(app, video.id, 1);
  if (existing.length) {
    setCaptionState(app, video, {
      status: "ready",
      detail: "An existing transcript was retained; public captions were not imported.",
      language: "",
    });
    if (!hasBrief(app, video.id)) {
      setBriefState(app, video, {
        status: "not_applicable",
        detail: "No automatic brief was generated because an existing transcript was retained.",
      });
    }
    return;
  }

  const attempts = Math.max(0, video.getInt("caption_attempts")) + 1;
  setCaptionState(app, video, {
    status: "importing",
    detail: "Loading public YouTube captions.",
    attempts: attempts,
    lastAttemptAt: new Date().toISOString(),
  });

  try {
    const videoId = videoIdFromValue(video.getString("youtube_video_id"));
    if (!videoId) throw new Error("The imported YouTube video ID was invalid");
    // This URL is constructed solely from the validated RSS ID; no source_url
    // or other stored user value is dereferenced during caption ingestion.
    const watchResponse = $http.send({
      url: "https://www.youtube.com/watch?v=" + videoId,
      method: "GET",
      timeout: YOUTUBE_CAPTION_TIMEOUT_SECONDS,
      headers: { "Accept": "text/html,application/xhtml+xml" },
    });
    if (!watchResponse || watchResponse.statusCode < 200 || watchResponse.statusCode >= 300) {
      const status = watchResponse ? watchResponse.statusCode : 0;
      if (status === 404 || status === 410) throw terminalError("The public YouTube video is unavailable.", "unavailable");
      throw new Error("YouTube watch page returned " + (status || "no response"));
    }
    const watchPage = textResponse(watchResponse);
    if (!watchPage || watchPage.length > MAX_YOUTUBE_PAGE_BODY_CHARS) throw new Error("YouTube watch page was unreadable");
    const track = chooseCaptionTrack(playerCaptionTracks(watchPage), videoId);
    const captionResponse = $http.send({
      url: track.url,
      method: "GET",
      timeout: YOUTUBE_CAPTION_TIMEOUT_SECONDS,
      headers: { "Accept": "application/json,text/plain" },
    });
    if (!captionResponse || captionResponse.statusCode < 200 || captionResponse.statusCode >= 300) {
      const status = captionResponse ? captionResponse.statusCode : 0;
      if (status >= 400 && status < 500) {
        throw terminalError("Public captions are unavailable for this video.", "unavailable");
      }
      throw new Error("YouTube captions returned " + (status || "no response"));
    }
    const rawCaption = textResponse(captionResponse);
    if (!rawCaption || rawCaption.length > MAX_HTTP_BODY_CHARS) throw new Error("YouTube captions were unreadable");
    let captionJson;
    try {
      captionJson = JSON.parse(rawCaption);
    } catch (_) {
      throw new Error("YouTube captions returned malformed json3 data");
    }
    const passages = boundedPassages(captionJson);
    const collection = app.findCollectionByNameOrId("transcript_passages");
    for (let position = 0; position < passages.length; position++) {
      const source = passages[position];
      const passage = new Record(collection);
      passage.set("workspace", video.getString("workspace"));
      passage.set("video", video.id);
      passage.set("position", position);
      passage.set("start_seconds", source.start_seconds);
      passage.set("end_seconds", source.end_seconds);
      passage.set("text", source.text);
      app.save(passage);
    }
    setCaptionState(app, video, {
      status: "ready",
      detail: "Imported " + passages.length + " public-caption transcript passage" + (passages.length === 1 ? "." : "s."),
      language: track.language,
      completedAt: new Date().toISOString(),
    });
  } catch (error) {
    if (error && error.terminalKind === "unavailable") {
      setCaptionState(app, video, {
        status: "unavailable",
        detail: conciseError(error),
        completedAt: new Date().toISOString(),
      });
      setBriefState(app, video, {
        status: "not_applicable",
        detail: "No automatic brief was generated because public captions are unavailable.",
      });
      return;
    }
    const terminal = attempts >= MAX_CAPTION_ATTEMPTS;
    setCaptionState(app, video, {
      status: terminal ? "failed" : "queued",
      detail: terminal
        ? "Public-caption import failed after " + attempts + " attempts: " + conciseError(error)
        : "Public-caption import could not complete; it will retry later (attempt " + attempts + " of " + MAX_CAPTION_ATTEMPTS + ").",
      completedAt: terminal ? new Date().toISOString() : "",
    });
    if (terminal) {
      setBriefState(app, video, {
        status: "not_applicable",
        detail: "No automatic brief was generated because public-caption import failed.",
      });
    }
    logWarning(app, "Automatic YouTube caption import failed: " + conciseError(error), video.getString("channel"));
  }
}

function pendingImportedVideos(app, channelId) {
  const stale = new Date(Date.now() - IMPORTING_STALE_MS).toISOString();
  return app.findRecordsByFilter(
    "videos",
    "channel = {:channel} && youtube_video_id != '' && (caption_status = '' || caption_status = 'queued' || (caption_status = 'importing' && (caption_last_attempt_at = '' || caption_last_attempt_at < {:stale})) || (caption_status = 'ready' && caption_completed_at != '' && (brief_status = '' || brief_status = 'pending' || (brief_status = 'importing' && (brief_last_attempt_at = '' || brief_last_attempt_at < {:stale})))))",
    "+created",
    MAX_PENDING_VIDEOS_PER_CHANNEL,
    0,
    { channel: channelId, stale: stale },
  );
}

function processPendingImportedVideos(app, channel) {
  let pending = [];
  try {
    pending = pendingImportedVideos(app, channel.id);
  } catch (error) {
    logWarning(app, "YouTube caption queue could not be read: " + conciseError(error), channel.id);
    return;
  }
  for (const video of pending) {
    try {
      const captionStatus = video.getString("caption_status");
      if (["", "queued", "importing"].indexOf(captionStatus) !== -1) processCaptions(app, video);
      // Only a transcript created by the automatic pipeline receives an
      // automatic brief. Existing manually entered transcript material remains
      // untouched and is never submitted to the provider from this queue.
      if (video.getString("caption_status") === "ready" && video.getString("caption_completed_at")) {
        processBrief(app, video);
      }
    } catch (error) {
      // Caption and brief state routines contain their own expected failures;
      // this final guard keeps RSS polling resilient to a bad queue record.
      logWarning(app, "YouTube imported-video processing failed: " + conciseError(error), channel.id);
    }
  }
}

function syncChannel(app, channel) {
  // Keep the actual resolution result outside the try block so a changed handle
  // that cannot resolve clears an old channel ID, while an RSS failure after a
  // successful resolution preserves the verified ID for a later retry.
  let channelId = "";
  try {
    const source = normalizedSource(channel.getString("youtube_url"));
    channelId = fetchPublicPageChannelId(source);
    const entries = readRss(channelId);
    let created = 0;
    for (const entry of entries) {
      try {
        if (upsertVideo(app, channel, entry)) created++;
      } catch (error) {
        // A malformed record must not prevent the remaining recent feed entries
        // from importing, nor affect a later channel in the cron batch.
        logWarning(app, "YouTube RSS video upsert failed: " + conciseError(error), channel.id);
      }
    }
    // RSS remains the primary poll. Caption and brief failures are isolated and
    // bounded, so they cannot prevent later feed entries or channels from sync.
    processPendingImportedVideos(app, channel);
    saveChannelState(app, channel, {
      channelId: channelId,
      lastSyncedAt: new Date().toISOString(),
      status: "Synced " + entries.length + " recent public video" + (entries.length === 1 ? "" : "s") + (created ? " (" + created + " new)." : "."),
    });
    return { ok: true, entries: entries.length, created: created };
  } catch (error) {
    const message = "YouTube sync failed: " + conciseError(error);
    try {
      // An empty channelId means public resolution failed, so remove any stale
      // value left by the prior URL. A resolved ID survives an RSS retry.
      saveChannelState(app, channel, { channelId: channelId, status: message });
    } catch (_) {
      logWarning(app, message, channel.id);
    }
    return { ok: false, error: message };
  }
}

function clearYoutubeState(app, channel) {
  saveChannelState(app, channel, {
    channelId: "",
    lastSyncedAt: "",
    status: "",
  });
}

function syncYoutubeChannels(app) {
  let channels = [];
  try {
    // A non-empty public URL is the explicit opt-in. The 30-minute cron below
    // bounds every run to a small batch; subsequent runs continue the queue.
    channels = app.findRecordsByFilter(
      "channels",
      "youtube_url != ''",
      "+youtube_last_synced_at",
      MAX_POLLED_CHANNELS,
      0,
    );
  } catch (error) {
    logWarning(app, "YouTube RSS poll could not list channels: " + conciseError(error), "");
    return;
  }
  for (const channel of channels) {
    try {
      syncChannel(app, channel);
    } catch (error) {
      // syncChannel normally contains errors, but cron must remain resilient to
      // future helper changes and one bad followed channel must never stop it.
      logWarning(app, "YouTube RSS poll failed: " + conciseError(error), channel.id);
    }
  }
}

module.exports = {
  syncChannel: syncChannel,
  syncYoutubeChannels: syncYoutubeChannels,
  clearYoutubeState: clearYoutubeState,
};
