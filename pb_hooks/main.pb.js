/// <reference path="../pb_data/types.d.ts" />

routerAdd("GET", "/api/supernaut/ready", (event) => {
  return event.json(200, { ok: true });
});

// Keep manual pilot data internally consistent. These hooks do not ingest or
// scrape captions; users create videos and transcript passages themselves.
onRecordCreateRequest((e) => {
  const { ensureRelatedWorkspace } = require(__hooks + "/practica_utils.js");
  ensureRelatedWorkspace(e.app, e.record.getString("workspace"), e.record.getString("channel"), "channels");
  return e.next();
}, "videos");
onRecordUpdateRequest((e) => {
  const { ensureRelatedWorkspace } = require(__hooks + "/practica_utils.js");
  ensureRelatedWorkspace(e.app, e.record.getString("workspace"), e.record.getString("channel"), "channels");
  return e.next();
}, "videos");

onRecordCreateRequest((e) => {
  const { ensureRelatedWorkspace } = require(__hooks + "/practica_utils.js");
  ensureRelatedWorkspace(e.app, e.record.getString("workspace"), e.record.getString("video"), "videos");
  return e.next();
}, "transcript_passages", "video_briefs", "qa_records");
onRecordUpdateRequest((e) => {
  const { ensureRelatedWorkspace } = require(__hooks + "/practica_utils.js");
  ensureRelatedWorkspace(e.app, e.record.getString("workspace"), e.record.getString("video"), "videos");
  return e.next();
}, "transcript_passages", "video_briefs", "qa_records");

onRecordCreateRequest((e) => {
  const { ensureRelatedWorkspace } = require(__hooks + "/practica_utils.js");
  ensureRelatedWorkspace(e.app, e.record.getString("workspace"), e.record.getString("passage"), "transcript_passages");
  ensureRelatedWorkspace(e.app, e.record.getString("workspace"), e.record.getString("video"), "videos");
  return e.next();
}, "highlights");
onRecordUpdateRequest((e) => {
  const { ensureRelatedWorkspace } = require(__hooks + "/practica_utils.js");
  ensureRelatedWorkspace(e.app, e.record.getString("workspace"), e.record.getString("passage"), "transcript_passages");
  ensureRelatedWorkspace(e.app, e.record.getString("workspace"), e.record.getString("video"), "videos");
  return e.next();
}, "highlights");

onRecordCreateRequest((e) => {
  const { ensureRelatedWorkspace } = require(__hooks + "/practica_utils.js");
  ensureRelatedWorkspace(e.app, e.record.getString("workspace"), e.record.getString("folder"), "research_folders");
  ensureRelatedWorkspace(e.app, e.record.getString("workspace"), e.record.getString("passage"), "transcript_passages");
  return e.next();
}, "saved_passage_items");
onRecordUpdateRequest((e) => {
  const { ensureRelatedWorkspace } = require(__hooks + "/practica_utils.js");
  ensureRelatedWorkspace(e.app, e.record.getString("workspace"), e.record.getString("folder"), "research_folders");
  ensureRelatedWorkspace(e.app, e.record.getString("workspace"), e.record.getString("passage"), "transcript_passages");
  return e.next();
}, "saved_passage_items");

// Create a grounded answer only from explicit, already-authorized transcript
// passages. The OpenRouter credential is read in this server hook only.
routerAdd("POST", "/api/practica/questions", (e) => {
  const { requiredString, selectedTranscript, passageCitation, parseModelAnswer } = require(__hooks + "/practica_utils.js");
  const body = e.requestInfo().body || {};
  const workspaceId = requiredString(body.workspace, "workspace", 15);
  const videoId = requiredString(body.video, "video", 15);
  const question = requiredString(body.question, "question", 4000);
  const context = selectedTranscript(e.app, e.auth.id, workspaceId, videoId, body.passage_ids);
  const apiKey = $os.getenv("OPENROUTER_API_KEY");
  if (!apiKey) {
    throw new ApiError(503, "Grounded Q&A is not configured. Set OPENROUTER_API_KEY on the backend.");
  }
  const model = $os.getenv("OPENROUTER_MODEL") || "meta-llama/llama-3.1-8b-instruct:free";
  const citations = context.passages.map(passageCitation);
  let transcript = "";
  for (const citation of citations) {
    transcript += "[passage_id=" + citation.passage_id + "; start=" + citation.start_seconds + "; end=" + citation.end_seconds + "] " + citation.text + "\n";
  }

  let provider;
  try {
    provider = $http.send({
      url: "https://openrouter.ai/api/v1/chat/completions",
      method: "POST",
      timeout: 60,
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
            content: "Answer only from the supplied transcript passages. Return strict JSON with exactly answer (string), supported (boolean), and citation_passage_ids (array of supplied IDs). Every supported answer must cite one or more supplied passage IDs. If the evidence does not support the question, return {\\\"answer\\\":\\\"Not supported by this transcript.\\\",\\\"supported\\\":false,\\\"citation_passage_ids\\\":[]}.",
          },
          { role: "user", content: "Question: " + question + "\n\nTranscript passages:\n" + transcript },
        ],
      }),
    });
  } catch (_) {
    throw new ApiError(502, "Grounded Q&A provider could not be reached. Please retry.");
  }
  if (provider.statusCode < 200 || provider.statusCode >= 300) {
    e.app.logger().warn("OpenRouter grounded Q&A request failed", "status", provider.statusCode);
    throw new ApiError(provider.statusCode === 429 ? 429 : 502, provider.statusCode === 429 ? "Grounded Q&A is temporarily rate limited. Please retry." : "Grounded Q&A provider failed. Please retry.");
  }

  const content = provider.json && provider.json.choices && provider.json.choices[0] && provider.json.choices[0].message && provider.json.choices[0].message.content;
  const answer = parseModelAnswer(content, body.passage_ids);
  const answerCitations = [];
  for (const citation of citations) {
    if (answer.citations.indexOf(citation.passage_id) !== -1) answerCitations.push(citation);
  }

  const qaCollection = e.app.findCollectionByNameOrId("qa_records");
  const qa = new Record(qaCollection);
  qa.set("workspace", workspaceId);
  qa.set("video", videoId);
  qa.set("created_by", e.auth.id);
  qa.set("question", question);
  qa.set("answer", answer.answer);
  qa.set("passage_ids", answer.citations);
  qa.set("citations", answerCitations);
  qa.set("model", model);
  e.app.save(qa);

  return e.json(201, {
    id: qa.id,
    answer: answer.answer,
    supported: answer.citations.length > 0,
    citations: answerCitations,
    model: model,
  });
}, $apis.requireAuth("users"));

// Return a verified citation projection for selected transcript passage IDs.
routerAdd("POST", "/api/practica/citations", (e) => {
  const { requiredString, selectedTranscript, passageCitation } = require(__hooks + "/practica_utils.js");
  const body = e.requestInfo().body || {};
  const workspaceId = requiredString(body.workspace, "workspace", 15);
  const videoId = requiredString(body.video, "video", 15);
  const context = selectedTranscript(e.app, e.auth.id, workspaceId, videoId, body.passage_ids);
  return e.json(200, {
    video_id: context.video.id,
    citations: context.passages.map(passageCitation),
  });
}, $apis.requireAuth("users"));

routerAdd("POST", "/api/practica/shares", (e) => {
  const { requireMembership, requiredString } = require(__hooks + "/practica_utils.js");
  const body = e.requestInfo().body || {};
  const workspaceId = requiredString(body.workspace, "workspace", 15);
  const videoId = requiredString(body.video, "video", 15);
  const scope = requiredString(body.scope, "scope", 20);
  if (["video", "brief", "transcript"].indexOf(scope) === -1) {
    throw new BadRequestError("scope must be video, brief, or transcript");
  }
  requireMembership(e.app, e.auth.id, workspaceId);
  let video;
  try {
    video = e.app.findRecordById("videos", videoId);
  } catch (_) {
    throw new NotFoundError("Video not found");
  }
  if (video.getString("workspace") !== workspaceId) throw new ForbiddenError("Video is not in this workspace");

  let expiresAt = "";
  if (body.expires_at) {
    if (typeof body.expires_at !== "string" || isNaN(new Date(body.expires_at).getTime()) || new Date(body.expires_at).getTime() <= Date.now()) {
      throw new BadRequestError("expires_at must be a future ISO date");
    }
    expiresAt = new Date(body.expires_at).toISOString();
  }
  const collection = e.app.findCollectionByNameOrId("public_shares");
  const share = new Record(collection);
  share.set("workspace", workspaceId);
  share.set("video", videoId);
  share.set("created_by", e.auth.id);
  share.set("token", $security.randomString(48));
  share.set("scope", scope);
  share.set("revoked", false);
  share.set("expires_at", expiresAt);
  e.app.save(share);
  return e.json(201, {
    id: share.id,
    token: share.getString("token"),
    scope: scope,
    expires_at: share.getString("expires_at"),
    resolve_path: "/api/practica/shares/" + share.getString("token"),
  });
}, $apis.requireAuth("users"));

routerAdd("POST", "/api/practica/shares/{id}/revoke", (e) => {
  const { requireMembership } = require(__hooks + "/practica_utils.js");
  let share;
  try {
    share = e.app.findRecordById("public_shares", e.request.pathValue("id"));
  } catch (_) {
    throw new NotFoundError("Share not found");
  }
  requireMembership(e.app, e.auth.id, share.getString("workspace"));
  if (share.getString("created_by") !== e.auth.id) {
    throw new ForbiddenError("Only the share creator can revoke it");
  }
  share.set("revoked", true);
  e.app.save(share);
  return e.json(200, { id: share.id, revoked: true });
}, $apis.requireAuth("users"));

// This is the only public access path. It deliberately emits a tiny projection
// for the requested scope and never serializes notes, highlights, Q&A history,
// members, or other workspace records.
routerAdd("GET", "/api/practica/shares/{token}", (e) => {
  let share;
  try {
    share = e.app.findFirstRecordByFilter(
      "public_shares",
      "token = {:token} && revoked = false && (expires_at = '' || expires_at > @now)",
      { token: e.request.pathValue("token") },
    );
  } catch (_) {
    throw new NotFoundError("Share not found or has expired");
  }
  let video;
  try {
    video = e.app.findRecordById("videos", share.getString("video"));
  } catch (_) {
    throw new NotFoundError("Shared video is unavailable");
  }
  const projection = {
    scope: share.getString("scope"),
    video: {
      id: video.id,
      title: video.getString("title"),
      source_url: video.getString("source_url"),
      duration_seconds: video.getFloat("duration_seconds"),
    },
  };
  if (share.getString("scope") === "brief") {
    const briefs = e.app.findRecordsByFilter("video_briefs", "video = {:video}", "-updated", 1, 0, { video: video.id });
    projection.brief = briefs.length ? {
      id: briefs[0].id,
      title: briefs[0].getString("title"),
      summary: briefs[0].getString("summary"),
    } : null;
  }
  if (share.getString("scope") === "transcript") {
    const passages = e.app.findRecordsByFilter("transcript_passages", "video = {:video}", "position", 500, 0, { video: video.id });
    projection.transcript = passages.map((passage) => ({
      id: passage.id,
      position: passage.getInt("position"),
      start_seconds: passage.getFloat("start_seconds"),
      end_seconds: passage.getFloat("end_seconds"),
      speaker: passage.getString("speaker"),
      text: passage.getString("text"),
    }));
  }
  return e.json(200, projection);
});
