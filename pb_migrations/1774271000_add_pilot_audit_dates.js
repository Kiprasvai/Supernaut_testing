/// <reference path="../pb_data/types.d.ts" />

// Older pilot collections were initially saved without PocketBase's automatic
// audit fields. Keep this as a separate, additive migration so it also repairs
// persistent databases that have already applied the original pilot schema.
migrate((app) => {
  const pilotCollections = [
    "workspaces",
    "members",
    "channels",
    "videos",
    "transcript_passages",
    "video_briefs",
    "qa_records",
    "highlights",
    "research_folders",
    "saved_passage_items",
    "public_shares",
  ];

  function fieldValue(field, name) {
    if (field[name] !== undefined) return field[name];
    return field.get(name);
  }

  function fieldName(field) {
    return fieldValue(field, "name");
  }

  function isExpectedAutodate(field, onUpdate) {
    return fieldValue(field, "type") === "autodate" &&
      fieldValue(field, "onCreate") === true &&
      fieldValue(field, "onUpdate") === onUpdate;
  }

  for (const name of pilotCollections) {
    let collection;
    try {
      collection = app.findCollectionByNameOrId(name);
    } catch (_) {
      // The original migration creates all pilot collections. Skipping an
      // absent collection keeps this forward repair safe after partial setups.
      continue;
    }

    let foundCreated = false;
    let foundUpdated = false;
    let replaceCreated = false;
    let replaceUpdated = false;
    const retained = [];
    for (const field of collection.fields || []) {
      const name = fieldName(field);
      if (name === "created") {
        foundCreated = true;
        if (isExpectedAutodate(field, false)) retained.push(field);
        else replaceCreated = true;
      } else if (name === "updated") {
        foundUpdated = true;
        if (isExpectedAutodate(field, true)) retained.push(field);
        else replaceUpdated = true;
      } else {
        retained.push(field);
      }
    }

    if (!foundCreated) replaceCreated = true;
    if (!foundUpdated) replaceUpdated = true;
    if (!replaceCreated && !replaceUpdated) continue;

    // Replacing only missing or malformed audit fields preserves every other
    // field (including an already-correct audit timestamp), record, index, and
    // API rule. Autodate fields apply to all future writes.
    if (replaceCreated) retained.push(new AutodateField({ name: "created", onCreate: true, onUpdate: false }));
    if (replaceUpdated) retained.push(new AutodateField({ name: "updated", onCreate: true, onUpdate: true }));
    collection.fields = retained;
    app.save(collection);
  }
}, (app) => {
  // Forward-only repair: rolling back must not remove audit fields or data.
});
