// Public YouTube channel resolution and RSS ingestion helpers.
//
// This module intentionally uses only PocketBase's embedded JS APIs. It is
// required inside each hook/cron callback because PocketBase isolates callback
// VMs. No YouTube Data API key or caption/transcript fetching is involved.

const YOUTUBE_PAGE_TIMEOUT_SECONDS = 10;
const YOUTUBE_RSS_TIMEOUT_SECONDS = 10;
const MAX_HTTP_BODY_CHARS = 1000000;
const MAX_RECENT_VIDEOS = 20;
const MAX_POLLED_CHANNELS = 20;

function textResponse(response) {
  if (response && typeof response.raw === "string") return response.raw;
  // PocketBase versions have exposed the response body under raw; retain this
  // fallback to make an unexpected adapter shape fail closed rather than parse
  // an object as feed content.
  if (response && typeof response.body === "string") return response.body;
  return "";
}

function conciseError(error) {
  const message = error && error.message ? String(error.message) : String(error || "Unknown error");
  return message.replace(/[\r\n\t]+/g, " ").trim().slice(0, 360);
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
  if (!body || body.length > MAX_HTTP_BODY_CHARS) throw new Error("YouTube channel page was unreadable");

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
