// Loaded inside isolated route callbacks with require(__hooks + "/practica_novelty.js").
// It deliberately uses only deterministic local text processing: no model,
// external service, or cross-workspace/member data is involved.

function compactText(value, maxLength) {
  if (typeof value !== "string") return "";
  return value.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, maxLength || 4000);
}

function normalizedText(value) {
  let text = compactText(value, 4000).toLowerCase();
  try {
    text = text.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  } catch (_) {}
  return text.replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function fnv1a(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    // Math.imul gives an explicitly stable 32-bit result in the PocketBase JS VM.
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function jsonFromRecordValue(raw) {
  if (typeof raw === "string") {
    try { return JSON.parse(raw); } catch (_) { return null; }
  }
  // PocketBase exposes JSON fields through record.get() as raw byte arrays.
  // Decode that UTF-8 JSON representation without depending on browser globals.
  if (raw && typeof raw.length === "number" && raw.length && typeof raw[0] === "number") {
    let encoded = "";
    for (let index = 0; index < raw.length; index++) {
      const byte = raw[index];
      if (typeof byte !== "number" || byte < 0 || byte > 255) return null;
      encoded += "%" + (byte < 16 ? "0" : "") + byte.toString(16);
    }
    try { return JSON.parse(decodeURIComponent(encoded)); } catch (_) { return null; }
  }
  return raw;
}

function sourcePointTexts(brief) {
  let raw;
  try { raw = brief.get("source_points"); } catch (_) { raw = null; }
  raw = jsonFromRecordValue(raw);
  if (!Array.isArray(raw)) return [];
  const texts = [];
  for (const candidate of raw) {
    const text = compactText(candidate && candidate.text, 4000);
    if (text) texts.push(text);
  }
  return texts;
}

function summaryPointTexts(summary) {
  const raw = typeof summary === "string" ? summary.replace(/\r\n?/g, "\n").trim() : "";
  if (!raw) return [];
  const lines = raw.split("\n");
  const hasBullets = lines.some((line) => /^\s*(?:[-*•‣▪]|\d+[.)])\s+/.test(line));
  const points = [];

  if (hasBullets) {
    let current = "";
    for (const line of lines) {
      const bullet = line.match(/^\s*(?:[-*•‣▪]|\d+[.)])\s+(.+)$/);
      if (bullet) {
        if (current) points.push(current);
        current = bullet[1];
      } else if (line.trim()) {
        current = current ? current + " " + line.trim() : line.trim();
      } else if (current) {
        points.push(current);
        current = "";
      }
    }
    if (current) points.push(current);
  } else if (lines.filter((line) => line.trim()).length > 1) {
    // Preserve meaningful author-entered line structure even without bullets.
    for (const line of lines) if (line.trim()) points.push(line.trim());
  } else {
    // A prose-only manual summary gets sentence-like chunks. The final fallback
    // prevents a punctuation-free summary from becoming unusable.
    const prose = raw.replace(/\s+/g, " ");
    const sentences = prose.match(/[^.!?]+(?:[.!?]+|$)/g) || [prose];
    for (const sentence of sentences) if (sentence.trim()) points.push(sentence.trim());
  }
  return points;
}

function derivePoints(brief) {
  let texts = sourcePointTexts(brief);
  if (!texts.length) texts = summaryPointTexts(brief.getString("summary"));
  const occurrences = {};
  const points = [];
  for (const candidate of texts) {
    const text = compactText(candidate, 4000);
    const normalized = normalizedText(text);
    if (!normalized) continue;
    const baseKey = "point_" + fnv1a(normalized);
    occurrences[baseKey] = (occurrences[baseKey] || 0) + 1;
    points.push({
      key: baseKey + (occurrences[baseKey] === 1 ? "" : "_" + occurrences[baseKey]),
      text: text,
      normalized: normalized,
    });
  }
  return points;
}

const STOP_WORDS = {
  a: true, an: true, and: true, are: true, as: true, at: true, be: true, been: true,
  but: true, by: true, for: true, from: true, has: true, have: true, in: true, into: true,
  is: true, it: true, its: true, of: true, on: true, or: true, that: true, the: true,
  their: true, this: true, to: true, was: true, were: true, will: true, with: true,
};

function meaningfulTokens(normalized) {
  const seen = {};
  const tokens = [];
  for (const token of normalized.split(" ")) {
    if (token.length < 2 || STOP_WORDS[token] || seen[token]) continue;
    seen[token] = true;
    tokens.push(token);
  }
  return tokens;
}

function overlap(left, right) {
  if (left.normalized === right.normalized) {
    return { similarity: 1, containment: 1, shared: 1, exact: true };
  }
  const leftTokens = meaningfulTokens(left.normalized);
  const rightTokens = meaningfulTokens(right.normalized);
  if (!leftTokens.length || !rightTokens.length) {
    return { similarity: 0, containment: 0, shared: 0, exact: false };
  }
  const rightSet = {};
  for (const token of rightTokens) rightSet[token] = true;
  let shared = 0;
  for (const token of leftTokens) if (rightSet[token]) shared++;
  const union = leftTokens.length + rightTokens.length - shared;
  return {
    similarity: union ? shared / union : 0,
    containment: shared / Math.min(leftTokens.length, rightTokens.length),
    shared: shared,
    exact: false,
  };
}

function roundedSimilarity(value) {
  return Math.round(value * 1000) / 1000;
}

function classifyPoint(point, earlierPoints) {
  let best = null;
  for (const earlier of earlierPoints) {
    const score = overlap(point, earlier);
    let status = "new";
    // Exact normalized text, or an almost identical token set, is a close
    // duplicate. Lower-but-material overlap is an update rather than a repeat.
    if (score.exact || (score.shared >= 2 && score.similarity >= 0.78) || (score.shared >= 3 && score.containment >= 0.92)) {
      status = "repeated";
    } else if (score.shared >= 2 && (score.similarity >= 0.35 || score.containment >= 0.55)) {
      status = "update";
    }
    if (status === "new") continue;
    const candidate = {
      status: status,
      similarity: roundedSimilarity(score.similarity),
      matched_text: earlier.text,
      normalized: earlier.normalized,
    };
    if (!best || (candidate.status === "repeated" && best.status !== "repeated") ||
      (candidate.status === best.status && (candidate.similarity > best.similarity ||
        (candidate.similarity === best.similarity && candidate.normalized < best.normalized)))) {
      best = candidate;
    }
  }
  if (!best) return { key: point.key, text: point.text, status: "new" };
  return {
    key: point.key,
    text: point.text,
    status: best.status,
    similarity: best.similarity,
    matched_text: best.matched_text,
  };
}

function allRecordsByFilter(app, collection, filter, sort, params) {
  const records = [];
  const perPage = 500;
  let offset = 0;
  while (true) {
    const page = app.findRecordsByFilter(collection, filter, sort || "", perPage, offset, params || {});
    records.push.apply(records, page);
    if (page.length < perPage) return records;
    offset += page.length;
  }
}

function priorReadPoints(app, userId, workspaceId, briefCreatedAt) {
  const records = allRecordsByFilter(
    app,
    "reader_point_reads",
    "workspace = {:workspace} && user = {:user} && brief_created_at < {:briefCreatedAt}",
    "brief_created_at,point_key",
    { workspace: workspaceId, user: userId, briefCreatedAt: briefCreatedAt },
  );
  const points = [];
  for (const record of records) {
    const text = compactText(record.getString("point_text"), 4000);
    const normalized = normalizedText(text);
    if (normalized) points.push({ text: text, normalized: normalized });
  }
  return points;
}

function annotateBrief(app, userId, workspaceId, brief) {
  const briefCreatedAt = brief.getString("created");
  const earlier = briefCreatedAt ? priorReadPoints(app, userId, workspaceId, briefCreatedAt) : [];
  const annotations = [];
  for (const point of derivePoints(brief)) annotations.push(classifyPoint(point, earlier));
  return { brief_id: brief.id, points: annotations };
}

function findBriefInWorkspace(app, workspaceId, briefId) {
  let brief;
  try {
    brief = app.findRecordById("video_briefs", briefId);
  } catch (_) {
    throw new NotFoundError("Brief not found");
  }
  if (brief.getString("workspace") !== workspaceId) {
    throw new ForbiddenError("Brief is not in this workspace");
  }
  return brief;
}

function validateBriefIds(value) {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) throw new BadRequestError("brief_ids must be an array");
  const seen = {};
  const ids = [];
  for (const id of value) {
    if (typeof id !== "string" || !/^[a-z0-9]{15}$/i.test(id) || seen[id]) {
      throw new BadRequestError("brief_ids must contain unique brief IDs");
    }
    seen[id] = true;
    ids.push(id);
  }
  return ids;
}

function validatePointKeys(value, points) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new BadRequestError("point_keys must be an array");
  const allowed = {};
  for (const point of points) allowed[point.key] = true;
  const seen = {};
  const keys = [];
  for (const key of value) {
    if (typeof key !== "string" || !allowed[key] || seen[key]) {
      throw new BadRequestError("point_keys must contain unique keys from this brief");
    }
    seen[key] = true;
    keys.push(key);
  }
  return keys;
}

function touchBriefRead(app, userId, workspaceId, briefId) {
  let record;
  try {
    record = app.findFirstRecordByFilter(
      "reader_brief_reads",
      "workspace = {:workspace} && user = {:user} && brief = {:brief}",
      { workspace: workspaceId, user: userId, brief: briefId },
    );
  } catch (_) {}
  if (!record) {
    record = new Record(app.findCollectionByNameOrId("reader_brief_reads"));
    record.set("workspace", workspaceId);
    record.set("user", userId);
    record.set("brief", briefId);
  }
  record.set("opened_at", new Date().toISOString());
  app.save(record);
}

function touchPointRead(app, userId, workspaceId, brief, annotation) {
  let record;
  try {
    record = app.findFirstRecordByFilter(
      "reader_point_reads",
      "workspace = {:workspace} && user = {:user} && brief = {:brief} && point_key = {:key}",
      { workspace: workspaceId, user: userId, brief: brief.id, key: annotation.key },
    );
  } catch (_) {}
  if (!record) {
    record = new Record(app.findCollectionByNameOrId("reader_point_reads"));
    record.set("workspace", workspaceId);
    record.set("user", userId);
    record.set("brief", brief.id);
    record.set("point_key", annotation.key);
  }
  record.set("point_text", annotation.text);
  record.set("novelty_status", annotation.status);
  if (annotation.similarity === undefined) record.set("similarity", null);
  else record.set("similarity", annotation.similarity);
  record.set("matched_text", annotation.matched_text || "");
  record.set("brief_created_at", brief.getString("created"));
  record.set("revealed_at", new Date().toISOString());
  app.save(record);
}

module.exports = {
  allRecordsByFilter: allRecordsByFilter,
  annotateBrief: annotateBrief,
  derivePoints: derivePoints,
  findBriefInWorkspace: findBriefInWorkspace,
  validateBriefIds: validateBriefIds,
  validatePointKeys: validatePointKeys,
  touchBriefRead: touchBriefRead,
  touchPointRead: touchPointRead,
};
