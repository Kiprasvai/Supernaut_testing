// Loaded from route handlers with require(__hooks + "/practica_utils.js").
// Keep security-sensitive record checks in one server-only module.
function requireMembership(app, userId, workspaceId) {
  if (!workspaceId) throw new BadRequestError("workspace is required");
  try {
    app.findFirstRecordByFilter(
      "members",
      "workspace = {:workspace} && user = {:user}",
      { workspace: workspaceId, user: userId },
    );
  } catch (_) {
    throw new ForbiddenError("You do not have access to this workspace");
  }
}

function requiredString(value, field, maxLength) {
  if (typeof value !== "string" || !value.trim()) {
    throw new BadRequestError(field + " is required");
  }
  const normalized = value.trim();
  if (maxLength && normalized.length > maxLength) {
    throw new BadRequestError(field + " is too long");
  }
  return normalized;
}

function ensureRelatedWorkspace(app, workspaceId, relatedId, collection) {
  if (!relatedId) return;
  let related;
  try {
    related = app.findRecordById(collection, relatedId);
  } catch (_) {
    throw new BadRequestError("Related " + collection + " record was not found");
  }
  if (related.getString("workspace") !== workspaceId) {
    throw new BadRequestError("Related " + collection + " record must belong to the same workspace");
  }
}

function passageCitation(passage) {
  return {
    passage_id: passage.id,
    position: passage.getInt("position"),
    start_seconds: passage.getFloat("start_seconds"),
    end_seconds: passage.getFloat("end_seconds"),
    speaker: passage.getString("speaker"),
    text: passage.getString("text"),
  };
}

function selectedTranscript(app, userId, workspaceId, videoId, passageIds) {
  requireMembership(app, userId, workspaceId);
  if (!videoId) throw new BadRequestError("video is required");
  if (!Array.isArray(passageIds) || passageIds.length < 1 || passageIds.length > 50) {
    throw new BadRequestError("passage_ids must contain between 1 and 50 passages");
  }

  let video;
  try {
    video = app.findRecordById("videos", videoId);
  } catch (_) {
    throw new NotFoundError("Video not found");
  }
  if (video.getString("workspace") !== workspaceId) {
    throw new ForbiddenError("Video is not in this workspace");
  }

  const seen = {};
  const passages = [];
  for (const passageId of passageIds) {
    if (typeof passageId !== "string" || !passageId || seen[passageId]) {
      throw new BadRequestError("passage_ids must contain unique passage IDs");
    }
    seen[passageId] = true;
    let passage;
    try {
      passage = app.findRecordById("transcript_passages", passageId);
    } catch (_) {
      throw new BadRequestError("One or more passages could not be found");
    }
    if (passage.getString("workspace") !== workspaceId || passage.getString("video") !== videoId) {
      throw new ForbiddenError("Every passage must belong to the selected video and workspace");
    }
    passages.push(passage);
  }
  return { video: video, passages: passages };
}

function parseModelAnswer(content, allowedPassageIds) {
  if (typeof content !== "string") {
    throw new BadRequestError("The AI provider returned an unreadable response");
  }
  const raw = content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    throw new BadRequestError("The AI provider returned an invalid grounded response");
  }

  const supported = parsed && parsed.supported === true && Array.isArray(parsed.citation_passage_ids);
  const allowed = {};
  for (const id of allowedPassageIds) allowed[id] = true;
  const citations = [];
  if (supported) {
    for (const id of parsed.citation_passage_ids) {
      if (typeof id === "string" && allowed[id] && citations.indexOf(id) === -1) citations.push(id);
    }
  }

  // A model response without a verifiable selected-passage citation is never
  // presented as a grounded answer.
  if (!supported || citations.length === 0 || typeof parsed.answer !== "string" || !parsed.answer.trim()) {
    return { answer: "Not supported by this transcript.", citations: [] };
  }
  return { answer: parsed.answer.trim().slice(0, 30000), citations: citations };
}

module.exports = {
  requireMembership: requireMembership,
  requiredString: requiredString,
  ensureRelatedWorkspace: ensureRelatedWorkspace,
  passageCitation: passageCitation,
  selectedTranscript: selectedTranscript,
  parseModelAnswer: parseModelAnswer,
};
