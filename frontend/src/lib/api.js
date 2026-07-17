/**
 * DocSeek API Abstraction Layer
 * All backend communication funnels through here.
 */

const BASE = '/api';

async function request(path, options = {}) {
  const url = `${BASE}${path}`;
  const start = performance.now();

  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options,
  });

  const latency = Math.round(performance.now() - start);

  if (!res.ok) {
    const body = await res.text();
    throw new Error(body || `HTTP ${res.status}`);
  }

  const contentType = res.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await res.json() : await res.text();
  return { data, latency, status: res.status };
}

/* ── Health / System ─────────────────────────────────── */

export async function getStats() {
  return request('/stats');
}

export async function getDocuments() {
  return request('/documents');
}

/** Rich per-source listing: filename, chunk count, first_chunk_id, chunking. */
export async function getSources() {
  return request('/sources');
}

/** Delete every chunk belonging to a source file. */
export async function deleteSource(sourceFile) {
  return request(`/documents?source_file=${encodeURIComponent(sourceFile)}`, {
    method: 'DELETE',
  });
}

export async function getIngestStatus() {
  return request('/ingest/status');
}

/* ── Document Ingestion ──────────────────────────────── */

export async function uploadFile(file, chunkingStrategy = null) {
  const form = new FormData();
  form.append('file', file);
  if (chunkingStrategy) form.append('chunking_strategy', chunkingStrategy);

  const url = `${BASE}/upload`;
  const start = performance.now();

  const res = await fetch(url, { method: 'POST', body: form });
  const latency = Math.round(performance.now() - start);

  if (!res.ok) throw new Error(`Upload failed: HTTP ${res.status}`);
  const data = await res.json();
  return { data, latency };
}

export async function uploadMultiple(files) {
  const form = new FormData();
  files.forEach((f) => form.append('files', f));

  const url = `${BASE}/upload-multiple`;
  const start = performance.now();

  const res = await fetch(url, { method: 'POST', body: form });
  const latency = Math.round(performance.now() - start);

  if (!res.ok) throw new Error(`Multi-upload failed: HTTP ${res.status}`);
  const data = await res.json();
  return { data, latency };
}

export async function ingestText(text, metadata = null) {
  return request('/ingest', {
    method: 'POST',
    body: JSON.stringify({ text, metadata }),
  });
}

export async function ingestGithub(repoUrl, subpath = null) {
  return request('/ingest/github', {
    method: 'POST',
    body: JSON.stringify({ repo_url: repoUrl, subpath }),
  });
}

/* ── Dictation (local speech-to-text) ────────────────── */

/**
 * Transcribe a recorded audio blob to text, fully on-device.
 * @param {Blob} blob - audio from MediaRecorder (webm/ogg/wav)
 * @returns {Promise<{data: {text: string, language: string, duration: number}, latency: number}>}
 */
export async function transcribe(blob) {
  const form = new FormData();
  // Extension hints the container to the backend; content type comes from the blob.
  const ext = (blob.type && blob.type.includes('ogg')) ? 'ogg'
    : (blob.type && blob.type.includes('wav')) ? 'wav' : 'webm';
  form.append('file', blob, `dictation.${ext}`);

  const url = `${BASE}/transcribe`;
  const start = performance.now();
  const res = await fetch(url, { method: 'POST', body: form });
  const latency = Math.round(performance.now() - start);

  if (!res.ok) {
    const body = await res.text();
    throw new Error(body || `Transcription failed: HTTP ${res.status}`);
  }
  const data = await res.json();
  return { data, latency };
}

/* ── Podcast (local audio overview) ──────────────────── */

/** Start generating a two-host audio overview for the given sources. */
export async function createPodcast(sourceFiles) {
  return request('/podcast', {
    method: 'POST',
    body: JSON.stringify({ source_files: sourceFiles }),
  });
}

/** Poll the status of a podcast generation job. */
export async function getPodcastStatus(jobId) {
  return request(`/podcast/status?job_id=${encodeURIComponent(jobId)}`);
}

/** List all generated episodes, newest first. */
export async function getPodcasts() {
  return request('/podcasts');
}

/** URL for the generated WAV of a completed episode. */
export function getPodcastAudioUrl(jobId) {
  return `${BASE}/podcast/audio?job_id=${encodeURIComponent(jobId)}`;
}

/**
 * Read a short piece of text aloud (single local voice).
 * Returns an object URL for the WAV; the caller must revoke it when done.
 */
export async function synthesizeSpeech(text, voice = null) {
  const res = await fetch(`${BASE}/tts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, voice }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(body || `Read-aloud failed: HTTP ${res.status}`);
  }
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

/* ── Search / Query ──────────────────────────────────── */

export async function search(query, k = 5, rerank = false, sourceFiles = null) {
  return request('/search', {
    method: 'POST',
    body: JSON.stringify({ query, k, rerank, source_files: sourceFiles }),
  });
}

/**
 * Ask the LLM a question using agentic RAG (streaming SSE response).
 *
 * The backend streams typed SSE events:
 * - "trace":   agent decision steps (plan / retrieve / rerank / grade / loop)
 * - "sources": the retrieved chunks used as context
 * - default:   JSON-encoded answer text deltas
 *
 * @param {string} query - The user's question
 * @param {number|null} k - Number of chunks to retrieve (null = agent decides)
 * @param {function} onChunk - Called with the accumulated answer text
 * @param {object} [handlers] - Optional { onTrace(event), onSources(list), agentic, sourceFiles }
 * @returns {Promise<{data: string, latency: number}>}
 */
export async function ask(query, k = null, onChunk, handlers = {}) {
  const { onTrace, onSources, agentic = null, sourceFiles = null } = handlers;
  const url = `${BASE}/ask`;
  const start = performance.now();

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, k, agentic, source_files: sourceFiles }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(body || `HTTP ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let accumulated = '';
  let buffer = '';
  let eventName = '';
  let dataLines = [];

  const dispatch = () => {
    if (dataLines.length === 0) {
      eventName = '';
      return;
    }
    const rawData = dataLines.join('\n');
    dataLines = [];
    const name = eventName;
    eventName = '';

    let parsed;
    try {
      parsed = JSON.parse(rawData);
    } catch {
      parsed = rawData; // fallback for non-JSON payloads
    }

    if (name === 'trace') {
      if (onTrace && typeof parsed === 'object') onTrace(parsed);
    } else if (name === 'sources') {
      if (onSources && Array.isArray(parsed)) onSources(parsed);
    } else if (typeof parsed === 'string') {
      // Unnamed events carry JSON-encoded answer text deltas; anything else
      // is a typed payload that must never leak into the answer text.
      accumulated += parsed;
      if (onChunk) onChunk(accumulated);
    }
  };

  const processLine = (line) => {
    if (line === '') {
      dispatch(); // blank line terminates an SSE event block
    } else if (line.startsWith('event:')) {
      eventName = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).replace(/^ /, ''));
    }
    // Ignore comments / id / retry fields.
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    for (const line of lines) processLine(line);
  }

  dispatch(); // flush any trailing event without a final blank line

  const latency = Math.round(performance.now() - start);
  return { data: accumulated, latency };
}

/* ── Index Management ────────────────────────────────── */

export async function rebuildIndex() {
  return request('/rebuild', { method: 'POST' });
}

export async function resetSystem() {
  return request('/reset', { method: 'DELETE' });
}

/* ── Document View ───────────────────────────────────── */

export function getDocumentViewUrl(docId) {
  return `${BASE}/document/view?id=${docId}`;
}
