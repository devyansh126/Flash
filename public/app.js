// --- 0. API layer ---
// Frontend is served by the same Express server as the API (see
// server.js), so requests are same-origin — no base URL needed.
const API_BASE = "";
const TOKEN_KEY = "flash_token";
const USER_KEY = "flash_user";

function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

function setSession(token, user) {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

function getCurrentUser() {
  try {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

// Thin wrapper around fetch: attaches the bearer token, parses JSON, and
// throws with the backend's { error } message on non-2xx responses.
async function apiFetch(path, options = {}) {
  const token = getToken();
  const headers = options.headers ? { ...options.headers } : {};
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(API_BASE + path, { ...options, headers });
  const isJson = (res.headers.get("content-type") || "").includes("application/json");
  const body = isJson ? await res.json().catch(() => ({})) : null;

  if (!res.ok) {
    const message = (body && body.error) || `Request failed (${res.status})`;
    const err = new Error(message);
    err.status = res.status;
    throw err;
  }
  return body;
}

// --- 1. State Management ---
const state = {
  auth: {
    token: getToken(),
    user: getCurrentUser(),
  },
  flashcard: {
    index: 0,
    flipped: false,
    missed: [],
    cards: [],
    status: "loading", // loading | processing | ready | failed | error
  },
  signin: {
    mode: "signin",
    name: "",
    email: "",
    password: "",
    error: "",
    submitting: false,
  },
  home: {
    title: "",
    pdfFile: null,
    images: [], // array of { id, file, url }
    retryingIds: new Set(),
    noteSets: [],
    loading: true,
    error: "",
    submitting: false,
  },
  revise: {
    noteSets: [],
    loading: true,
    error: "",
  },
  quizPicker: {
    noteSets: [],
    loading: true,
    error: "",
  },
  quiz: {
    setId: null,
    _loadedFor: null,
    status: "loading", // loading | ready | failed | error
    cards: [],
    order: [],
    index: 0,
    score: 0,
    options: [],
    correctIndex: null,
    selectedIndex: null,
    answered: false,
    finished: false,
  },
};

function shuffleArray(input) {
  const arr = input.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

let pollTimer = null;
function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function isAuthed() {
  return Boolean(state.auth.token);
}

// --- 2. Component Builders ---
function createStatusBadge(status) {
  const styles = {
    ready: "chip chip-ready",
    processing: "chip chip-processing",
    failed: "chip chip-failed",
  };
  return `<span class="${styles[status] || "chip"}">${status}</span>`;
}

function formatUpdatedAt(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function createNoteSetCard(set) {
  const isRetrying = state.home.retryingIds.has(set.id);
  const currentStatus = isRetrying ? "processing" : set.status;
  const disabled = currentStatus !== "ready";
  const cardCount = typeof set.cardCount === "number" ? set.cardCount : null;

  const cardBody = `
    <div class="flex items-start justify-between gap-4">
      <h3 class="text-xl text-ink">${set.title}</h3>
      ${createStatusBadge(currentStatus)}
    </div>
    <p class="mt-2 font-mono text-xs text-ink-soft">${set.sourceType === "pdf" ? "PDF" : "Image"}</p>
    <div class="mt-6 flex items-center justify-between font-mono text-xs text-ink-faint">
      <span>${cardCount ? cardCount + " cards" : "— cards"}</span>
      <span>${formatUpdatedAt(set.createdAt)}</span>
    </div>
  `;

  if (disabled) {
    return `
      <div class="surface p-5" style="opacity: 0.9;" aria-disabled="true" title="${
        currentStatus === "processing" ? "Still generating cards" : "Generation failed — retry soon"
      }">
        ${cardBody}
        ${
          set.status === "failed"
            ? `
          <div class="mt-5 flex items-center gap-3">
            <button class="btn-base btn-danger text-xs" ${isRetrying ? "disabled" : ""} onclick="handleRetry('${set.id}')">
              ${isRetrying ? "Retrying…" : "Retry generation"}
            </button>
            ${isRetrying ? '<span class="font-mono text-xs text-ink-soft">Queued for another pass</span>' : ""}
          </div>
        `
            : ""
        }
      </div>
    `;
  }

  return `
    <a href="#/study?set=${set.id}" class="surface-interactive p-5">
      ${cardBody}
    </a>
  `;
}

// --- 3. Data loading ---
async function loadNoteSets(mainEl) {
  try {
    const data = await apiFetch("/api/notesets");
    state.home.noteSets = data.noteSets || [];
    state.home.error = "";

    // Once the backend reports a set is no longer "processing", drop the
    // local optimistic "retrying" flag so its real status (ready/failed)
    // shows through instead of staying stuck on "processing" forever.
    for (const set of state.home.noteSets) {
      if (state.home.retryingIds.has(set.id) && set.status !== "processing") {
        state.home.retryingIds.delete(set.id);
      }
    }
  } catch (err) {
    if (err.status === 401) {
      handleSignOut();
      return;
    }
    state.home.error = err.message;
  } finally {
    state.home.loading = false;
    if (mainEl) renderHomeView(mainEl, { skipFetch: true });
  }

  // Keep polling while anything is still processing, so statuses flip to
  // ready/failed without the user having to refresh.
  const stillProcessing = state.home.noteSets.some(
    (s) => s.status === "processing" || state.home.retryingIds.has(s.id)
  );
  if (stillProcessing && !pollTimer) {
    pollTimer = setInterval(() => loadNoteSets(document.getElementById("app")), 3000);
  } else if (!stillProcessing) {
    stopPolling();
  }
}

// --- 4. Views ---
function renderHomeView(mainEl, opts = {}) {
  mainEl.className = "main-container";

  if (state.home.loading && !opts.skipFetch) {
    mainEl.innerHTML = `<p class="font-mono text-xs text-ink-faint">Loading your sets…</p>`;
    loadNoteSets(mainEl);
    return;
  }

  mainEl.innerHTML = `
    <p class="font-mono text-xs uppercase tracking-widest text-ink-faint">Night study workspace</p>
    <h1 class="text-gradient mt-4 text-5xl" style="line-height: 1.05;">
      Turn tonight's notes into tomorrow's recall.
    </h1>
    <p class="mt-5 text-sm text-ink-soft" style="max-width: 42rem; line-height: 1.6;">
      Upload a PDF document or up to 10 album images of your study materials. Flash shapes them into flashcards you can drill in the dark.
    </p>

    <section class="surface mt-10 p-6" aria-labelledby="new-set">
      <h2 id="new-set" class="text-xl text-ink">New note set</h2>

      <div class="mt-5 flex flex-col gap-5">
        <label class="flex flex-col gap-2">
          <span class="font-mono text-xs uppercase tracking-wide text-ink-soft">Set Title</span>
          <input id="note-title" class="field" placeholder="e.g. Orbital Mechanics" value="${state.home.title}" />
        </label>

        <!-- Document & Image Upload Section (2 Columns) -->
        <div class="grid-gap-4 sm:grid-cols-2">
          <!-- PDF Upload Button -->
          <div class="upload-dropzone" onclick="document.getElementById('input-pdf').click()">
            <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="var(--violet-bright)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
              <polyline points="14 2 14 8 20 8"></polyline>
              <line x1="12" y1="18" x2="12" y2="12"></line>
              <line x1="9" y1="15" x2="15" y2="15"></line>
            </svg>
            <span class="mt-2 text-sm font-semibold text-ink">Upload PDF</span>
            <span class="mt-1 font-mono text-xs text-ink-faint">Document file</span>
            <input type="file" id="input-pdf" accept="application/pdf" style="display:none;" />
          </div>

          <!-- Album Upload Button -->
          <div class="upload-dropzone" onclick="document.getElementById('input-album').click()">
            <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="var(--violet-bright)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
              <circle cx="8.5" cy="8.5" r="1.5"></circle>
              <polyline points="21 15 16 10 5 21"></polyline>
            </svg>
            <span class="mt-2 text-sm font-semibold text-ink">Upload Images</span>
            <span class="mt-1 font-mono text-xs text-ink-faint">Album (Max 10)</span>
            <input type="file" id="input-album" accept="image/*" multiple style="display:none;" />
          </div>
        </div>

        <!-- Selected PDF File Label -->
        <div id="pdf-file-info" class="font-mono text-xs text-violet-bright" style="display: ${state.home.pdfFile ? 'block' : 'none'};">
          📄 PDF Attached: <span>${state.home.pdfFile ? state.home.pdfFile.name : ''}</span>
          <button type="button" id="btn-remove-pdf" class="btn-ghost text-xs ml-2" style="padding: 2px 6px; margin-left:8px; border-radius:4px;">Remove</button>
        </div>

        <!-- Image Gallery Preview Container -->
        <div id="image-preview-section" style="display: ${state.home.images.length > 0 ? 'block' : 'none'};">
          <div class="flex items-center justify-between font-mono text-xs text-ink-soft">
            <span>Uploaded Images</span>
            <span id="img-count">${state.home.images.length}/10</span>
          </div>
          <div id="preview-grid" class="preview-grid">
            ${state.home.images.map(img => `
              <div class="preview-thumb">
                <img src="${img.url}" alt="Upload preview" />
                <button type="button" class="remove-thumb" onclick="removeImage('${img.id}')">&times;</button>
              </div>
            `).join("")}
          </div>
        </div>

        ${
          state.home.pdfFile && state.home.images.length > 0
            ? `<p class="font-mono text-xs text-ink-faint">Note: a note set uses one source — the PDF will be used and the images ignored for this set.</p>`
            : ""
        }
        ${state.home.error ? `<p class="font-mono text-xs text-magenta">${state.home.error}</p>` : ""}

        <!-- Action Controls -->
        <div class="flex items-center gap-3 mt-2">
          <button id="btn-generate" class="btn-base btn-primary" ${canGenerate() ? "" : "disabled"}>
            ${state.home.submitting ? "Uploading…" : "Generate cards"}
          </button>
          <button id="btn-clear" class="btn-base btn-ghost">Clear all</button>
        </div>
      </div>
    </section>

    <section class="mt-16" aria-labelledby="your-sets">
      <div class="flex items-center justify-between">
        <h2 id="your-sets" class="text-xl text-ink">Your sets</h2>
        <span class="font-mono text-xs text-ink-faint">${state.home.noteSets.length} total</span>
      </div>
      <div class="mt-6 grid-gap-4 sm:grid-cols-2">
        ${
          state.home.noteSets.length
            ? state.home.noteSets.map((set) => createNoteSetCard(set)).join("")
            : `<p class="font-mono text-xs text-ink-faint">No note sets yet — upload something above to get started.</p>`
        }
      </div>
    </section>
  `;

  // Dynamic input & file listeners
  const titleInput = document.getElementById("note-title");
  const generateBtn = document.getElementById("btn-generate");
  const clearBtn = document.getElementById("btn-clear");
  const pdfInput = document.getElementById("input-pdf");
  const albumInput = document.getElementById("input-album");
  const removePdfBtn = document.getElementById("btn-remove-pdf");

  function canGenerateInner() {
    return canGenerate();
  }

  function updateButtons() {
    generateBtn.disabled = !canGenerateInner() || state.home.submitting;
  }

  titleInput.addEventListener("input", (e) => {
    state.home.title = e.target.value;
    updateButtons();
  });

  pdfInput.addEventListener("change", (e) => {
    if (e.target.files && e.target.files[0]) {
      state.home.pdfFile = e.target.files[0];
      renderHomeView(mainEl, { skipFetch: true });
    }
  });

  if (removePdfBtn) {
    removePdfBtn.addEventListener("click", () => {
      state.home.pdfFile = null;
      renderHomeView(mainEl, { skipFetch: true });
    });
  }

  const handleImageFiles = (files) => {
    const fileList = Array.from(files);
    const availableSlots = 10 - state.home.images.length;
    if (availableSlots <= 0) {
      alert("Maximum limit of 10 images reached.");
      return;
    }

    const allowed = fileList.slice(0, availableSlots);
    allowed.forEach((file) => {
      const url = URL.createObjectURL(file);
      state.home.images.push({
        id: "img_" + Math.random().toString(36).substr(2, 9),
        file,
        url,
      });
    });
    renderHomeView(mainEl, { skipFetch: true });
  };

  albumInput.addEventListener("change", (e) => {
    if (e.target.files) handleImageFiles(e.target.files);
  });

  clearBtn.addEventListener("click", () => {
    state.home.title = "";
    state.home.pdfFile = null;
    state.home.images.forEach(img => URL.revokeObjectURL(img.url));
    state.home.images = [];
    state.home.error = "";
    renderHomeView(mainEl, { skipFetch: true });
  });

  generateBtn.addEventListener("click", () => handleGenerate(mainEl));
}

function canGenerate() {
  return Boolean(
    state.home.title &&
    (state.home.pdfFile || state.home.images.length > 0) &&
    !state.home.submitting
  );
}

async function handleGenerate(mainEl) {
  // PDF wins if both are attached (matches the note shown in the UI);
  // otherwise every selected image goes up together as one note set.
  const usingPdf = Boolean(state.home.pdfFile);
  if ((!usingPdf && state.home.images.length === 0) || !state.home.title) return;

  state.home.submitting = true;
  state.home.error = "";
  renderHomeView(mainEl, { skipFetch: true });

  try {
    const formData = new FormData();
    formData.append("title", state.home.title);
    if (usingPdf) {
      formData.append("file", state.home.pdfFile);
    } else {
      state.home.images.forEach((img) => formData.append("images", img.file));
    }

    await apiFetch("/api/notesets", { method: "POST", body: formData });

    state.home.title = "";
    state.home.pdfFile = null;
    state.home.images.forEach((img) => URL.revokeObjectURL(img.url));
    state.home.images = [];
    state.home.loading = true;
    state.home.submitting = false;
    renderHomeView(mainEl);
  } catch (err) {
    state.home.submitting = false;
    if (err.status === 401) {
      handleSignOut();
      return;
    }
    state.home.error = err.message;
    renderHomeView(mainEl, { skipFetch: true });
  }
}

window.removeImage = function(id) {
  const target = state.home.images.find(img => img.id === id);
  if (target) {
    URL.revokeObjectURL(target.url);
  }
  state.home.images = state.home.images.filter(img => img.id !== id);
  const mainEl = document.getElementById("app");
  renderHomeView(mainEl, { skipFetch: true });
};

// Sets picker shown at #/study with no ?set= — always refetches note sets
// fresh from the server (never reuses the Home page's cached state.home
// list) so statuses/newly-generated sets are current when you land here.
async function renderRevisePicker(mainEl, opts = {}) {
  mainEl.className = "main-container";

  if (!opts.skipFetch) {
    mainEl.innerHTML = `
      <p class="font-mono text-xs uppercase tracking-widest text-ink-faint">revision mode</p>
      <h1 class="mt-3 text-3xl text-ink">Revise</h1>
      <p class="mt-8 font-mono text-xs text-ink-faint">Loading your sets…</p>
    `;
    try {
      const data = await apiFetch("/api/notesets");
      state.revise.noteSets = data.noteSets || [];
      state.revise.error = "";
    } catch (err) {
      if (err.status === 401) {
        handleSignOut();
        return;
      }
      state.revise.error = err.message;
    }
    state.revise.loading = false;
    renderRevisePicker(mainEl, { skipFetch: true });
    return;
  }

  const readySets = state.revise.noteSets.filter((s) => s.status === "ready");

  mainEl.innerHTML = `
    <p class="font-mono text-xs uppercase tracking-widest text-ink-faint">revision mode</p>
    <h1 class="mt-3 text-3xl text-ink">Revise</h1>
    <p class="mt-2 text-sm text-ink-soft">Pick a set to start a study session.</p>
    ${state.revise.error ? `<p class="mt-4 font-mono text-xs text-magenta">${state.revise.error}</p>` : ""}
    <div class="mt-8 grid-gap-4 sm:grid-cols-2">
      ${
        readySets.length
          ? readySets
              .map(
                (set) => `
              <a href="#/study?set=${set.id}" class="surface-interactive p-5">
                <div class="flex items-start justify-between gap-4">
                  <h3 class="text-xl text-ink">${set.title}</h3>
                  ${createStatusBadge(set.status)}
                </div>
                <p class="mt-2 font-mono text-xs text-ink-soft">${set.sourceType === "pdf" ? "PDF" : "Image"}</p>
                <p class="mt-6 font-mono text-xs text-ink-faint">${formatUpdatedAt(set.createdAt)}</p>
              </a>
            `
              )
              .join("")
          : `<p class="font-mono text-xs text-ink-faint">${
              state.revise.noteSets.length
                ? "No sets are ready yet — check back once generation finishes."
                : "No note sets yet — go upload something first."
            }</p>`
      }
    </div>
    <p class="mt-8"><a href="#/" class="btn-base btn-ghost">Upload a new set</a></p>
  `;
}

// --- Regeneration (shared by Revise and Quiz) ---
// Keyed by noteSetId. Not part of `state` since it's transient UI status
// for an in-flight network call, not data to persist/reset alongside it.
const regenBusy = {};
const regenError = {};

// Polls GET /cards until the set leaves "processing" (regenerate responds
// 202 immediately, then keeps working server-side) or the timeout hits.
async function waitForNoteSetReady(setId, { intervalMs = 2000, timeoutMs = 120000 } = {}) {
  const start = Date.now();
  for (;;) {
    const data = await apiFetch(`/api/notesets/${encodeURIComponent(setId)}/cards`);
    if (data.status !== "processing") return data;
    if (Date.now() - start > timeoutMs) {
      throw new Error("Regeneration is taking longer than expected — check back in a bit.");
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

// Regenerates a fresh deck for setId, then drops the caller straight back
// into a session with the new cards (rather than back to a picker).
// kind is "study" or "quiz" — whichever view triggered it re-renders itself.
async function triggerRegenerate(setId, mainEl, kind, searchParams) {
  regenBusy[setId] = true;
  regenError[setId] = null;
  const rerender = () => (kind === "study" ? renderStudyView(mainEl, searchParams) : renderQuizView(mainEl, searchParams));
  rerender();

  try {
    await apiFetch(`/api/notesets/${encodeURIComponent(setId)}/regenerate`, { method: "POST" });
    const data = await waitForNoteSetReady(setId);

    if (kind === "study") {
      state.flashcard.status = data.status;
      state.flashcard.cards = data.cards || [];
      state.flashcard.index = 0;
      state.flashcard.flipped = false;
      state.flashcard.missed = [];
      state.flashcard._loadedFor = setId;
    } else {
      state.quiz.status = data.status;
      state.quiz.cards = data.cards || [];
      state.quiz.order = shuffleArray(state.quiz.cards.map((_, i) => i));
      state.quiz.index = 0;
      state.quiz.score = 0;
      state.quiz.finished = false;
      state.quiz._loadedFor = setId;
      if (data.status === "ready" && state.quiz.cards.length >= 2) buildQuizQuestion(0);
    }
  } catch (err) {
    if (err.status === 401) {
      handleSignOut();
      return;
    }
    regenError[setId] = err.message || "Regeneration failed — try again.";
  } finally {
    regenBusy[setId] = false;
    rerender();
  }
}

async function renderStudyView(mainEl, searchParams) {
  mainEl.className = "main-container narrow";
  const setId = searchParams.get("set");

  if (!setId) {
    renderRevisePicker(mainEl);
    return;
  }

  if (state.flashcard.status === "loading" || state.flashcard._loadedFor !== setId) {
    mainEl.innerHTML = `<p class="font-mono text-xs text-ink-faint">Loading cards…</p>`;
    try {
      const data = await apiFetch(`/api/notesets/${encodeURIComponent(setId)}/cards`);
      state.flashcard.status = data.status;
      state.flashcard.cards = data.cards || [];
      state.flashcard.index = 0;
      state.flashcard.flipped = false;
      state.flashcard.missed = [];
      state.flashcard._loadedFor = setId;
    } catch (err) {
      if (err.status === 401) {
        handleSignOut();
        return;
      }
      state.flashcard.status = "error";
      state.flashcard._loadedFor = setId;
      state.flashcard._error = err.message;
    }
    renderStudyView(mainEl, searchParams);
    return;
  }

  if (state.flashcard.status !== "ready") {
    const messages = {
      processing: "This set is still generating — check back in a moment.",
      failed: "Card generation failed for this set. Go back and retry it.",
      error: state.flashcard._error || "Couldn't load this set.",
    };
    mainEl.innerHTML = `
      <div class="surface p-10 text-center">
        <h2 class="mt-5 text-2xl text-ink">Not ready yet</h2>
        <p class="mt-2 text-sm text-ink-soft">${messages[state.flashcard.status] || "This set isn't ready to study."}</p>
        <a href="#/" class="btn-base btn-primary mt-7">Back to sets</a>
      </div>
    `;
    return;
  }

  const deck = state.flashcard.cards;
  const card = deck[state.flashcard.index];
  const remaining = deck.length - state.flashcard.index;
  const done = state.flashcard.index >= deck.length || !card;

  let contentHtml = "";

  if (done || !card) {
    const busy = !!regenBusy[setId];
    const err = regenError[setId];
    contentHtml = `
      <div class="surface p-10 text-center">
        <div class="accent-rule" style="margin: 0 auto;"></div>
        <h2 class="mt-5 text-2xl text-ink">Session complete</h2>
        <p class="mt-2 text-sm text-ink-soft">
          ${
            state.flashcard.missed.length === 0
              ? "You cleared every card in this deck."
              : `${state.flashcard.missed.length} card${state.flashcard.missed.length > 1 ? "s" : ""} marked for another pass.`
          }
        </p>
        ${err ? `<p class="mt-3 font-mono text-xs text-magenta">${err}</p>` : ""}
        <button id="btn-regenerate-deck" class="btn-base btn-primary mt-7" ${busy ? "disabled" : ""}>
          ${busy ? "Writing new questions…" : "Regenerate deck"}
        </button>
      </div>
    `;
  } else {
    contentHtml = `
      <div>
        <div class="flip-scene">
          <button type="button" id="btn-flip" class="flip-button">
            <div class="flip-inner ${state.flashcard.flipped ? "flip-inner-flipped" : ""}">
              <div class="flip-face flip-face-front">
                <span class="font-mono text-xs uppercase tracking-wider text-ink-faint">Question</span>
                <div class="accent-rule mt-3"></div>
                <p class="mt-5 font-display text-xl text-ink">${card.question}</p>
                <span class="mt-auto pt-6 font-mono text-xs text-ink-faint">tap to reveal</span>
              </div>
              <div class="flip-face flip-face-back">
                <span class="font-mono text-xs uppercase tracking-wider text-magenta">Answer</span>
                <div class="accent-rule mt-3" style="background-image: linear-gradient(135deg, var(--magenta), var(--violet));"></div>
                <p class="mt-5 font-display text-xl text-ink">${card.answer}</p>
              </div>
            </div>
          </button>
        </div>

        <div class="mt-7 flex items-center justify-between">
          <span class="font-mono text-xs text-ink-soft">${remaining}/${deck.length} remaining</span>
          <div class="flex gap-3">
            <button id="btn-missed" class="btn-base btn-danger">Didn't know it</button>
            <button id="btn-knew" class="btn-base btn-success">Knew it</button>
          </div>
        </div>
      </div>
    `;
  }

  mainEl.innerHTML = `
    <p class="font-mono text-xs uppercase tracking-widest text-ink-faint">revision mode</p>
    <h1 class="mt-3 text-3xl text-ink">Revise</h1>
    <div class="mt-10">${contentHtml}</div>
  `;

  if (done || !card) {
    const btn = document.getElementById("btn-regenerate-deck");
    if (btn && !regenBusy[setId]) {
      btn.addEventListener("click", () => triggerRegenerate(setId, mainEl, "study", searchParams));
    }
  } else {
    document.getElementById("btn-flip").addEventListener("click", () => {
      state.flashcard.flipped = !state.flashcard.flipped;
      renderStudyView(mainEl, searchParams);
    });

    document.getElementById("btn-missed").addEventListener("click", () => {
      state.flashcard.missed.push(card.id);
      state.flashcard.flipped = false;
      state.flashcard.index += 1;
      renderStudyView(mainEl, searchParams);
    });

    document.getElementById("btn-knew").addEventListener("click", () => {
      state.flashcard.flipped = false;
      state.flashcard.index += 1;
      renderStudyView(mainEl, searchParams);
    });
  }
}

// Sets picker shown at #/quiz with no ?set= — mirrors renderRevisePicker
// but links into the quiz flow instead of the flip-card study flow.
async function renderQuizPicker(mainEl, opts = {}) {
  mainEl.className = "main-container";

  if (!opts.skipFetch) {
    mainEl.innerHTML = `
      <p class="font-mono text-xs uppercase tracking-widest text-ink-faint">quiz mode</p>
      <h1 class="mt-3 text-3xl text-ink">Quiz</h1>
      <p class="mt-8 font-mono text-xs text-ink-faint">Loading your sets…</p>
    `;
    try {
      const data = await apiFetch("/api/notesets");
      state.quizPicker.noteSets = data.noteSets || [];
      state.quizPicker.error = "";
    } catch (err) {
      if (err.status === 401) {
        handleSignOut();
        return;
      }
      state.quizPicker.error = err.message;
    }
    state.quizPicker.loading = false;
    renderQuizPicker(mainEl, { skipFetch: true });
    return;
  }

  const readySets = state.quizPicker.noteSets.filter((s) => s.status === "ready");

  mainEl.innerHTML = `
    <p class="font-mono text-xs uppercase tracking-widest text-ink-faint">quiz mode</p>
    <h1 class="mt-3 text-3xl text-ink">Quiz</h1>
    <p class="mt-2 text-sm text-ink-soft">Pick a set to test yourself with multiple-choice questions.</p>
    ${state.quizPicker.error ? `<p class="mt-4 font-mono text-xs text-magenta">${state.quizPicker.error}</p>` : ""}
    <div class="mt-8 grid-gap-4 sm:grid-cols-2">
      ${
        readySets.length
          ? readySets
              .map(
                (set) => `
              <a href="#/quiz?set=${set.id}" class="surface-interactive p-5">
                <div class="flex items-start justify-between gap-4">
                  <h3 class="text-xl text-ink">${set.title}</h3>
                  ${createStatusBadge(set.status)}
                </div>
                <p class="mt-2 font-mono text-xs text-ink-soft">${set.sourceType === "pdf" ? "PDF" : "Image"}</p>
                <p class="mt-6 font-mono text-xs text-ink-faint">${formatUpdatedAt(set.createdAt)}</p>
              </a>
            `
              )
              .join("")
          : `<p class="font-mono text-xs text-ink-faint">${
              state.quizPicker.noteSets.length
                ? "No sets are ready yet — check back once generation finishes."
                : "No note sets yet — go upload something first."
            }</p>`
      }
    </div>
    <p class="mt-8"><a href="#/" class="btn-base btn-ghost">Upload a new set</a></p>
  `;
}

// Builds the shuffled multiple-choice options for the question at
// state.quiz.order[index]: the correct answer plus up to 3 distractor
// answers pulled from the deck's other cards.
function buildQuizQuestion(index) {
  const deck = state.quiz.cards;
  const card = deck[state.quiz.order[index]];
  if (!card) return;

  const otherAnswers = deck
    .filter((c) => c.id !== card.id)
    .map((c) => c.answer)
    .filter((a, i, arr) => a && a !== card.answer && arr.indexOf(a) === i);

  const distractors = shuffleArray(otherAnswers).slice(0, 3);
  const options = shuffleArray([card.answer, ...distractors]);

  state.quiz.options = options;
  state.quiz.correctIndex = options.indexOf(card.answer);
  state.quiz.answered = false;
  state.quiz.selectedIndex = null;
}

async function renderQuizView(mainEl, searchParams) {
  mainEl.className = "main-container narrow";
  const setId = searchParams.get("set");

  if (!setId) {
    renderQuizPicker(mainEl);
    return;
  }

  if (state.quiz.status === "loading" || state.quiz._loadedFor !== setId) {
    mainEl.innerHTML = `<p class="font-mono text-xs text-ink-faint">Loading quiz…</p>`;
    try {
      const data = await apiFetch(`/api/notesets/${encodeURIComponent(setId)}/cards`);
      state.quiz.status = data.status;
      state.quiz.cards = data.cards || [];
      state.quiz.order = shuffleArray(state.quiz.cards.map((_, i) => i));
      state.quiz.index = 0;
      state.quiz.score = 0;
      state.quiz.finished = false;
      state.quiz._loadedFor = setId;
      state.quiz.setId = setId;
      if (state.quiz.status === "ready" && state.quiz.cards.length >= 2) {
        buildQuizQuestion(0);
      }
    } catch (err) {
      if (err.status === 401) {
        handleSignOut();
        return;
      }
      state.quiz.status = "error";
      state.quiz._loadedFor = setId;
      state.quiz._error = err.message;
    }
    renderQuizView(mainEl, searchParams);
    return;
  }

  if (state.quiz.status !== "ready") {
    const messages = {
      processing: "This set is still generating — check back in a moment.",
      failed: "Card generation failed for this set. Go back and retry it.",
      error: state.quiz._error || "Couldn't load this set.",
    };
    mainEl.innerHTML = `
      <div class="surface p-10 text-center">
        <h2 class="mt-5 text-2xl text-ink">Not ready yet</h2>
        <p class="mt-2 text-sm text-ink-soft">${messages[state.quiz.status] || "This set isn't ready to quiz."}</p>
        <a href="#/quiz" class="btn-base btn-primary mt-7">Back to quiz sets</a>
      </div>
    `;
    return;
  }

  const deck = state.quiz.cards;

  if (deck.length < 2) {
    mainEl.innerHTML = `
      <div class="surface p-10 text-center">
        <h2 class="mt-5 text-2xl text-ink">Not enough cards yet</h2>
        <p class="mt-2 text-sm text-ink-soft">A quiz needs at least 2 flashcards to build multiple-choice options — this set only has ${deck.length}.</p>
        <a href="#/quiz" class="btn-base btn-primary mt-7">Back to quiz sets</a>
      </div>
    `;
    return;
  }

  const total = deck.length;
  const card = deck[state.quiz.order[state.quiz.index]];

  let contentHtml = "";

  if (state.quiz.finished) {
    const pct = Math.round((state.quiz.score / total) * 100);
    const busy = !!regenBusy[setId];
    const err = regenError[setId];
    contentHtml = `
      <div class="surface p-10 text-center">
        <div class="accent-rule" style="margin: 0 auto;"></div>
        <h2 class="mt-5 text-2xl text-ink">Quiz complete</h2>
        <p class="mt-3 font-display text-3xl text-ink">${state.quiz.score}/${total}</p>
        <p class="mt-2 text-sm text-ink-soft">${pct}% correct</p>
        ${err ? `<p class="mt-3 font-mono text-xs text-magenta">${err}</p>` : ""}
        <div class="mt-7 flex items-center justify-center gap-3">
          <button id="btn-quiz-regenerate" class="btn-base btn-primary" ${busy ? "disabled" : ""}>
            ${busy ? "Writing new questions…" : "Regenerate"}
          </button>
          <a href="#/quiz" class="btn-base btn-ghost">Back to quiz sets</a>
        </div>
      </div>
    `;
  } else {
    contentHtml = `
      <div class="surface p-6">
        <div class="flex items-center justify-between font-mono text-xs text-ink-faint">
          <span>Question ${state.quiz.index + 1}/${total}</span>
          <span>Score ${state.quiz.score}</span>
        </div>
        <div class="accent-rule mt-4"></div>
        <p class="mt-5 font-display text-xl text-ink">${card.question}</p>

        <div class="mt-6 flex flex-col gap-3">
          ${state.quiz.options
            .map((opt, i) => {
              let cls = "quiz-option";
              if (state.quiz.answered) {
                if (i === state.quiz.correctIndex) cls += " quiz-option-correct";
                else if (i === state.quiz.selectedIndex) cls += " quiz-option-incorrect";
              }
              return `
                <button type="button" class="${cls}" data-option-index="${i}" ${state.quiz.answered ? "disabled" : ""}>
                  <span class="quiz-option-letter">${String.fromCharCode(65 + i)}</span>
                  <span>${opt}</span>
                </button>
              `;
            })
            .join("")}
        </div>

        ${
          state.quiz.answered && card.explanation
            ? `<p class="mt-5 text-sm text-ink-soft" style="line-height:1.6;"><span class="font-mono text-xs uppercase tracking-wide text-ink-faint">Why —</span> ${card.explanation}</p>`
            : ""
        }

        ${
          state.quiz.answered
            ? `<button id="btn-quiz-next" class="btn-base btn-primary mt-6">${
                state.quiz.index + 1 >= total ? "See results" : "Next question →"
              }</button>`
            : ""
        }
      </div>
    `;
  }

  mainEl.innerHTML = `
    <p class="font-mono text-xs uppercase tracking-widest text-ink-faint">quiz mode</p>
    <h1 class="mt-3 text-3xl text-ink">Quiz</h1>
    <div class="mt-10">${contentHtml}</div>
  `;

  if (state.quiz.finished) {
    const btn = document.getElementById("btn-quiz-regenerate");
    if (btn && !regenBusy[setId]) {
      btn.addEventListener("click", () => triggerRegenerate(setId, mainEl, "quiz", searchParams));
    }
    return;
  }

  if (!state.quiz.answered) {
    mainEl.querySelectorAll("[data-option-index]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const i = Number(btn.getAttribute("data-option-index"));
        state.quiz.selectedIndex = i;
        state.quiz.answered = true;
        if (i === state.quiz.correctIndex) state.quiz.score += 1;
        renderQuizView(mainEl, searchParams);
      });
    });
  } else {
    document.getElementById("btn-quiz-next").addEventListener("click", () => {
      const nextIndex = state.quiz.index + 1;
      if (nextIndex >= total) {
        state.quiz.finished = true;
      } else {
        state.quiz.index = nextIndex;
        buildQuizQuestion(nextIndex);
      }
      renderQuizView(mainEl, searchParams);
    });
  }
}

function renderSignInView(mainEl) {
  mainEl.className = "main-container small";

  if (isAuthed()) {
    const user = state.auth.user;
    mainEl.innerHTML = `
      <p class="font-mono text-xs uppercase tracking-widest text-ink-faint">Account</p>
      <h1 class="text-gradient mt-3 text-4xl" style="line-height: 1.1;">You're signed in.</h1>
      <section class="surface mt-10 p-6">
        <p class="text-sm text-ink-soft">Signed in as <span class="text-ink">${user ? user.email : ""}</span></p>
        <button type="button" id="btn-signout" class="btn-base btn-ghost mt-6">Sign out</button>
      </section>
      <p class="mt-8 font-mono text-xs text-ink-faint">
        <a href="#/" class="text-violet-bright" style="text-decoration: none;">← Back to sets</a>
      </p>
    `;
    document.getElementById("btn-signout").addEventListener("click", handleSignOut);
    return;
  }

  const isRegister = state.signin.mode === "register";

  mainEl.innerHTML = `
    <p class="font-mono text-xs uppercase tracking-widest text-ink-faint">Account</p>
    <h1 class="text-gradient mt-3 text-4xl" style="line-height: 1.1;">
      ${isRegister ? "Start your night shift." : "Welcome back."}
    </h1>
    <p class="mt-4 text-sm text-ink-soft" style="line-height: 1.6;">
      ${
        isRegister
          ? "Create an account to save decks, streaks and revision history."
          : "Sign in to keep your decks and streaks in sync across devices."
      }
    </p>

    <section class="surface mt-10 p-6">
      <div class="accent-rule"></div>

      <div class="mt-6 grid-cols-2 gap-1 surface p-1" style="border-radius: 12px;" role="tablist">
        <button type="button" id="tab-signin" class="btn-base text-xs font-mono uppercase tracking-wide ${
          !isRegister ? "text-violet-bright" : "text-ink-soft"
        }" style="background: ${!isRegister ? "rgba(167, 139, 250, 0.15)" : "transparent"}; width:100%;">
          Sign in
        </button>
        <button type="button" id="tab-register" class="btn-base text-xs font-mono uppercase tracking-wide ${
          isRegister ? "text-violet-bright" : "text-ink-soft"
        }" style="background: ${isRegister ? "rgba(167, 139, 250, 0.15)" : "transparent"}; width:100%;">
          Register
        </button>
      </div>

      <form id="auth-form" class="mt-6 flex flex-col gap-4">
        ${
          isRegister
            ? `
        <label class="flex flex-col gap-2">
          <span class="font-mono text-xs uppercase tracking-wide text-ink-soft">Name</span>
          <input type="text" id="auth-name" class="field" placeholder="Ada Lovelace" value="${state.signin.name}" />
        </label>`
            : ""
        }
        <label class="flex flex-col gap-2">
          <span class="font-mono text-xs uppercase tracking-wide text-ink-soft">Email</span>
          <input type="email" id="auth-email" class="field" placeholder="you@night.study" value="${state.signin.email}" />
        </label>
        <label class="flex flex-col gap-2">
          <span class="font-mono text-xs uppercase tracking-wide text-ink-soft">Password</span>
          <input type="password" id="auth-password" class="field" placeholder="••••••••" value="${state.signin.password}" />
        </label>
        ${state.signin.error ? `<p class="font-mono text-xs text-magenta">${state.signin.error}</p>` : ""}
        <button type="submit" id="btn-submit" class="btn-base btn-primary mt-2" ${
          !canSubmitAuth() ? "disabled" : ""
        }>
          ${state.signin.submitting ? "Please wait…" : isRegister ? "Create account" : "Sign in"}
        </button>
      </form>

      <p class="mt-6 font-mono text-xs text-ink-faint">
        ${isRegister ? "Already have an account? Switch to sign in above." : "No account yet? Choose Register above."}
      </p>
    </section>

    <p class="mt-8 font-mono text-xs text-ink-faint">
      <a href="#/" class="text-violet-bright" style="text-decoration: none;">← Back to sets</a>
    </p>
  `;

  document.getElementById("tab-signin").addEventListener("click", () => {
    state.signin.mode = "signin";
    state.signin.error = "";
    renderSignInView(mainEl);
  });

  document.getElementById("tab-register").addEventListener("click", () => {
    state.signin.mode = "register";
    state.signin.error = "";
    renderSignInView(mainEl);
  });

  const nameInput = document.getElementById("auth-name");
  const emailInput = document.getElementById("auth-email");
  const passInput = document.getElementById("auth-password");
  const submitBtn = document.getElementById("btn-submit");

  if (nameInput) {
    nameInput.addEventListener("input", (e) => {
      state.signin.name = e.target.value;
      submitBtn.disabled = !canSubmitAuth();
    });
  }

  emailInput.addEventListener("input", (e) => {
    state.signin.email = e.target.value;
    submitBtn.disabled = !canSubmitAuth();
  });

  passInput.addEventListener("input", (e) => {
    state.signin.password = e.target.value;
    submitBtn.disabled = !canSubmitAuth();
  });

  document.getElementById("auth-form").addEventListener("submit", (e) => {
    e.preventDefault();
    handleAuthSubmit(mainEl);
  });
}

function canSubmitAuth() {
  if (state.signin.submitting) return false;
  if (!state.signin.email || !state.signin.password) return false;
  if (state.signin.mode === "register" && !state.signin.name) return false;
  return true;
}

async function handleAuthSubmit(mainEl) {
  if (!canSubmitAuth()) return;
  const isRegister = state.signin.mode === "register";

  state.signin.submitting = true;
  state.signin.error = "";
  renderSignInView(mainEl);

  try {
    const payload = isRegister
      ? { name: state.signin.name, email: state.signin.email, password: state.signin.password }
      : { email: state.signin.email, password: state.signin.password };

    const data = await apiFetch(`/api/auth/${isRegister ? "register" : "login"}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    setSession(data.token, data.user);
    state.auth.token = data.token;
    state.auth.user = data.user;
    state.signin = { mode: "signin", name: "", email: "", password: "", error: "", submitting: false };
    state.home.loading = true;

    window.location.hash = "#/";
  } catch (err) {
    state.signin.submitting = false;
    state.signin.error = err.message;
    renderSignInView(mainEl);
  }
}

function handleSignOut() {
  clearSession();
  state.auth = { token: null, user: null };
  state.home = { title: "", pdfFile: null, images: [], retryingIds: new Set(), noteSets: [], loading: true, error: "", submitting: false };
  state.flashcard = { index: 0, flipped: false, missed: [], cards: [], status: "loading" };
  state.quizPicker = { noteSets: [], loading: true, error: "" };
  state.quiz = {
    setId: null,
    _loadedFor: null,
    status: "loading",
    cards: [],
    order: [],
    index: 0,
    score: 0,
    options: [],
    correctIndex: null,
    selectedIndex: null,
    answered: false,
    finished: false,
  };
  stopPolling();
  Object.keys(regenBusy).forEach((k) => delete regenBusy[k]);
  Object.keys(regenError).forEach((k) => delete regenError[k]);
  window.location.hash = "#/signin";
  router();
}

// Global action handles
window.handleRetry = function (id) {
  state.home.retryingIds.add(id);
  const mainEl = document.getElementById("app");
  renderHomeView(mainEl, { skipFetch: true });

  apiFetch(`/api/notesets/${encodeURIComponent(id)}/retry`, { method: "POST" })
    .then(() => {
      loadNoteSets(mainEl);
    })
    .catch((err) => {
      state.home.retryingIds.delete(id);
      if (err.status === 401) {
        handleSignOut();
        return;
      }
      state.home.error = err.message;
      renderHomeView(mainEl, { skipFetch: true });
    });
};


// --- 5. Hash Router & Navigation ---
function router() {
  const hash = window.location.hash || "#/";
  const mainEl = document.getElementById("app");
  const [path, queryString] = hash.split("?");
  const searchParams = new URLSearchParams(queryString || "");

  // Home and study require auth; sign-in doesn't.
  if (path !== "#/signin" && !isAuthed()) {
    window.location.hash = "#/signin";
    return;
  }

  // Update navbar active state
  document.querySelectorAll(".nav-item").forEach((el) => el.classList.remove("active"));

  if (path === "#/" || path === "") {
    document.getElementById("nav-sets").classList.add("active");
    state.home.loading = true;
    renderHomeView(mainEl);
  } else if (path === "#/study") {
    document.getElementById("nav-study").classList.add("active");
    stopPolling();
    renderStudyView(mainEl, searchParams);
  } else if (path === "#/quiz") {
    document.getElementById("nav-quiz").classList.add("active");
    stopPolling();
    renderQuizView(mainEl, searchParams);
  } else if (path === "#/signin") {
    document.getElementById("nav-signin").classList.add("active");
    stopPolling();
    renderSignInView(mainEl);
  } else {
    mainEl.innerHTML = `
      <div class="text-center p-10">
        <h1 class="text-5xl text-ink">404</h1>
        <p class="mt-4 text-ink-soft">Page not found</p>
        <a href="#/" class="btn-base btn-primary mt-6">Go home</a>
      </div>
    `;
  }
}

window.addEventListener("hashchange", router);
window.addEventListener("DOMContentLoaded", router);