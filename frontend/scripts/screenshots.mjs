// Capture real README screenshots from the actual running app.
//
// Boots a THROWAWAY backend against a temp DOCSEEK_DATA_DIR (so your real
// data/ is never touched) plus the Vite dev server, seeds a few demo
// notebooks, drives a real agentic /ask, and screenshots the live UI into
// ../docs/images/.
//
// Prereqs: project .venv set up, `npm i` in frontend/, `npx playwright install
// chromium`, and Ollama running with the configured model pulled.
//
// Run from frontend/:  npm run screenshots
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdtempSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const FRONTEND = path.resolve(ROOT, 'frontend');
const IMAGES = path.resolve(ROOT, 'docs', 'images');

// Isolated ports so this never collides with (or seeds into) a live backend
// running on the default 8000 / a dev server on 5173.
const BACKEND_PORT = 8123;
const FRONTEND_PORT = 5199;
const API = `http://127.0.0.1:${BACKEND_PORT}`;
const WEB = `http://localhost:${FRONTEND_PORT}`;
const DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'docseek_shots_'));

const children = [];
function spawnProc(cmd, args, opts) {
  const p = spawn(cmd, args, { detached: true, stdio: 'ignore', ...opts });
  children.push(p);
  return p;
}
function killAll() {
  for (const p of children) {
    try { process.kill(-p.pid, 'SIGTERM'); } catch { /* already gone */ }
  }
}

async function waitFor(url, { timeout = 180000, label = url } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch { /* not up yet */ }
    await sleep(1000);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function api(pathname, body) {
  const r = await fetch(`${API}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`POST ${pathname} → ${r.status}: ${await r.text()}`);
  return r.json();
}

const HANDBOOK_DOCS = [
  'docSeek is a local-first agentic RAG system. Every step — parsing, embedding, vector search, reranking, speech-to-text, text-to-speech, and LLM reasoning — runs entirely on your device. No documents are ever sent to an external service; model weights download once from HuggingFace and then everything works fully offline.',
  'Retrieval is agentic. A local LLM plans each query, rewrites unclear questions, and decomposes complex ones into sub-queries. It retrieves with hybrid search — dense vectors from FAISS fused with BM25 keyword hits via Reciprocal Rank Fusion — optionally reranks with a local cross-encoder, grades whether the evidence answers the question, and re-loops with a reformulated query when the evidence is weak.',
  'Notebooks keep document sets isolated. Each notebook has its own SQLite database, its own FAISS index, its own uploaded files, and its own audio. Switching notebooks scopes every search and every answer to just that notebook, so unrelated projects never bleed into each other.',
  'Answers are grounded and cited. The system numbers each retrieved chunk and asks the model to cite them inline with bracketed markers, which the interface renders as clickable citation chips that jump to the exact source passage.',
  'Beyond chat, docSeek can read answers aloud, generate a two-host audio overview of your sources, and write multi-section deep-research reports — all with local models, no cloud calls.',
];

async function seed() {
  // Primary notebook, richly seeded, used for the workspace shot.
  const handbook = await api('/notebooks', { name: 'docSeek Handbook', emoji: '📗' });
  for (const [i, text] of HANDBOOK_DOCS.entries()) {
    const name = ['overview', 'retrieval', 'notebooks', 'citations', 'media'][i] + '.md';
    await api('/ingest', {
      text,
      metadata: JSON.stringify({ filename: name, source_file: name }),
      notebook_id: handbook.id,
    });
  }
  // A couple more notebooks so the dashboard shows a realistic grid.
  const more = [
    { name: 'ML Research Papers', emoji: '🧠', docs: ['Transformers use self-attention to weigh token relationships.', 'Retrieval-augmented generation grounds LLM answers in retrieved evidence.'] },
    { name: 'Product Specs', emoji: '📋', docs: ['The onboarding flow must complete in under three steps.', 'All destructive actions require a confirmation dialog.', 'Dark and light themes share one tokenized design system.'] },
  ];
  for (const nb of more) {
    const rec = await api('/notebooks', { name: nb.name, emoji: nb.emoji });
    for (const [i, text] of nb.docs.entries()) {
      await api('/ingest', {
        text,
        metadata: JSON.stringify({ filename: `note-${i + 1}.md`, source_file: `note-${i + 1}.md` }),
        notebook_id: rec.id,
      });
    }
  }
  return handbook.id;
}

async function main() {
  console.log(`[shots] temp data dir: ${DATA_DIR}`);

  console.log('[shots] starting backend…');
  spawnProc(path.join(ROOT, '.venv', 'bin', 'python'), ['-m', 'app.server'], {
    cwd: ROOT,
    env: { ...process.env, DOCSEEK_DATA_DIR: DATA_DIR, DOCSEEK_PORT: String(BACKEND_PORT) },
  });
  await waitFor(`${API}/notebooks`, { label: 'backend' });

  console.log('[shots] starting frontend (vite)…');
  spawnProc(path.join(FRONTEND, 'node_modules', '.bin', 'vite'), ['--port', String(FRONTEND_PORT), '--strictPort'], {
    cwd: FRONTEND,
    env: { ...process.env, DOCSEEK_API_TARGET: API },
  });
  await waitFor(WEB, { label: 'frontend' });

  console.log('[shots] seeding demo notebooks…');
  const handbookId = await seed();

  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
  });
  // Force the light (cream) theme for clean, bright screenshots.
  await page.addInitScript(() => localStorage.setItem('ds_theme', 'light'));

  console.log('[shots] capturing dashboard…');
  await page.goto(`${WEB}/app`, { waitUntil: 'networkidle' });
  await page.getByText('docSeek Handbook').waitFor({ timeout: 30000 });
  await sleep(600);
  // Tighter frame for the dashboard so the cards aren't lost in empty space.
  await page.setViewportSize({ width: 1440, height: 620 });
  await sleep(200);
  await page.screenshot({ path: path.join(IMAGES, 'notebooks_dashboard.jpg'), type: 'jpeg', quality: 92 });
  await page.setViewportSize({ width: 1440, height: 900 });

  console.log('[shots] capturing workspace (driving a real question)…');
  await page.goto(`${WEB}/app/${handbookId}`, { waitUntil: 'networkidle' });
  // Wait for the sources panel to populate.
  await page.getByText('overview.md').first().waitFor({ timeout: 30000 });
  const QUESTION = 'How does docSeek keep my data private, and how does its retrieval work?';
  const ask = page.getByPlaceholder('Ask your sources…');
  await ask.waitFor({ timeout: 30000 });
  await ask.fill(QUESTION);
  await ask.press('Enter');
  // Wait for the answer to start streaming (agent loop + local LLM take a while).
  await page.locator('.answer-prose').first().waitFor({ timeout: 180000 });
  // Wait for streaming to FINISH so we don't capture a half-written answer: the
  // ask input is re-enabled (isSearching flips false) only when the stream ends.
  await page
    .waitForFunction(
      () => {
        const el = document.querySelector('input[placeholder="Ask your sources…"]');
        return el && !el.disabled;
      },
      { timeout: 180000 },
    )
    .catch(() => {});
  await sleep(500);
  // The agent trace auto-collapses when the answer finishes — re-expand it so
  // the plan/retrieve/rerank/grade steps are visible in the shot.
  const trace = page.getByText('AGENT ACTIVITY');
  if (await trace.count()) await trace.first().click().catch(() => {});
  // Frame the question + trace + answer at the top (the view auto-scrolled to
  // the answer's end when streaming stopped).
  await page.evaluate((q) => {
    const el = [...document.querySelectorAll('*')].find(
      (e) => e.childNodes.length === 1 && e.textContent && e.textContent.trim() === q,
    );
    el?.scrollIntoView({ block: 'center' });
  }, QUESTION);
  await sleep(700);
  await page.screenshot({ path: path.join(IMAGES, 'workspace_chat.jpg'), type: 'jpeg', quality: 92 });

  await browser.close();
  console.log(`[shots] done → ${IMAGES}`);
}

main()
  .then(() => { killAll(); process.exit(0); })
  .catch((e) => { console.error('[shots] FAILED:', e); killAll(); process.exit(1); });
