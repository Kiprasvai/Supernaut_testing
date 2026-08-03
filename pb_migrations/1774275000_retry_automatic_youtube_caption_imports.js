/// <reference path="../pb_data/types.d.ts" />

// Retry only terminal automatic caption imports that predate the public-response
// parser repair. Manual videos, manual transcripts, and their briefs are never
// selected. This update is idempotent if a boot stops before migration recording.
migrate((app) => {
  try {
    app.findCollectionByNameOrId("videos");
    app.findCollectionByNameOrId("transcript_passages");
  } catch (_) {
    // Earlier additive migrations own these collections. Skipping keeps a
    // partially initialized deployment bootable and lets an unrecorded run retry.
    return;
  }

  app.db().newQuery(`
    UPDATE videos
    SET
      caption_status = 'queued',
      caption_status_detail = 'Queued to retry public-caption import after parser repair.',
      caption_attempts = 0,
      caption_last_attempt_at = '',
      caption_completed_at = '',
      brief_status = CASE
        WHEN brief_status = '' OR brief_status = 'failed' OR brief_status = 'not_applicable' THEN 'pending'
        ELSE brief_status
      END,
      brief_status_detail = CASE
        WHEN brief_status = '' OR brief_status = 'failed' OR brief_status = 'not_applicable'
          THEN 'Waiting for an imported transcript.'
        ELSE brief_status_detail
      END,
      brief_attempts = CASE
        WHEN brief_status = '' OR brief_status = 'failed' OR brief_status = 'not_applicable' THEN 0
        ELSE brief_attempts
      END,
      brief_last_attempt_at = CASE
        WHEN brief_status = '' OR brief_status = 'failed' OR brief_status = 'not_applicable' THEN ''
        ELSE brief_last_attempt_at
      END,
      brief_completed_at = CASE
        WHEN brief_status = '' OR brief_status = 'failed' OR brief_status = 'not_applicable' THEN ''
        ELSE brief_completed_at
      END
    WHERE youtube_video_id != ''
      AND manual_source = 0
      AND caption_status IN ('unavailable', 'failed')
      AND NOT EXISTS (
        SELECT 1 FROM transcript_passages
        WHERE transcript_passages.video = videos.id
      )
  `).execute();
}, (app) => {
  // Forward-only retry: do not restore terminal states or alter persistent data
  // during a rollback.
});
