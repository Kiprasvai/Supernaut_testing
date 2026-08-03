/// <reference path="../pb_data/types.d.ts" />

// Store verified source-point citations for automatic briefs without changing
// manual briefs or any platform-managed collection.
migrate((app) => {
  function fieldName(field) {
    if (field.name !== undefined) return field.name;
    return field.get("name");
  }

  let briefs;
  try {
    briefs = app.findCollectionByNameOrId("video_briefs");
  } catch (_) {
    // The pilot schema owns this collection. Skipping keeps a partial setup
    // bootable; an unrecorded migration can safely run again on the next boot.
    return;
  }

  const fields = briefs.fields || [];
  for (const field of fields) {
    // A prior partial migration may already have persisted the field before its
    // migration record was written. Do not replace it or touch existing records.
    if (fieldName(field) === "source_points") return;
  }
  fields.push(new JSONField({ name: "source_points", maxSize: 50000 }));
  briefs.fields = fields;
  app.save(briefs);
}, (app) => {
  // Forward-only production migration: retain stored source citations on rollback.
});
