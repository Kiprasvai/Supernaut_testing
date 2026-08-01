/// <reference path="../pb_data/types.d.ts" />

// Forward-only state for the bounded public-caption pipeline. These optional
// fields are only meaningful for RSS-imported videos and leave manual intake
// records and all platform-managed collections untouched.
migrate((app) => {
  function fieldName(field) {
    if (field.name !== undefined) return field.name;
    return field.get("name");
  }

  function indexName(index) {
    const match = String(index).match(/INDEX\s+[`\"]?([^`\"\s(]+)/i);
    return match ? match[1] : String(index);
  }

  let videos;
  try {
    videos = app.findCollectionByNameOrId("videos");
  } catch (_) {
    // The pilot schema owns this collection. Skipping keeps a partial setup
    // bootable and lets this new migration safely run again on the next boot.
    return;
  }

  const fields = videos.fields || [];
  const knownFields = {};
  for (const field of fields) knownFields[fieldName(field)] = true;
  const additions = [
    new SelectField({ name: "caption_status", values: ["queued", "importing", "ready", "unavailable", "failed"], maxSelect: 1 }),
    new TextField({ name: "caption_status_detail", max: 500 }),
    new TextField({ name: "caption_language", max: 40 }),
    new NumberField({ name: "caption_attempts", min: 0 }),
    new DateField({ name: "caption_last_attempt_at" }),
    new DateField({ name: "caption_completed_at" }),
    new SelectField({ name: "brief_status", values: ["pending", "importing", "ready", "failed", "not_applicable"], maxSelect: 1 }),
    new TextField({ name: "brief_status_detail", max: 500 }),
    new NumberField({ name: "brief_attempts", min: 0 }),
    new DateField({ name: "brief_last_attempt_at" }),
    new DateField({ name: "brief_completed_at" }),
  ];
  for (const field of additions) {
    if (!knownFields[fieldName(field)]) fields.push(field);
  }
  videos.fields = fields;

  // Channel sync reads a very small pending batch. This index avoids repeatedly
  // scanning an entire followed channel as its historical feed is drained.
  const knownIndexes = {};
  for (const index of videos.indexes || []) knownIndexes[indexName(index)] = true;
  if (!knownIndexes.idx_practica_videos_channel_caption_status) {
    videos.indexes = (videos.indexes || []).concat([
      "CREATE INDEX idx_practica_videos_channel_caption_status ON videos (channel, caption_status)",
    ]);
  }
  app.save(videos);
}, (app) => {
  // Do not remove durable ingestion state or indexes from a persistent volume.
});
