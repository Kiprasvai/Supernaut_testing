/// <reference path="../pb_data/types.d.ts" />

// Per-reader brief and point history for novelty annotations. This is additive and
// idempotent so a boot interrupted after either collection is saved can retry.
migrate((app) => {
  function fieldName(field) {
    return field.name !== undefined ? field.name : field.get("name");
  }

  function indexName(index) {
    const match = String(index).match(/INDEX\s+[`\"]?([^`\"\s(]+)/i);
    return match ? match[1] : String(index);
  }

  function ensureFields(target, additions) {
    const existing = {};
    for (const field of target.fields || []) existing[fieldName(field)] = true;
    const fields = target.fields || [];
    for (const field of additions) {
      if (!existing[fieldName(field)]) fields.push(field);
    }
    target.fields = fields;
  }

  function ensureIndexes(target, additions) {
    const indexes = target.indexes || [];
    const existing = {};
    for (const index of indexes) existing[indexName(index)] = true;
    for (const index of additions) {
      if (!existing[indexName(index)]) indexes.push(index);
    }
    target.indexes = indexes;
  }

  let users;
  let workspaces;
  let briefs;
  try {
    users = app.findCollectionByNameOrId("users");
    workspaces = app.findCollectionByNameOrId("workspaces");
    briefs = app.findCollectionByNameOrId("video_briefs");
  } catch (_) {
    // Earlier migrations own these collections. Do not create incomplete
    // relations when a partially initialized deployment is still recovering.
    return;
  }

  const privateRule = "@request.auth.id != '' && user = @request.auth.id && @collection.members.workspace ?= workspace && @collection.members.user ?= @request.auth.id";

  let briefReads;
  try {
    briefReads = app.findCollectionByNameOrId("reader_brief_reads");
  } catch (_) {
    briefReads = new Collection({ name: "reader_brief_reads", type: "base" });
  }
  ensureFields(briefReads, [
    new RelationField({ name: "workspace", collectionId: workspaces.id, required: true, maxSelect: 1, cascadeDelete: true }),
    new RelationField({ name: "user", collectionId: users.id, required: true, maxSelect: 1, cascadeDelete: true }),
    new RelationField({ name: "brief", collectionId: briefs.id, required: true, maxSelect: 1, cascadeDelete: true }),
    new DateField({ name: "opened_at", required: true }),
    new AutodateField({ name: "created", onCreate: true, onUpdate: false }),
    new AutodateField({ name: "updated", onCreate: true, onUpdate: true }),
  ]);
  briefReads.listRule = privateRule;
  briefReads.viewRule = privateRule;
  // Custom authenticated routes own all writes; clients cannot forge history.
  briefReads.createRule = null;
  briefReads.updateRule = null;
  briefReads.deleteRule = null;
  ensureIndexes(briefReads, [
    "CREATE UNIQUE INDEX idx_practica_reader_brief_reads_workspace_user_brief ON reader_brief_reads (workspace, user, brief)",
    "CREATE INDEX idx_practica_reader_brief_reads_user_workspace ON reader_brief_reads (user, workspace)",
  ]);
  app.save(briefReads);

  let pointReads;
  try {
    pointReads = app.findCollectionByNameOrId("reader_point_reads");
  } catch (_) {
    pointReads = new Collection({ name: "reader_point_reads", type: "base" });
  }
  ensureFields(pointReads, [
    new RelationField({ name: "workspace", collectionId: workspaces.id, required: true, maxSelect: 1, cascadeDelete: true }),
    new RelationField({ name: "user", collectionId: users.id, required: true, maxSelect: 1, cascadeDelete: true }),
    new RelationField({ name: "brief", collectionId: briefs.id, required: true, maxSelect: 1, cascadeDelete: true }),
    new TextField({ name: "point_key", required: true, max: 100 }),
    new TextField({ name: "point_text", required: true, max: 4000 }),
    new SelectField({ name: "novelty_status", values: ["new", "update", "repeated"], required: true, maxSelect: 1 }),
    new NumberField({ name: "similarity", min: 0, max: 1 }),
    new TextField({ name: "matched_text", max: 4000 }),
    // Store the brief's creation time so comparison remains based on earlier
    // briefs rather than the time a reader happened to reveal a point.
    new DateField({ name: "brief_created_at", required: true }),
    new DateField({ name: "revealed_at", required: true }),
    new AutodateField({ name: "created", onCreate: true, onUpdate: false }),
    new AutodateField({ name: "updated", onCreate: true, onUpdate: true }),
  ]);
  pointReads.listRule = privateRule;
  pointReads.viewRule = privateRule;
  pointReads.createRule = null;
  pointReads.updateRule = null;
  pointReads.deleteRule = null;
  ensureIndexes(pointReads, [
    "CREATE UNIQUE INDEX idx_practica_reader_point_reads_workspace_user_brief_key ON reader_point_reads (workspace, user, brief, point_key)",
    "CREATE INDEX idx_practica_reader_point_reads_user_workspace_brief_created ON reader_point_reads (user, workspace, brief_created_at)",
  ]);
  app.save(pointReads);
}, (app) => {
  // Forward-only migration: retain private reading history and audit evidence on rollback.
});
