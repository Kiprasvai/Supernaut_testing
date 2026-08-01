import './styles.css';
import { pb } from './pocketbase';
import type { RecordModel } from 'pocketbase';

type Row = RecordModel & Record<string, any>;
type Citation = { passage_id: string; position: number; start_seconds: number; end_seconds: number; speaker: string; text: string };
type Answer = { answer: string; supported: boolean; citations: Citation[]; model?: string };
type PublicShare = { scope: 'video' | 'brief' | 'transcript'; video: { id: string; title: string; source_url: string; duration_seconds: number }; brief?: { id: string; title: string; summary: string } | null; transcript?: Citation[] };
type LocalShare = { id: string; token: string; scope: string; expires_at: string; videoId: string; videoTitle: string; revoked?: boolean };

const root = document.querySelector<HTMLElement>('#app')!;
const state = {
  authMode: 'signin' as 'signin' | 'signup',
  authError: '',
  notice: '',
  busy: false,
  booted: false,
  workspace: null as Row | null,
  workspaces: [] as Row[],
  channels: [] as Row[],
  videos: [] as Row[],
  briefs: [] as Row[],
  passages: [] as Row[],
  folders: [] as Row[],
  saves: [] as Row[],
  highlights: [] as Row[],
  selectedVideo: null as Row | null,
  selectedPassages: new Set<string>(),
  answer: null as Answer | null,
  answerError: '',
  publicShare: null as PublicShare | null,
  publicError: '',
  channelFilter: '',
  libraryFilter: '',
};

const icons: Record<string, string> = {
  home: '<path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 10v10h13V10M9 20v-6h6v6"/>',
  library: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  play: '<path d="m8 5 11 7-11 7Z"/>',
  bookmark: '<path d="M6 3h12v18l-6-4-6 4Z"/>',
  highlight: '<path d="m9 11-6 6v4h4l6-6M15 5l4 4M13 7l4 4M14 6l2-2 4 4-2 2"/>',
  share: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 10.5 6.8-4M8.6 13.5l6.8 4"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  external: '<path d="M15 3h6v6M10 14 21 3M18 13v7a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h7"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
  chevron: '<path d="m9 18 6-6-6-6"/>',
  folder: '<path d="M3 6h7l2 2h9v11H3Z"/>',
  warning: '<path d="M12 3 2.5 20h19Z"/><path d="M12 9v4M12 17h.01"/>',
  logout: '<path d="M10 17l5-5-5-5M15 12H3M14 4h5a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-5"/>',
};

function icon(name: string, label = '') {
  return `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" ${label ? `role="img" aria-label="${esc(label)}"` : 'aria-hidden="true"'}>${icons[name]}</svg>`;
}
function esc(value: unknown): string {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]!);
}
function fmtTime(seconds = 0) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}
function fmtDate(value: string) {
  if (!value) return 'No expiry';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Date unavailable';
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).format(date);
}

type StatusTone = 'ready' | 'working' | 'warning' | 'critical' | 'neutral';
type VideoStatus = { label: string; detail?: string; tone: StatusTone };

function firstVideoField(video: Row, names: string[]) {
  for (const name of names) {
    const value = video[name];
    if (value !== undefined && value !== null && String(value).trim() !== '') return value;
  }
  return '';
}
function statusToken(value: unknown) {
  return String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
}
function isAutomaticVideo(video: Row) {
  const sourceKind = statusToken(firstVideoField(video, ['source_type', 'source_kind', 'ingestion_source']));
  return Boolean(video.youtube_video_id || video.automatic_source || sourceKind === 'youtube' || sourceKind === 'automatic' || firstVideoField(video, ['caption_status', 'transcript_ingestion_status', 'brief_ingestion_status']));
}
function ingestionError(video: Row, kind: 'transcript' | 'brief') {
  const names = kind === 'transcript'
    ? ['caption_status_detail', 'transcript_status_detail', 'transcript_error_message', 'transcript_ingestion_error', 'transcript_error']
    : ['brief_status_detail', 'brief_error_message', 'brief_ingestion_error', 'brief_error'];
  return String(firstVideoField(video, names.concat(['ingestion_error_message', 'ingestion_error', 'error_message', 'processing_error'])) || '').trim().replace(/public-caption/gi, 'caption').replace(/^Automatic brief failed:\s*/i, '');
}
function statusDate(video: Row, names: string[], verb: string) {
  const value = String(firstVideoField(video, names) || '');
  return value ? `${verb} ${fmtDate(value)}` : '';
}
function joinStatusDetail(...parts: string[]) {
  return parts.filter(Boolean).join(' · ');
}
function transcriptStatus(video: Row, hasPassages = false): VideoStatus {
  const automatic = isAutomaticVideo(video);
  const language = transcriptLanguage(video);
  if (hasPassages || video.manual_source) {
    const completed = automatic && !video.manual_source ? statusDate(video, ['caption_completed_at', 'transcript_completed_at'], 'Imported') : '';
    return { label: video.manual_source ? 'Manual transcript ready' : automatic ? 'Captions imported' : 'Transcript ready', detail: joinStatusDetail(language, completed), tone: 'ready' };
  }
  if (!automatic) return { label: 'Manual transcript not added', detail: 'Add transcript text when it is available.', tone: 'neutral' };
  const status = statusToken(firstVideoField(video, ['transcript_ingestion_status', 'transcript_status', 'caption_status', 'captions_status', 'ingestion_status']));
  const detail = ingestionError(video, 'transcript');
  if (['ready', 'complete', 'completed', 'succeeded', 'success', 'available', 'imported'].includes(status)) return { label: 'Captions imported', detail: joinStatusDetail(language, statusDate(video, ['caption_completed_at', 'transcript_completed_at'], 'Imported')), tone: 'ready' };
  if (['unavailable', 'captions_unavailable', 'no_captions', 'not_available', 'not_found', 'missing'].includes(status)) return { label: 'Captions unavailable', detail: detail ? `${detail} Add a manual transcript to continue.` : 'Add a manual transcript to continue.', tone: 'warning' };
  if (['failed', 'error'].includes(status)) return { label: 'Caption import failed', detail: detail || 'Add a manual transcript or try again later.', tone: 'critical' };
  if (['processing', 'importing', 'in_progress', 'fetching', 'retrieving', 'transcribing'].includes(status)) return { label: 'Retrieving captions', detail: detail || statusDate(video, ['caption_last_attempt_at', 'transcript_last_attempt_at'], 'Started') || 'This usually finishes shortly.', tone: 'working' };
  return { label: 'Caption import queued', detail: detail || 'Practica will check for available captions.', tone: 'working' };
}
function briefStatus(video: Row, brief?: Row): VideoStatus {
  if (brief) return { label: 'Brief ready', detail: statusDate(video, ['brief_completed_at'], 'Prepared'), tone: 'ready' };
  if (!isAutomaticVideo(video)) return { label: 'Team brief not added', tone: 'neutral' };
  const status = statusToken(firstVideoField(video, ['brief_ingestion_status', 'brief_status', 'summary_status']));
  const detail = ingestionError(video, 'brief');
  if (['failed', 'error'].includes(status)) return { label: 'Brief could not be created', detail: detail || 'The transcript remains available to read and use.', tone: 'critical' };
  if (['not_applicable', 'unavailable'].includes(status)) return { label: 'Brief unavailable', detail: detail || 'Add a manual transcript before creating a brief.', tone: 'warning' };
  if (['processing', 'importing', 'in_progress', 'generating', 'creating'].includes(status)) return { label: 'Preparing brief', detail: detail || statusDate(video, ['brief_last_attempt_at'], 'Started') || 'The transcript remains available while this finishes.', tone: 'working' };
  if (['ready', 'complete', 'completed', 'succeeded', 'success', 'available'].includes(status)) return { label: 'Brief ready', detail: statusDate(video, ['brief_completed_at'], 'Prepared'), tone: 'ready' };
  return { label: 'Brief pending', detail: detail || 'It starts after a transcript is available.', tone: 'working' };
}
function transcriptLanguage(video: Row) {
  const raw = String(firstVideoField(video, ['transcript_language', 'caption_language', 'captions_language', 'language', 'language_code']) || '').trim();
  if (!raw) return '';
  const code = raw.toLowerCase().split(/[-_]/)[0];
  try {
    const name = new Intl.DisplayNames([navigator.language], { type: 'language' }).of(code);
    return name ? `${name} captions` : `${raw} captions`;
  } catch { return `${raw.toUpperCase()} captions`; }
}
function videoTiming(video: Row) {
  if (isAutomaticVideo(video)) {
    const published = String(firstVideoField(video, ['youtube_published_at', 'published_at', 'source_published_at']) || '');
    return published ? `Published ${fmtDate(published)}` : video.created ? `Discovered ${fmtDate(video.created)}` : 'Discovered automatically';
  }
  return video.created ? `Added ${fmtDate(video.created)}` : 'Added manually';
}
function statusRow(kind: string, status: VideoStatus) {
  return `<div class="status-row ${status.tone}"><span class="status-dot" aria-hidden="true"></span><span><strong>${esc(kind)}</strong>${esc(status.label)}${status.detail ? `<small>${esc(status.detail)}</small>` : ''}</span></div>`;
}
function feedSummary(video: Row, brief: Row | undefined, transcript: VideoStatus, briefState: VideoStatus) {
  if (brief) return `<p>${esc(brief.summary)}</p><button class="source-claim" data-action="open-video-id" data-id="${video.id}">${icon('chevron')} Read cited source transcript</button>`;
  if (briefState.tone === 'critical') return `<div class="feed-message critical-message"><strong>Brief could not be created.</strong><span>${esc(briefState.detail || 'The transcript remains available to read and use.')}</span></div>${transcript.tone === 'ready' ? `<button class="source-claim" data-action="open-video-id" data-id="${video.id}">${icon('chevron')} Read the transcript</button>` : ''}`;
  if (transcript.tone === 'warning' || transcript.tone === 'critical') return `<div class="feed-message warning-message"><strong>${esc(transcript.label)}.</strong><span>${esc(transcript.detail || 'Add a manual transcript to continue.')}</span></div><button class="source-claim" data-action="open-video-id" data-id="${video.id}">${icon('chevron')} Open to add transcript manually</button>`;
  if (briefState.tone === 'warning') return `<div class="feed-message warning-message"><strong>${esc(briefState.label)}.</strong><span>${esc(briefState.detail || 'The transcript remains available to read and use.')}</span></div>${transcript.tone === 'ready' ? `<button class="source-claim" data-action="open-video-id" data-id="${video.id}">${icon('chevron')} Read the transcript</button>` : ''}`;
  if (transcript.tone === 'ready' && briefState.tone === 'working') return `<p class="muted-copy">The transcript is ready. Practica is preparing the source-backed brief.</p><button class="source-claim" data-action="open-video-id" data-id="${video.id}">${icon('chevron')} Read the transcript now</button>`;
  if (isAutomaticVideo(video)) return `<p class="muted-copy">Practica found this video and is checking for captions before preparing its brief.</p>`;
  if (transcript.tone === 'ready') return `<p class="muted-copy">The manual transcript is ready. Add a team brief when there is a takeaway to share.</p><button class="source-claim" data-action="open-video-id" data-id="${video.id}">${icon('chevron')} Read the transcript</button>`;
  return `<p class="muted-copy">No brief or transcript yet. Add source text when it is available.</p>`;
}
function transcriptEmptyState(video: Row, status: VideoStatus) {
  const automatic = isAutomaticVideo(video);
  const heading = status.tone === 'warning' ? 'Captions are not available for this video' : status.tone === 'critical' ? 'Captions could not be imported' : status.tone === 'ready' ? 'Transcript text is not available yet' : status.tone === 'working' && automatic ? status.label : 'Add a transcript to use this source';
  const copy = status.tone === 'ready' ? 'This video is marked as having a transcript, but no passages are available. Add transcript text manually to continue.' : status.detail || (automatic ? 'Practica is checking for available captions. You can add transcript text manually at any time.' : 'Paste transcript text to make passages selectable, citable, and available to grounded Q&A.');
  return `<div class="empty-state compact"><div class="empty-symbol">${icon(status.tone === 'critical' || status.tone === 'warning' ? 'warning' : 'library')}</div><h2>${esc(heading)}</h2><p>${esc(copy)}</p><button class="primary" data-action="open-transcript">Add transcript manually</button></div>`;
}
function pbMessage(error: any, fallback: string) {
  return error?.response?.message || error?.response?.data?.message || error?.message || fallback;
}
function filterWorkspace() {
  return pb.filter('workspace = {:workspace}', { workspace: state.workspace!.id });
}
function sourceUrl(video: Row | PublicShare['video'], seconds = 0) {
  if (!video.source_url) return '';
  try {
    const url = new URL(video.source_url);
    if (seconds) url.searchParams.set(url.hostname.includes('youtu') ? 't' : 'start', String(Math.floor(seconds)));
    return url.toString();
  } catch { return video.source_url; }
}
function currentPath() { return location.pathname; }
function navigate(path: string) {
  history.pushState({}, '', path);
  route();
}
function announce(message: string) {
  state.notice = message;
  render();
  window.setTimeout(() => { if (state.notice === message) { state.notice = ''; render(); } }, 3500);
}
function setBusy(value: boolean) { state.busy = value; render(); }

async function boot() {
  if (currentPath().startsWith('/share/')) return loadPublicShare(currentPath().split('/')[2] || '');
  if (!pb.authStore.isValid) { state.booted = true; return render(); }
  try { await loadAccount(); } catch (error) { state.authError = pbMessage(error, 'We could not open your workspace.'); }
  state.booted = true;
  render();
}

async function loadAccount() {
  const savedId = localStorage.getItem('practica.workspace');
  // Re-validate a remembered workspace against PocketBase on every sign-in;
  // getOne still applies the server's workspace access rule.
  if (savedId) {
    try {
      const remembered = await pb.collection('workspaces').getOne<Row>(savedId);
      state.workspaces = [remembered];
      state.workspace = remembered;
      await loadWorkspace();
      return;
    } catch { localStorage.removeItem('practica.workspace'); }
  }
  try {
    // Memberships are the account-aware workspace index. Querying them avoids
    // asking PocketBase for any workspace the signed-in user cannot see.
    const memberships = await pb.collection('members').getFullList<Row>({
      filter: pb.filter('user = {:user}', { user: pb.authStore.record!.id }),
      expand: 'workspace',
    });
    state.workspaces = memberships.map((membership) => membership.expand?.workspace).filter(Boolean) as Row[];
    state.workspace = state.workspaces[0] || null;
    if (state.workspace) await loadWorkspace();
  } catch {
    // A first-run account has no membership yet. Onboarding creates the owner
    // membership immediately after its workspace so subsequent sign-ins resolve.
    state.workspaces = [];
    state.workspace = null;
  }
}
async function loadWorkspace() {
  if (!state.workspace) return;
  localStorage.setItem('practica.workspace', state.workspace.id);
  const filter = filterWorkspace();
  const [channels, videos, briefs, folders, saves, highlights] = await Promise.all([
    pb.collection('channels').getFullList<Row>({ filter, sort: 'name' }),
    pb.collection('videos').getFullList<Row>({ filter, sort: '-youtube_published_at,-created' }),
    pb.collection('video_briefs').getFullList<Row>({ filter, sort: 'title' }),
    pb.collection('research_folders').getFullList<Row>({ filter, sort: 'name' }),
    pb.collection('saved_passage_items').getFullList<Row>({ filter, expand: 'passage,passage.video,folder' }),
    pb.collection('highlights').getFullList<Row>({ filter, expand: 'passage,passage.video' }),
  ]);
  Object.assign(state, { channels, videos, briefs, folders, saves, highlights });
  if (state.selectedVideo) {
    state.selectedVideo = state.videos.find((video) => video.id === state.selectedVideo!.id) || null;
    if (state.selectedVideo) await loadPassages(state.selectedVideo.id);
  }
}
async function loadPassages(videoId: string) {
  state.passages = await pb.collection('transcript_passages').getFullList<Row>({
    filter: pb.filter('workspace = {:workspace} && video = {:video}', { workspace: state.workspace!.id, video: videoId }),
    sort: 'position',
  });
}
async function openVideo(videoId: string) {
  const video = state.videos.find((item) => item.id === videoId);
  if (!video) return;
  state.selectedVideo = video;
  state.selectedPassages.clear();
  state.answer = null;
  state.answerError = '';
  setBusy(true);
  try { await loadPassages(videoId); navigate(`/video/${videoId}`); }
  catch (error) { announce(pbMessage(error, 'The transcript could not be loaded.')); }
  finally { state.busy = false; render(); }
}

function shell(content: string, section = '') {
  const initials = (pb.authStore.record?.email || 'P').slice(0, 2).toUpperCase();
  return `<div class="app-shell">
    <aside class="sidebar">
      <button class="brand brand-button" data-action="navigate" data-path="/" aria-label="Practica home"><span class="brand-mark">P</span><span>Practica</span></button>
      <div class="workspace-label"><span>Workspace</span><strong>${esc(state.workspace?.name)}</strong></div>
      <nav aria-label="Workspace navigation">
        <button class="nav-item ${section === 'briefing' ? 'active' : ''}" data-action="navigate" data-path="/">${icon('home')}<span>Briefing</span></button>
        <button class="nav-item ${section === 'library' ? 'active' : ''}" data-action="navigate" data-path="/library">${icon('library')}<span>Research library</span></button>
      </nav>
      <div class="sidebar-bottom">
        <button class="nav-item" data-action="open-channel">${icon('plus')}<span>Add channel</span></button>
        <button class="account-button" data-action="account-menu" aria-expanded="false"><span class="avatar">${esc(initials)}</span><span class="account-copy"><strong>${esc(pb.authStore.record?.email)}</strong><small>Account</small></span>${icon('more')}</button>
        <div class="account-menu" hidden>
          <button data-action="signout">${icon('logout')} Sign out</button>
        </div>
      </div>
    </aside>
    <main class="main-view">${content}</main>
    <nav class="mobile-nav" aria-label="Mobile navigation">
      <button class="${section === 'briefing' ? 'active' : ''}" data-action="navigate" data-path="/">${icon('home')}<span>Briefing</span></button>
      <button class="mobile-add" data-action="open-video" aria-label="Add a video manually">${icon('plus')}</button>
      <button class="${section === 'library' ? 'active' : ''}" data-action="navigate" data-path="/library">${icon('library')}<span>Library</span></button>
    </nav>
    ${dialogs()}
    ${state.notice ? `<div class="toast" role="status">${icon('check')} ${esc(state.notice)}</div>` : ''}
  </div>`;
}

function authView() {
  const signup = state.authMode === 'signup';
  return `<main class="auth-page">
    <section class="auth-story" aria-labelledby="auth-title">
      <a class="brand" href="/" data-action="navigate"><span class="brand-mark">P</span><span>Practica</span></a>
      <div class="story-copy">
        <p class="kicker">Shared intelligence, grounded in the source</p>
        <h1 id="auth-title">Turn the videos your team follows into research you can use.</h1>
        <p>Read transcripts together, cite the exact moment, and keep practical findings within reach.</p>
      </div>
      <div class="source-sample" aria-hidden="true">
        <span class="sample-time">18:42</span>
        <p>“The useful question is not whether the model can answer, but whether the team can trace the answer back.”</p>
        <span class="sample-citation">Source passage · selected</span>
      </div>
    </section>
    <section class="auth-panel">
      <div class="auth-card">
        <p class="mobile-brand">Practica</p>
        <h2>${signup ? 'Start your workspace' : 'Welcome back'}</h2>
        <p>${signup ? 'Create an account for your applied-AI research team.' : 'Sign in to continue your team’s briefing.'}</p>
        ${state.authError ? `<div class="error-banner" role="alert">${icon('warning')}<span>${esc(state.authError)}</span></div>` : ''}
        <form id="auth-form" novalidate>
          <label>Email address<input name="email" type="email" autocomplete="email" required placeholder="you@company.com"></label>
          <label>Password<input name="password" type="password" autocomplete="${signup ? 'new-password' : 'current-password'}" minlength="8" required placeholder="At least 8 characters"></label>
          ${signup ? '<label>Confirm password<input name="passwordConfirm" type="password" autocomplete="new-password" minlength="8" required placeholder="Repeat your password"></label>' : ''}
          <button class="primary full" type="submit" ${state.busy ? 'disabled' : ''}>${state.busy ? '<span class="spinner"></span> Please wait' : signup ? 'Create account' : 'Sign in'} ${!state.busy ? icon('arrow') : ''}</button>
        </form>
        <p class="auth-switch">${signup ? 'Already have an account?' : 'New to Practica?'} <button data-action="toggle-auth">${signup ? 'Sign in' : 'Create an account'}</button></p>
      </div>
    </section>
  </main>`;
}

function onboardingView() {
  return `<main class="onboarding-page">
    <div class="onboarding-top brand"><span class="brand-mark">P</span><span>Practica</span></div>
    <section class="onboarding-wrap">
      <div class="step-indicator"><span>1</span><i></i><span class="muted-step">2</span></div>
      <p class="kicker">Set up your research desk</p>
      <h1>What does your team call itself?</h1>
      <p>This workspace will hold your shared channels, source videos, briefs, and research. You can start with just yourself.</p>
      ${state.authError ? `<div class="error-banner" role="alert">${icon('warning')}<span>${esc(state.authError)}</span></div>` : ''}
      <form id="workspace-form">
        <label>Workspace name<input name="name" required maxlength="160" placeholder="e.g. Applied AI Lab" autofocus></label>
        <button class="primary" type="submit" ${state.busy ? 'disabled' : ''}>${state.busy ? '<span class="spinner"></span> Creating workspace' : `Create workspace ${icon('arrow')}`}</button>
      </form>
      <button class="text-button" data-action="signout">Use a different account</button>
    </section>
  </main>`;
}

function feedView() {
  const channelPills = state.channels.map((channel) => `<button class="filter-chip ${state.channelFilter === channel.id ? 'selected' : ''}" data-action="filter-channel" data-id="${channel.id}" aria-pressed="${state.channelFilter === channel.id}">${esc(channel.name)}</button>`).join('');
  const visibleVideos = state.channelFilter ? state.videos.filter((video) => video.channel === state.channelFilter) : state.videos;
  const selectedChannel = state.channels.find((channel) => channel.id === state.channelFilter);
  const items = visibleVideos.map((video) => {
    const channel = state.channels.find((item) => item.id === video.channel);
    const brief = state.briefs.find((item) => item.video === video.id);
    const transcript = transcriptStatus(video);
    const briefState = briefStatus(video, brief);
    return `<article class="feed-item">
      <button class="video-thumb" data-action="open-video-id" data-id="${video.id}" aria-label="Open ${esc(video.title)} transcript"><span>${icon('play')}</span><small>${video.duration_seconds ? fmtTime(video.duration_seconds) : isAutomaticVideo(video) ? 'YouTube' : 'Text source'}</small></button>
      <div class="feed-copy">
        <div class="feed-meta"><span>${esc(channel?.name || 'Unsorted')}</span><span>·</span><time>${esc(videoTiming(video))}</time></div>
        <button class="title-link" data-action="open-video-id" data-id="${video.id}"><h2>${esc(video.title)}</h2></button>
        ${feedSummary(video, brief, transcript, briefState)}
      </div>
      <div class="feed-status" aria-label="Video processing status">${statusRow('Transcript', transcript)}${statusRow('Brief', briefState)}</div>
    </article>`;
  }).join('');
  const monitoredEmpty = Boolean(selectedChannel?.youtube_url);
  return shell(`<header class="page-header">
      <div><p class="kicker">Team briefing</p><h1>What your team is learning</h1><p>New videos, transcripts, and source-backed briefs from the channels you follow.</p></div>
      <button class="primary" data-action="open-video">${icon('plus')} Add video manually</button>
    </header>
    <section class="feed-toolbar" aria-label="Feed filters"><button class="filter-chip ${state.channelFilter ? '' : 'selected'}" data-action="filter-channel" data-id="" aria-pressed="${!state.channelFilter}">All sources</button>${channelPills}<button class="filter-chip add-chip" data-action="open-channel">${icon('plus')} Monitor channel</button></section>
    <section class="feed-list" aria-label="Workspace briefing">
      ${items || (state.channelFilter ? `<div class="empty-state compact"><div class="empty-symbol">${icon('play')}</div><h2>No videos in this channel yet</h2><p>${monitoredEmpty ? 'Practica is monitoring this public channel. New videos will appear here after they are published and discovered.' : 'This is a manual channel. Add a video and transcript when you are ready.'}</p><div><button class="primary" data-action="open-video">Add a video manually</button><button class="secondary" data-action="filter-channel" data-id="">View all sources</button></div></div>` : `<div class="empty-state"><div class="empty-symbol">${icon('play')}</div><h2>Follow a channel once. Keep up automatically.</h2><p>Add a public YouTube channel URL or @handle. Practica will monitor it for new videos, retrieve available captions, and prepare transcript-backed briefs. Manual video and transcript entry stays available whenever you need it.</p><div><button class="primary" data-action="open-channel">Monitor a YouTube channel</button><button class="secondary" data-action="open-video">Add a video manually</button></div></div>`)}
    </section>`, 'briefing');
}

function transcriptView(video: Row) {
  const brief = state.briefs.find((item) => item.video === video.id);
  const selectedCount = state.selectedPassages.size;
  const transcript = transcriptStatus(video, state.passages.length > 0);
  const briefState = briefStatus(video, brief);
  const language = transcriptLanguage(video);
  const passages = state.passages.map((passage) => {
    const selected = state.selectedPassages.has(passage.id);
    const highlighted = state.highlights.some((item) => item.passage === passage.id);
    const saved = state.saves.some((item) => item.passage === passage.id);
    const url = sourceUrl(video, passage.start_seconds);
    return `<article id="passage-${passage.id}" class="passage ${selected ? 'selected' : ''} ${highlighted ? 'highlighted' : ''}" data-passage="${passage.id}">
      <button class="passage-select" data-action="toggle-passage" data-id="${passage.id}" aria-pressed="${selected}" aria-label="${selected ? 'Deselect' : 'Select'} passage at ${fmtTime(passage.start_seconds)}"><span>${selected ? icon('check') : ''}</span></button>
      <div class="passage-time">${url ? `<a href="${esc(url)}" target="_blank" rel="noreferrer" title="Open source at ${fmtTime(passage.start_seconds)}">${fmtTime(passage.start_seconds)}</a>` : `<span>${fmtTime(passage.start_seconds)}</span>`}</div>
      <div class="passage-copy">${passage.speaker ? `<strong>${esc(passage.speaker)}</strong>` : ''}<p>${esc(passage.text)}</p><div class="passage-badges">${highlighted ? '<span>Highlighted</span>' : ''}${saved ? '<span>Saved</span>' : ''}</div></div>
    </article>`;
  }).join('');
  const answer = state.answer ? `<div class="answer-block ${state.answer.supported ? '' : 'unsupported'}">
    <p class="answer-label">${state.answer.supported ? 'Grounded answer' : 'Source check'}</p>
    <p>${esc(state.answer.answer)}</p>
    ${state.answer.citations.length ? `<div class="citations"><strong>Sources</strong>${state.answer.citations.map((citation, index) => `<button data-action="jump-citation" data-id="${citation.passage_id}"><span>[${index + 1}]</span><span>${fmtTime(citation.start_seconds)} · ${esc(citation.text.slice(0, 90))}${citation.text.length > 90 ? '…' : ''}</span></button>`).join('')}</div>` : '<p class="support-note">This transcript does not contain enough support for that answer. Try selecting a different passage or asking a narrower question.</p>'}
  </div>` : '';
  return shell(`<div class="reader-topbar">
      <button class="back-button" data-action="navigate" data-path="/">${icon('chevron')} Briefing</button>
      <div class="reader-actions"><button class="secondary" data-action="open-share">${icon('share')} Share</button>${video.source_url ? `<a class="secondary" href="${esc(video.source_url)}" target="_blank" rel="noreferrer">View source ${icon('external')}</a>` : ''}</div>
    </div>
    <div class="reader-layout">
      <section class="transcript-panel">
        <header class="transcript-header"><div class="feed-meta"><span>${esc(state.channels.find((item) => item.id === video.channel)?.name || 'Workspace source')}</span><span>·</span><span>${esc(videoTiming(video))}</span></div><h1>${esc(video.title)}</h1><div class="source-status-panel" aria-label="Video processing status">${statusRow('Transcript', transcript)}${statusRow('Brief', briefState)}</div>${brief ? `<div class="brief-inline"><strong>${esc(brief.title || 'Source brief')}</strong><p>${esc(brief.summary)}</p></div>` : ''}<div class="transcript-meta"><span>${icon('clock')} ${video.duration_seconds ? fmtTime(video.duration_seconds) : 'Length not set'}</span><span>${state.passages.length} ${state.passages.length === 1 ? 'passage' : 'passages'}</span>${language ? `<span>${esc(language)}</span>` : ''}</div></header>
        <div class="selection-bar ${selectedCount ? 'visible' : ''}" aria-live="polite"><strong>${selectedCount} selected</strong><button data-action="open-highlight">${icon('highlight')} Highlight</button><button data-action="open-save">${icon('bookmark')} Save</button><button data-action="clear-selection">Clear</button></div>
        <div class="transcript-list">${passages || transcriptEmptyState(video, transcript)}</div>
      </section>
      <aside class="qa-panel"><div class="qa-heading"><div><p class="kicker">Ask this source</p><h2>Grounded Q&A</h2></div><span class="grounded-badge">Transcript only</span></div><p class="qa-intro">Answers use up to 50 ${selectedCount ? 'selected' : 'available'} passages and must cite this transcript.</p>${answer}${state.answerError ? `<div class="error-banner" role="alert">${icon('warning')}<span>${esc(state.answerError)} You can still read and cite the transcript.</span></div>` : ''}<form id="qa-form"><label for="question">Your question</label><textarea id="question" name="question" required maxlength="4000" placeholder="What evidence does the speaker give for…?"></textarea><button class="primary full" type="submit" ${state.busy || !state.passages.length ? 'disabled' : ''}>${state.busy ? '<span class="spinner"></span> Checking the source' : `Ask Practica ${icon('arrow')}`}</button></form><p class="privacy-note">Practica sends only the selected transcript passages to the grounded-answer service.</p></aside>
    </div>`, 'briefing');
}

function libraryView() {
  const folderCounts = state.folders.map((folder) => ({ folder, count: state.saves.filter((save) => save.folder === folder.id).length }));
  const visibleSaves = state.libraryFilter ? state.saves.filter((save) => save.folder === state.libraryFilter) : state.saves;
  const saves = visibleSaves.map((save) => {
    const passage = save.expand?.passage;
    const video = passage?.expand?.video;
    const folder = save.expand?.folder;
    return `<article class="library-item"><div class="library-kind">${icon('bookmark')} Saved passage</div><blockquote>${esc(passage?.text || 'This passage is no longer available.')}</blockquote><div class="library-meta"><span>${esc(video?.title || 'Source video')} · ${fmtTime(passage?.start_seconds)}</span>${folder ? `<span class="folder-tag">${icon('folder')} ${esc(folder.name)}</span>` : '<span class="folder-tag">Unfiled</span>'}</div>${save.note ? `<p class="research-note"><strong>Your note</strong>${esc(save.note)}</p>` : ''}${video ? `<button class="text-link" data-action="open-video-id" data-id="${video.id}">Open in transcript ${icon('arrow')}</button>` : ''}</article>`;
  }).join('');
  const highlights = (state.libraryFilter ? [] : state.highlights).map((highlight) => {
    const passage = highlight.expand?.passage;
    const video = passage?.expand?.video;
    return `<article class="library-item highlight-item"><div class="library-kind">${icon('highlight')} Highlight</div><blockquote>${esc(passage?.text || 'General video highlight')}</blockquote><div class="library-meta"><span>${esc(video?.title || 'Source video')} · ${fmtTime(passage?.start_seconds)}</span></div>${highlight.note ? `<p class="research-note"><strong>Your note</strong>${esc(highlight.note)}</p>` : ''}${video ? `<button class="text-link" data-action="open-video-id" data-id="${video.id}">Open in transcript ${icon('arrow')}</button>` : ''}</article>`;
  }).join('');
  return shell(`<header class="page-header library-header"><div><p class="kicker">Research library</p><h1>Your source-backed findings</h1><p>Highlights and saved passages stay private to your account.</p></div><button class="secondary" data-action="open-folder">${icon('plus')} New folder</button></header>
    <div class="library-layout"><aside class="folder-list"><strong>Folders</strong><button class="${state.libraryFilter ? '' : 'selected'}" data-action="filter-folder" data-id="">All research <span>${state.saves.length + state.highlights.length}</span></button>${folderCounts.map(({ folder, count }) => `<button class="${state.libraryFilter === folder.id ? 'selected' : ''}" data-action="filter-folder" data-id="${folder.id}">${icon('folder')} ${esc(folder.name)} <span>${count}</span></button>`).join('') || '<p>No folders yet.</p>'}</aside><section class="research-list">${saves}${highlights}${!saves && !highlights ? `<div class="empty-state compact"><div class="empty-symbol">${icon('bookmark')}</div><h2>Your research will collect here</h2><p>Select passages in any transcript to highlight them, add a note, or save them into a named folder.</p><button class="primary" data-action="navigate" data-path="/">Browse the briefing</button></div>` : ''}</section></div>`, 'library');
}

function publicView() {
  if (state.publicError) return `<main class="public-page"><header class="public-header"><a class="brand" href="/"><span class="brand-mark">P</span><span>Practica</span></a></header><section class="public-error"><div>${icon('warning')}</div><h1>This shared source is unavailable</h1><p>${esc(state.publicError)}</p><a class="primary" href="/">Create your own workspace</a></section></main>`;
  if (!state.publicShare) return `<main class="public-page"><header class="public-header"><span class="brand"><span class="brand-mark">P</span><span>Practica</span></span></header><div class="loading-page"><span class="spinner dark"></span><p>Opening shared research…</p></div></main>`;
  const share = state.publicShare;
  return `<main class="public-page"><header class="public-header"><a class="brand" href="/"><span class="brand-mark">P</span><span>Practica</span></a><span class="read-only">Read-only shared source</span></header>
    <article class="public-content"><div class="public-meta"><span>${share.scope === 'video' ? 'Video source' : share.scope === 'brief' ? 'Shared brief' : 'Shared transcript'}</span><span>Shared with Practica</span></div><h1>${esc(share.video.title)}</h1><div class="transcript-meta"><span>${icon('clock')} ${share.video.duration_seconds ? fmtTime(share.video.duration_seconds) : 'Length not set'}</span>${share.video.source_url ? `<a href="${esc(share.video.source_url)}" target="_blank" rel="noreferrer">View original ${icon('external')}</a>` : ''}</div>
    ${share.scope === 'video' ? '<div class="public-scope-note"><h2>About this share</h2><p>The sender shared this source’s title and original link only. Workspace notes, Q&A, members, and other research are not included.</p></div>' : ''}
    ${share.scope === 'brief' ? (share.brief ? `<section class="public-brief"><h2>${esc(share.brief.title || 'Source brief')}</h2><p>${esc(share.brief.summary)}</p></section>` : '<div class="public-scope-note"><h2>No brief is available</h2><p>The source remains shared, but its brief has not been written yet.</p></div>') : ''}
    ${share.scope === 'transcript' ? `<section class="public-transcript"><h2>Transcript</h2>${share.transcript?.map((passage) => `<article class="passage"><div class="passage-time">${share.video.source_url ? `<a href="${esc(sourceUrl(share.video, passage.start_seconds))}" target="_blank" rel="noreferrer">${fmtTime(passage.start_seconds)}</a>` : fmtTime(passage.start_seconds)}</div><div class="passage-copy">${passage.speaker ? `<strong>${esc(passage.speaker)}</strong>` : ''}<p>${esc(passage.text)}</p></div></article>`).join('') || '<p>No transcript passages are available.</p>'}</section>` : ''}</article>
    <aside class="public-cta"><div><span class="brand-mark">P</span><div><strong>Keep your team’s research grounded.</strong><p>Build a shared, source-first intelligence workspace with Practica.</p></div></div><a class="primary" href="/">Create a Practica workspace ${icon('arrow')}</a></aside></main>`;
}

function dialogs() {
  const channels = state.channels.map((channel) => `<option value="${channel.id}">${esc(channel.name)}</option>`).join('');
  const folders = state.folders.map((folder) => `<option value="${folder.id}">${esc(folder.name)}</option>`).join('');
  const shares = getLocalShares().filter((share) => !state.selectedVideo || share.videoId === state.selectedVideo.id);
  return `<dialog id="channel-dialog"><form method="dialog" class="dialog-form" id="channel-form"><div class="dialog-head"><div><p class="kicker">Automatic monitoring</p><h2>Follow a YouTube channel</h2></div><button class="icon-button" value="cancel" aria-label="Close">${icon('close')}</button></div><p>Add the public channel URL or @handle once. Practica will monitor it for newly published videos, retrieve captions when the creator makes them available, and prepare transcript-backed briefs. Leave the URL blank only if you want a manual channel.</p><label>Channel name<input name="name" required maxlength="160" placeholder="e.g. Latent Space"></label><label>Public YouTube channel URL or @handle <span>Required for automatic monitoring</span><input name="youtube_url" maxlength="2000" inputmode="url" placeholder="https://youtube.com/@channel or @channel"></label><label>Description <span>Optional</span><textarea name="description" maxlength="2000" placeholder="Why your team follows this source"></textarea></label><div class="dialog-actions"><button class="secondary" value="cancel">Cancel</button><button class="primary" type="submit" value="default">Add channel</button></div></form></dialog>
  <dialog id="video-dialog"><form method="dialog" class="dialog-form wide" id="video-form"><div class="dialog-head"><div><p class="kicker">Manual fallback</p><h2>Add a video yourself</h2></div><button class="icon-button" value="cancel" aria-label="Close">${icon('close')}</button></div><div class="manual-note">${icon('warning')}<p><strong>Use this when a source is not monitored or captions are unavailable.</strong> You can add the video now and paste its transcript or brief now or later.</p></div><div class="form-grid"><label>Video title<input name="title" required maxlength="300" placeholder="A title your team will recognize"></label><label>Channel<select name="channel"><option value="">No channel</option>${channels}</select></label><label class="full-field">Source URL <span>Optional</span><input name="source_url" type="url" maxlength="2000" placeholder="https://youtube.com/watch?v=…"></label><label>Duration in minutes <span>Optional</span><input name="duration" type="number" min="0" step="0.1" placeholder="42"></label><label>Speaker name <span>Optional</span><input name="speaker" maxlength="160" placeholder="Used for each passage"></label><label class="full-field">Transcript text <span>Optional now; add later from the reader</span><textarea class="transcript-input" name="transcript" placeholder="Paste the transcript. Separate passages with blank lines for easier reading and citation."></textarea></label><label class="full-field">Brief summary <span>Optional, written by your team</span><textarea name="brief" maxlength="30000" placeholder="Capture the practical takeaway without overstating the source."></textarea></label></div><div class="dialog-actions"><button class="secondary" value="cancel">Cancel</button><button class="primary" type="submit" value="default">Add to briefing</button></div></form></dialog>
  <dialog id="transcript-dialog"><form method="dialog" class="dialog-form wide" id="transcript-form"><div class="dialog-head"><div><p class="kicker">Manual fallback</p><h2>Add transcript text</h2></div><button class="icon-button" value="cancel" aria-label="Close">${icon('close')}</button></div><div class="manual-note">${icon('warning')}<p>Paste transcript text when captions are unavailable or you have a better source. Blank lines become separately selectable, citable passages.</p></div><label>Speaker <span>Optional</span><input name="speaker" maxlength="160" placeholder="Speaker or host"></label><label>Transcript text<textarea class="transcript-input" name="transcript" required placeholder="Paste transcript text here…"></textarea></label><div class="dialog-actions"><button class="secondary" value="cancel">Cancel</button><button class="primary" type="submit" value="default">Add transcript</button></div></form></dialog>
  <dialog id="highlight-dialog"><form method="dialog" class="dialog-form" id="highlight-form"><div class="dialog-head"><div><p class="kicker">${state.selectedPassages.size} selected</p><h2>Highlight passages</h2></div><button class="icon-button" value="cancel" aria-label="Close">${icon('close')}</button></div><label>Note <span>Optional</span><textarea name="note" maxlength="10000" placeholder="Why does this matter to your work?"></textarea></label><div class="dialog-actions"><button class="secondary" value="cancel">Cancel</button><button class="primary" type="submit" value="default">Save highlight</button></div></form></dialog>
  <dialog id="save-dialog"><form method="dialog" class="dialog-form" id="save-form"><div class="dialog-head"><div><p class="kicker">${state.selectedPassages.size} selected</p><h2>Save to research</h2></div><button class="icon-button" value="cancel" aria-label="Close">${icon('close')}</button></div><label>Folder<select name="folder"><option value="">Unfiled</option>${folders}</select></label><label>Note <span>Optional</span><textarea name="note" maxlength="10000" placeholder="Add context for your future self"></textarea></label><button class="text-button inline" type="button" data-action="open-folder">${icon('plus')} Create a folder first</button><div class="dialog-actions"><button class="secondary" value="cancel">Cancel</button><button class="primary" type="submit" value="default">Save passages</button></div></form></dialog>
  <dialog id="folder-dialog"><form method="dialog" class="dialog-form" id="folder-form"><div class="dialog-head"><div><p class="kicker">Research library</p><h2>Create a folder</h2></div><button class="icon-button" value="cancel" aria-label="Close">${icon('close')}</button></div><label>Folder name<input name="name" required maxlength="160" placeholder="e.g. Evaluation methods"></label><div class="dialog-actions"><button class="secondary" value="cancel">Cancel</button><button class="primary" type="submit" value="default">Create folder</button></div></form></dialog>
  <dialog id="share-dialog"><div class="dialog-form wide"><div class="dialog-head"><div><p class="kicker">Read-only access</p><h2>Share this source</h2></div><button class="icon-button" data-action="close-dialog" aria-label="Close">${icon('close')}</button></div><p>Create a scoped public link. It never includes private workspace notes, Q&A, highlights, members, or other videos.</p><form id="share-form"><div class="share-options"><label><input type="radio" name="scope" value="video" checked><span><strong>Video source</strong><small>Title, original link, and duration</small></span></label><label><input type="radio" name="scope" value="brief"><span><strong>Brief</strong><small>Video source and latest team brief</small></span></label><label><input type="radio" name="scope" value="transcript"><span><strong>Transcript</strong><small>Video source and transcript passages</small></span></label></div><label>Link expires <span>Optional</span><input type="date" name="expires_at" min="${new Date(Date.now() + 86400000).toISOString().slice(0, 10)}"></label><button class="primary" type="submit">Create public link</button></form>${shares.length ? `<div class="active-shares"><h3>Links created on this device</h3>${shares.map((share) => `<div class="share-row ${share.revoked ? 'revoked' : ''}"><div><strong>${esc(share.scope)} share</strong><small>${share.revoked ? 'Revoked' : `Expires ${fmtDate(share.expires_at)}`}</small></div>${share.revoked ? '' : `<button class="text-button" data-action="copy-share" data-token="${share.token}">Copy link</button><button class="danger-button" data-action="revoke-share" data-id="${share.id}">Revoke</button>`}</div>`).join('')}</div>` : ''}</div></dialog>`;
}

function render() {
  if (currentPath().startsWith('/share/')) root.innerHTML = publicView();
  else if (!pb.authStore.isValid) root.innerHTML = authView();
  else if (!state.booted) root.innerHTML = '<div class="loading-page"><span class="spinner dark"></span><p>Opening your workspace…</p></div>';
  else if (!state.workspace) root.innerHTML = onboardingView();
  else if (currentPath().startsWith('/library')) root.innerHTML = libraryView();
  else if (currentPath().startsWith('/video/') && state.selectedVideo) root.innerHTML = transcriptView(state.selectedVideo);
  else root.innerHTML = feedView();
}

async function route() {
  if (currentPath().startsWith('/share/')) return loadPublicShare(currentPath().split('/')[2] || '');
  if (!pb.authStore.isValid || !state.workspace) return render();
  const videoMatch = currentPath().match(/^\/video\/([^/]+)/);
  if (videoMatch && state.selectedVideo?.id !== videoMatch[1]) await openVideo(videoMatch[1]);
  else render();
}
async function loadPublicShare(token: string) {
  state.publicError = '';
  state.publicShare = null;
  render();
  try { state.publicShare = await pb.send<PublicShare>(`/api/practica/shares/${encodeURIComponent(token)}`, { method: 'GET', requestKey: null }); }
  catch (error) { state.publicError = pbMessage(error, 'The link may have expired or been revoked.'); }
  render();
}

function getForm(target: EventTarget | null) { return target instanceof HTMLFormElement ? new FormData(target) : null; }
function dialog(id: string) { return document.querySelector<HTMLDialogElement>(`#${id}`); }
function splitTranscript(text: string) {
  let parts = text.trim().split(/\n\s*\n+/).map((part) => part.replace(/\s*\n\s*/g, ' ').trim()).filter(Boolean);
  if (parts.length === 1 && parts[0].length > 1000) parts = parts[0].match(/.{1,900}(?:\s|$)/g)?.map((part) => part.trim()).filter(Boolean) || parts;
  return parts.flatMap((part) => part.length <= 19000 ? [part] : (part.match(/.{1,18000}(?:\s|$)/g) || [part]).map((chunk) => chunk.trim())).slice(0, 500);
}
async function createPassages(videoId: string, transcript: string, speaker: string, starting = 0) {
  const parts = splitTranscript(transcript);
  for (let index = 0; index < parts.length; index++) {
    await pb.collection('transcript_passages').create({ workspace: state.workspace!.id, video: videoId, position: starting + index, start_seconds: (starting + index) * 30, end_seconds: (starting + index + 1) * 30, speaker, text: parts[index] });
  }
}
function selectedIds() { return Array.from(state.selectedPassages); }
function getLocalShares(): LocalShare[] {
  try { return JSON.parse(localStorage.getItem('practica.shares') || '[]'); } catch { return []; }
}
function saveLocalShares(shares: LocalShare[]) { localStorage.setItem('practica.shares', JSON.stringify(shares)); }

root.addEventListener('click', async (event) => {
  const button = (event.target as Element).closest<HTMLElement>('[data-action]');
  if (!button) return;
  const action = button.dataset.action;
  if (action === 'navigate') { event.preventDefault(); navigate(button.dataset.path || '/'); }
  if (action === 'toggle-auth') { state.authMode = state.authMode === 'signin' ? 'signup' : 'signin'; state.authError = ''; render(); }
  if (action === 'signout') { pb.authStore.clear(); Object.assign(state, { workspace: null, workspaces: [], booted: true }); navigate('/'); }
  if (action === 'account-menu') { const menu = document.querySelector<HTMLElement>('.account-menu'); if (menu) { menu.hidden = !menu.hidden; button.setAttribute('aria-expanded', String(!menu.hidden)); } }
  if (action === 'filter-channel') { state.channelFilter = button.dataset.id || ''; render(); }
  if (action === 'filter-folder') { state.libraryFilter = button.dataset.id || ''; render(); }
  if (action === 'open-channel') dialog('channel-dialog')?.showModal();
  if (action === 'open-video') dialog('video-dialog')?.showModal();
  if (action === 'open-transcript') dialog('transcript-dialog')?.showModal();
  if (action === 'open-folder') { dialog('save-dialog')?.close(); dialog('folder-dialog')?.showModal(); }
  if (action === 'open-highlight' && state.selectedPassages.size) dialog('highlight-dialog')?.showModal();
  if (action === 'open-save' && state.selectedPassages.size) dialog('save-dialog')?.showModal();
  if (action === 'open-share') dialog('share-dialog')?.showModal();
  if (action === 'close-dialog') button.closest('dialog')?.close();
  if (action === 'open-video-id') await openVideo(button.dataset.id || '');
  if (action === 'toggle-passage') { const id = button.dataset.id!; state.selectedPassages.has(id) ? state.selectedPassages.delete(id) : state.selectedPassages.add(id); render(); }
  if (action === 'clear-selection') { state.selectedPassages.clear(); render(); }
  if (action === 'jump-citation') { document.querySelector(`#passage-${CSS.escape(button.dataset.id || '')}`)?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' }); }
  if (action === 'copy-share') { await navigator.clipboard.writeText(`${location.origin}/share/${button.dataset.token}`); announce('Public link copied'); }
  if (action === 'revoke-share') {
    button.setAttribute('disabled', '');
    try { await pb.send(`/api/practica/shares/${button.dataset.id}/revoke`, { method: 'POST' }); const shares = getLocalShares().map((share) => share.id === button.dataset.id ? { ...share, revoked: true } : share); saveLocalShares(shares); announce('Public link revoked'); }
    catch (error) { announce(pbMessage(error, 'The link could not be revoked.')); }
  }
});

root.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.target as HTMLFormElement;
  const data = getForm(form)!;
  if (!form.reportValidity()) return;
  state.busy = true;
  if (form.id === 'auth-form') {
    state.authError = ''; render();
    try {
      const email = String(data.get('email')); const password = String(data.get('password'));
      if (state.authMode === 'signup') {
        await pb.collection('users').create({ email, password, passwordConfirm: String(data.get('passwordConfirm')), emailVisibility: false });
      }
      await pb.collection('users').authWithPassword(email, password);
      state.booted = false; await loadAccount(); state.booted = true; navigate('/');
    } catch (error) { state.authError = pbMessage(error, state.authMode === 'signup' ? 'We could not create your account. Check the details and try again.' : 'Email or password not recognized.'); }
    finally { state.busy = false; state.booted = true; render(); }
    return;
  }
  try {
    if (form.id === 'workspace-form') {
      const workspace = await pb.collection('workspaces').create<Row>({ name: String(data.get('name')).trim(), owner: pb.authStore.record!.id });
      await pb.collection('members').create({ workspace: workspace.id, user: pb.authStore.record!.id, role: 'owner' });
      state.workspace = workspace; state.workspaces = [workspace]; await loadWorkspace(); navigate('/'); announce('Workspace ready');
    }
    if (form.id === 'channel-form') {
      const youtubeUrl = String(data.get('youtube_url')).trim();
      await pb.collection('channels').create({ workspace: state.workspace!.id, name: String(data.get('name')).trim(), youtube_url: youtubeUrl, description: String(data.get('description')).trim() }); dialog('channel-dialog')?.close(); await loadWorkspace(); announce(youtubeUrl ? 'Channel monitoring started' : 'Manual channel added');
    }
    if (form.id === 'video-form') {
      const transcript = String(data.get('transcript')).trim();
      const video = await pb.collection('videos').create<Row>({ workspace: state.workspace!.id, channel: String(data.get('channel')), title: String(data.get('title')).trim(), source_url: String(data.get('source_url')).trim(), duration_seconds: Number(data.get('duration') || 0) * 60, manual_source: Boolean(transcript), notes: '' });
      if (transcript) await createPassages(video.id, transcript, String(data.get('speaker')).trim());
      const brief = String(data.get('brief')).trim();
      if (brief) await pb.collection('video_briefs').create({ workspace: state.workspace!.id, video: video.id, title: 'Team brief', summary: brief, created_by: pb.authStore.record!.id });
      dialog('video-dialog')?.close(); form.reset(); await loadWorkspace(); announce(transcript ? 'Video and manual transcript added' : 'Manual video added—transcript can be added later');
    }
    if (form.id === 'transcript-form') {
      await createPassages(state.selectedVideo!.id, String(data.get('transcript')), String(data.get('speaker')).trim(), state.passages.length);
      await pb.collection('videos').update(state.selectedVideo!.id, { manual_source: true }); dialog('transcript-dialog')?.close(); await loadWorkspace(); announce('Manual transcript added');
    }
    if (form.id === 'folder-form') {
      await pb.collection('research_folders').create({ workspace: state.workspace!.id, created_by: pb.authStore.record!.id, name: String(data.get('name')).trim() }); dialog('folder-dialog')?.close(); await loadWorkspace(); announce('Research folder created');
    }
    if (form.id === 'highlight-form') {
      for (const passage of selectedIds()) await pb.collection('highlights').create({ workspace: state.workspace!.id, video: state.selectedVideo!.id, passage, created_by: pb.authStore.record!.id, note: String(data.get('note')).trim(), color: 'signal' });
      dialog('highlight-dialog')?.close(); state.selectedPassages.clear(); await loadWorkspace(); announce('Passages highlighted');
    }
    if (form.id === 'save-form') {
      for (const passage of selectedIds()) await pb.collection('saved_passage_items').create({ workspace: state.workspace!.id, folder: String(data.get('folder')), passage, created_by: pb.authStore.record!.id, note: String(data.get('note')).trim() });
      dialog('save-dialog')?.close(); state.selectedPassages.clear(); await loadWorkspace(); announce('Passages saved to research');
    }
    if (form.id === 'qa-form') {
      state.answerError = ''; state.answer = null; render();
      const passageIds = (state.selectedPassages.size ? selectedIds() : state.passages.map((item) => item.id)).slice(0, 50);
      try { state.answer = await pb.send<Answer>('/api/practica/questions', { method: 'POST', body: { workspace: state.workspace!.id, video: state.selectedVideo!.id, question: String(data.get('question')).trim(), passage_ids: passageIds } }); }
      catch (error) { state.answerError = pbMessage(error, 'Grounded Q&A is unavailable right now. Please retry later.'); }
    }
    if (form.id === 'share-form') {
      const expires = String(data.get('expires_at'));
      const result = await pb.send<any>('/api/practica/shares', { method: 'POST', body: { workspace: state.workspace!.id, video: state.selectedVideo!.id, scope: String(data.get('scope')), expires_at: expires ? new Date(`${expires}T23:59:59`).toISOString() : '' } });
      const shares = getLocalShares(); shares.unshift({ id: result.id, token: result.token, scope: result.scope, expires_at: result.expires_at, videoId: state.selectedVideo!.id, videoTitle: state.selectedVideo!.title }); saveLocalShares(shares); render(); dialog('share-dialog')?.showModal(); announce('Read-only public link created');
    }
  } catch (error) { announce(pbMessage(error, 'That change could not be saved. Check the details and try again.')); }
  finally { state.busy = false; render(); }
});

window.addEventListener('popstate', route);
pb.authStore.onChange(() => { if (!pb.authStore.isValid && !currentPath().startsWith('/share/')) render(); });
void boot();
