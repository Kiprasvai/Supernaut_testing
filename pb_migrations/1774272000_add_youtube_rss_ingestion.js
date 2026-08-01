/// <reference path="../pb_data/types.d.ts" />

// Public YouTube RSS ingestion is optional. These fields leave existing manual
// channels and videos untouched, while the partial unique index makes repeated
// polls safe for every followed channel.
migrate((app) => {
  function fieldName(field) {
    if (field.name !== undefined) return field.name;
    return field.get("name");
  }

  function indexName(index) {
    const match = String(index).match(/INDEX\s+[`\"]?([^`\"\s(]+)/i);
    return match ? match[1] : String(index);
  }

  function addMissingFields(collection, fields) {
    const known = {};
    for (const field of collection.fields || []) known[fieldName(field)] = true;
    const additions = [];
    for (const field of fields) {
      if (!known[fieldName(field)]) additions.push(field);
    }
    if (additions.length) {
      collection.fields = (collection.fields || []).concat(additions);
    }
  }

  function addMissingIndexes(collection, indexes) {
    const known = {};
    for (const index of collection.indexes || []) known[indexName(index)] = true;
    const additions = [];
    for (const index of indexes) {
      if (!known[indexName(index)]) additions.push(index);
    }
    if (additions.length) {
      collection.indexes = (collection.indexes || []).concat(additions);
    }
  }

  let channels;
  let videos;
  try {
    channels = app.findCollectionByNameOrId("channels");
    videos = app.findCollectionByNameOrId("videos");
  } catch (_) {
    // The original schema migration owns these collections. Skipping safely
    // keeps a partially initialized deployment bootable and rerunnable.
    return;
  }

  addMissingFields(channels, [
    // A non-empty URL is the opt-in for public polling; manual channels leave
    // these optional source fields blank.
    new TextField({ name: "youtube_url", max: 2000 }),
    new TextField({ name: "youtube_channel_id", max: 64 }),
    new DateField({ name: "youtube_last_synced_at" }),
    new TextField({ name: "youtube_sync_status", max: 500 }),
  ]);
  app.save(channels);

  addMissingFields(videos, [
    new TextField({ name: "youtube_video_id", max: 32 }),
    new DateField({ name: "youtube_published_at" }),
  ]);
  // Multiple manual videos can continue to have an empty YouTube ID. Only an
  // imported ID is unique within its followed channel.
  addMissingIndexes(videos, [
    "CREATE UNIQUE INDEX idx_practica_videos_channel_youtube_video ON videos (channel, youtube_video_id) WHERE youtube_video_id != ''",
  ]);
  app.save(videos);
}, (app) => {
  // Forward-only, additive production migration: do not remove source data or
  // the duplicate-prevention index on rollback.
});
