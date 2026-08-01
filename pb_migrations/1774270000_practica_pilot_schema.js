/// <reference path="../pb_data/types.d.ts" />

// Practica's pilot schema. The migration is intentionally additive: it reuses
// pre-existing collections and fields so it is safe after a partial boot or on
// a persistent deployment.
migrate((app) => {
  function collection(name, type) {
    try {
      return app.findCollectionByNameOrId(name);
    } catch (_) {
      return new Collection({ name: name, type: type || "base" });
    }
  }

  function fieldName(field) {
    return field.name || field.get("name");
  }

  function indexName(index) {
    const match = String(index).match(/INDEX\s+[`\"]?([^`\"\s(]+)/i);
    return match ? match[1] : String(index);
  }

  function saveCollection(target, fields, rules, indexes) {
    const replacements = {};
    for (const field of fields) replacements[fieldName(field)] = field;

    // Do not discard fields added by a prior deployment or from the dashboard.
    const retained = (target.fields || []).filter((field) => !replacements[fieldName(field)]);
    target.fields = retained.concat(fields);
    target.listRule = rules.list;
    target.viewRule = rules.view;
    target.createRule = rules.create;
    target.updateRule = rules.update;
    target.deleteRule = rules.delete;

    const current = target.indexes || [];
    const known = {};
    for (const index of current) known[indexName(index)] = true;
    for (const index of indexes || []) {
      if (!known[indexName(index)]) current.push(index);
    }
    target.indexes = current;
    return app.save(target);
  }

  const users = collection("users", "auth");
  // The provisioner creates this auth collection. Keep it authentication-ready
  // while ensuring callers can only read or modify their own profile.
  users.listRule = "id = @request.auth.id";
  users.viewRule = "id = @request.auth.id";
  users.createRule = "";
  users.updateRule = "id = @request.auth.id";
  users.deleteRule = "id = @request.auth.id";
  app.save(users);

  const workspaces = collection("workspaces");
  saveCollection(workspaces, [
    new TextField({ name: "name", required: true, max: 160 }),
    new RelationField({ name: "owner", collectionId: users.id, required: true, maxSelect: 1, cascadeDelete: true }),
  ], {
    // The members collection is created immediately below. Start with owner
    // access so rule validation does not reference a collection not yet saved.
    list: "@request.auth.id != '' && owner = @request.auth.id",
    view: "@request.auth.id != '' && owner = @request.auth.id",
    create: "@request.auth.id != '' && @request.body.owner = @request.auth.id",
    update: "owner = @request.auth.id && @request.body.owner:changed = false",
    delete: "owner = @request.auth.id",
  }, ["CREATE INDEX idx_practica_workspaces_owner ON workspaces (owner)"]);

  const members = collection("members");
  saveCollection(members, [
    new RelationField({ name: "workspace", collectionId: workspaces.id, required: true, maxSelect: 1, cascadeDelete: true }),
    new RelationField({ name: "user", collectionId: users.id, required: true, maxSelect: 1, cascadeDelete: true }),
    new SelectField({ name: "role", values: ["owner", "editor", "viewer"], required: true, maxSelect: 1 }),
  ], {
    list: "@request.auth.id != '' && (user = @request.auth.id || workspace.owner = @request.auth.id)",
    view: "@request.auth.id != '' && (user = @request.auth.id || workspace.owner = @request.auth.id)",
    create: "@request.auth.id != '' && workspace.owner = @request.auth.id",
    update: "workspace.owner = @request.auth.id && @request.body.workspace:changed = false && @request.body.user:changed = false",
    delete: "workspace.owner = @request.auth.id",
  }, [
    "CREATE UNIQUE INDEX idx_practica_members_workspace_user ON members (workspace, user)",
    "CREATE INDEX idx_practica_members_user ON members (user)",
  ]);

  // Now that members exists, workspace members may read their workspace while
  // only the owner retains workspace-management rights.
  workspaces.listRule = "@request.auth.id != '' && (owner = @request.auth.id || (@collection.members.workspace ?= id && @collection.members.user ?= @request.auth.id))";
  workspaces.viewRule = "@request.auth.id != '' && (owner = @request.auth.id || (@collection.members.workspace ?= id && @collection.members.user ?= @request.auth.id))";
  app.save(workspaces);

  const memberRule = "@request.auth.id != '' && @collection.members.workspace ?= workspace && @collection.members.user ?= @request.auth.id";
  const memberBodyRule = "@request.auth.id != '' && @collection.members.workspace ?= @request.body.workspace && @collection.members.user ?= @request.auth.id";
  const workspaceRules = (allowCreate) => ({
    list: memberRule,
    view: memberRule,
    create: allowCreate ? memberBodyRule : null,
    update: memberRule + " && @request.body.workspace:changed = false",
    delete: memberRule,
  });

  const channels = collection("channels");
  saveCollection(channels, [
    new RelationField({ name: "workspace", collectionId: workspaces.id, required: true, maxSelect: 1, cascadeDelete: true }),
    new TextField({ name: "name", required: true, max: 160 }),
    new TextField({ name: "description", max: 2000 }),
  ], workspaceRules(true), ["CREATE INDEX idx_practica_channels_workspace ON channels (workspace)"]);

  const videos = collection("videos");
  saveCollection(videos, [
    new RelationField({ name: "workspace", collectionId: workspaces.id, required: true, maxSelect: 1, cascadeDelete: true }),
    new RelationField({ name: "channel", collectionId: channels.id, maxSelect: 1, cascadeDelete: false }),
    new TextField({ name: "title", required: true, max: 300 }),
    new TextField({ name: "source_url", max: 2000 }),
    new NumberField({ name: "duration_seconds", min: 0 }),
    new BoolField({ name: "manual_source" }),
    new TextField({ name: "notes", max: 10000 }),
  ], workspaceRules(true), ["CREATE INDEX idx_practica_videos_workspace ON videos (workspace)"]);

  const transcriptPassages = collection("transcript_passages");
  saveCollection(transcriptPassages, [
    new RelationField({ name: "workspace", collectionId: workspaces.id, required: true, maxSelect: 1, cascadeDelete: true }),
    new RelationField({ name: "video", collectionId: videos.id, required: true, maxSelect: 1, cascadeDelete: true }),
    // PocketBase treats numeric 0 as blank for required fields; allow 0 so a
    // first manual passage can start at position zero.
    new NumberField({ name: "position", min: 0 }),
    new NumberField({ name: "start_seconds", min: 0 }),
    new NumberField({ name: "end_seconds", min: 0 }),
    new TextField({ name: "speaker", max: 160 }),
    new TextField({ name: "text", required: true, max: 20000 }),
  ], workspaceRules(true), [
    "CREATE INDEX idx_practica_passages_workspace_video_position ON transcript_passages (workspace, video, position)",
  ]);

  const videoBriefs = collection("video_briefs");
  saveCollection(videoBriefs, [
    new RelationField({ name: "workspace", collectionId: workspaces.id, required: true, maxSelect: 1, cascadeDelete: true }),
    new RelationField({ name: "video", collectionId: videos.id, required: true, maxSelect: 1, cascadeDelete: true }),
    new TextField({ name: "title", max: 300 }),
    new TextField({ name: "summary", required: true, max: 30000 }),
    new RelationField({ name: "created_by", collectionId: users.id, maxSelect: 1, cascadeDelete: true }),
  ], workspaceRules(true), ["CREATE INDEX idx_practica_briefs_workspace_video ON video_briefs (workspace, video)"]);

  const qaRecords = collection("qa_records");
  saveCollection(qaRecords, [
    new RelationField({ name: "workspace", collectionId: workspaces.id, required: true, maxSelect: 1, cascadeDelete: true }),
    new RelationField({ name: "video", collectionId: videos.id, required: true, maxSelect: 1, cascadeDelete: true }),
    new RelationField({ name: "created_by", collectionId: users.id, required: true, maxSelect: 1, cascadeDelete: true }),
    new TextField({ name: "question", required: true, max: 4000 }),
    new TextField({ name: "answer", required: true, max: 30000 }),
    new RelationField({ name: "passage_ids", collectionId: transcriptPassages.id, maxSelect: 50, cascadeDelete: false }),
    new JSONField({ name: "citations", maxSize: 50000 }),
    new TextField({ name: "model", max: 300 }),
  ], {
    list: "@request.auth.id != '' && created_by = @request.auth.id && @collection.members.workspace ?= workspace && @collection.members.user ?= @request.auth.id",
    view: "@request.auth.id != '' && created_by = @request.auth.id && @collection.members.workspace ?= workspace && @collection.members.user ?= @request.auth.id",
    create: null,
    update: null,
    delete: "@request.auth.id != '' && created_by = @request.auth.id && @collection.members.workspace ?= workspace && @collection.members.user ?= @request.auth.id",
  }, ["CREATE INDEX idx_practica_qa_user_workspace ON qa_records (created_by, workspace)"]);

  const highlights = collection("highlights");
  saveCollection(highlights, [
    new RelationField({ name: "workspace", collectionId: workspaces.id, required: true, maxSelect: 1, cascadeDelete: true }),
    new RelationField({ name: "video", collectionId: videos.id, required: true, maxSelect: 1, cascadeDelete: true }),
    new RelationField({ name: "passage", collectionId: transcriptPassages.id, maxSelect: 1, cascadeDelete: false }),
    new RelationField({ name: "created_by", collectionId: users.id, required: true, maxSelect: 1, cascadeDelete: true }),
    new TextField({ name: "note", max: 10000 }),
    new TextField({ name: "color", max: 40 }),
  ], {
    list: "@request.auth.id != '' && created_by = @request.auth.id && @collection.members.workspace ?= workspace && @collection.members.user ?= @request.auth.id",
    view: "@request.auth.id != '' && created_by = @request.auth.id && @collection.members.workspace ?= workspace && @collection.members.user ?= @request.auth.id",
    create: "@request.auth.id != '' && @request.body.created_by = @request.auth.id && @collection.members.workspace ?= @request.body.workspace && @collection.members.user ?= @request.auth.id",
    update: "@request.auth.id != '' && created_by = @request.auth.id && @request.body.created_by:changed = false && @request.body.workspace:changed = false && @collection.members.workspace ?= workspace && @collection.members.user ?= @request.auth.id",
    delete: "@request.auth.id != '' && created_by = @request.auth.id && @collection.members.workspace ?= workspace && @collection.members.user ?= @request.auth.id",
  }, ["CREATE INDEX idx_practica_highlights_user_workspace ON highlights (created_by, workspace)"]);

  const folders = collection("research_folders");
  saveCollection(folders, [
    new RelationField({ name: "workspace", collectionId: workspaces.id, required: true, maxSelect: 1, cascadeDelete: true }),
    new RelationField({ name: "created_by", collectionId: users.id, required: true, maxSelect: 1, cascadeDelete: true }),
    new TextField({ name: "name", required: true, max: 160 }),
  ], {
    list: "@request.auth.id != '' && created_by = @request.auth.id && @collection.members.workspace ?= workspace && @collection.members.user ?= @request.auth.id",
    view: "@request.auth.id != '' && created_by = @request.auth.id && @collection.members.workspace ?= workspace && @collection.members.user ?= @request.auth.id",
    create: "@request.auth.id != '' && @request.body.created_by = @request.auth.id && @collection.members.workspace ?= @request.body.workspace && @collection.members.user ?= @request.auth.id",
    update: "@request.auth.id != '' && created_by = @request.auth.id && @request.body.created_by:changed = false && @request.body.workspace:changed = false && @collection.members.workspace ?= workspace && @collection.members.user ?= @request.auth.id",
    delete: "@request.auth.id != '' && created_by = @request.auth.id && @collection.members.workspace ?= workspace && @collection.members.user ?= @request.auth.id",
  }, ["CREATE INDEX idx_practica_folders_user_workspace ON research_folders (created_by, workspace)"]);

  const savedPassages = collection("saved_passage_items");
  saveCollection(savedPassages, [
    new RelationField({ name: "workspace", collectionId: workspaces.id, required: true, maxSelect: 1, cascadeDelete: true }),
    new RelationField({ name: "folder", collectionId: folders.id, maxSelect: 1, cascadeDelete: false }),
    new RelationField({ name: "passage", collectionId: transcriptPassages.id, required: true, maxSelect: 1, cascadeDelete: true }),
    new RelationField({ name: "created_by", collectionId: users.id, required: true, maxSelect: 1, cascadeDelete: true }),
    new TextField({ name: "note", max: 10000 }),
  ], {
    list: "@request.auth.id != '' && created_by = @request.auth.id && @collection.members.workspace ?= workspace && @collection.members.user ?= @request.auth.id",
    view: "@request.auth.id != '' && created_by = @request.auth.id && @collection.members.workspace ?= workspace && @collection.members.user ?= @request.auth.id",
    create: "@request.auth.id != '' && @request.body.created_by = @request.auth.id && @collection.members.workspace ?= @request.body.workspace && @collection.members.user ?= @request.auth.id",
    update: "@request.auth.id != '' && created_by = @request.auth.id && @request.body.created_by:changed = false && @request.body.workspace:changed = false && @collection.members.workspace ?= workspace && @collection.members.user ?= @request.auth.id",
    delete: "@request.auth.id != '' && created_by = @request.auth.id && @collection.members.workspace ?= workspace && @collection.members.user ?= @request.auth.id",
  }, ["CREATE INDEX idx_practica_saved_passages_user_workspace ON saved_passage_items (created_by, workspace)"]);

  const shares = collection("public_shares");
  saveCollection(shares, [
    new RelationField({ name: "workspace", collectionId: workspaces.id, required: true, maxSelect: 1, cascadeDelete: true }),
    new RelationField({ name: "video", collectionId: videos.id, required: true, maxSelect: 1, cascadeDelete: true }),
    new RelationField({ name: "created_by", collectionId: users.id, required: true, maxSelect: 1, cascadeDelete: true }),
    new TextField({ name: "token", required: true, max: 100 }),
    new SelectField({ name: "scope", values: ["video", "brief", "transcript"], required: true, maxSelect: 1 }),
    new BoolField({ name: "revoked" }),
    new DateField({ name: "expires_at" }),
  ], { list: null, view: null, create: null, update: null, delete: null }, [
    "CREATE UNIQUE INDEX idx_practica_public_shares_token ON public_shares (token)",
    "CREATE INDEX idx_practica_public_shares_video ON public_shares (video)",
  ]);
}, (app) => {
  // This pilot migration is deliberately non-destructive: persistent pilot data
  // must never be dropped merely because a deployment is rolled back.
});
