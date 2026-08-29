// services/generateFlashcards.js
//
// Calls the Google Gemini API (free tier via Google AI Studio) to turn
// extracted note text — or, for images, the image(s) themselves — into
// flashcards. Everything upstream just calls
// generateFlashcards(text, images) and expects an array of
// { question, answer, explanation } objects back.
//
// Get a free key at https://aistudio.google.com/apikey (no credit card
// required) and put it in .env as LLM_API_KEY.

const fs = require('fs');

const GEMINI_MODEL = 'gemini-3.6-flash';
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

function buildPrompt(sourceDescription, avoidQuestions) {
  const avoidBlock =
    avoidQuestions && avoidQuestions.length
      ? `

This is a regeneration request. The learner already has a deck with these exact questions — do NOT reuse them, and do NOT just reword them. Write a completely fresh set of questions: cover different facts, different angles, or different granularity from the notes so the new deck feels genuinely new to study from.
Existing questions to avoid repeating or lightly rephrasing:
${avoidQuestions.map((q) => `- ${q}`).join('\n')}`
      : '';

  return `You are an expert study coach. Read the notes below and produce a set of flashcards that test the most important facts and concepts — the kind a student would actually be quizzed on.

Rules:
- Return ONLY a JSON array, nothing else — no markdown fences, no prose before or after.
- Each element must be an object with exactly these keys: "question", "answer", "explanation".
- "explanation" is a short (1-2 sentence) elaboration on the answer, not a repeat of it.
- Produce exactly 10 flashcards, no more and no fewer. If the notes are thin, still reach 10 by testing the material from different angles (definitions, examples, comparisons, cause/effect) rather than padding with filler; if the notes are rich, pick the 10 most important things to test instead of trying to cover everything.
- Skip trivial or filler content; focus on what's actually worth remembering.${avoidBlock}

Notes:
"""
${sourceDescription}
"""`;
}

function extractJsonArray(rawText) {
  // Strip ```json ... ``` fences if the model wrapped the array in one
  // despite being told not to.
  let cleaned = rawText.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();

  // If there's leading/trailing prose around the array, grab just the
  // outermost [ ... ] block.
  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start !== -1 && end !== -1 && end > start) {
    cleaned = cleaned.slice(start, end + 1);
  }
  return cleaned;
}

function parseFlashcardsFromResponse(data) {
  const candidate = data.candidates && data.candidates[0];
  const parts = candidate && candidate.content && candidate.content.parts;
  const rawText = (parts || []).map((p) => p.text || '').join('').trim();

  if (!rawText) {
    // Gemini returns candidates[0].finishReason (e.g. "SAFETY", "MAX_TOKENS")
    // when it declines or truncates instead of erroring outright.
    const reason = candidate && candidate.finishReason;
    throw new Error(`Gemini response contained no text content${reason ? ` (finishReason: ${reason})` : ''}`);
  }

  const jsonText = extractJsonArray(rawText);
  let cards;
  try {
    cards = JSON.parse(jsonText);
  } catch (err) {
    throw new Error(`Could not parse flashcards JSON from Gemini response: ${err.message}`);
  }

  if (!Array.isArray(cards)) {
    throw new Error('Expected the Gemini response to be a JSON array of flashcards');
  }

  const clean = cards
    .map((c) => ({
      question: String(c.question || '').trim(),
      answer: String(c.answer || '').trim(),
      explanation: c.explanation ? String(c.explanation).trim() : '',
    }))
    .filter((c) => c.question && c.answer);

  if (clean.length === 0) {
    throw new Error('Gemini returned no usable flashcards');
  }
  return clean;
}

async function callGemini(parts, temperature) {
  if (!process.env.LLM_API_KEY) {
    throw new Error('LLM_API_KEY is not set — add a free Gemini key to .env before generating real flashcards');
  }

  const body = { contents: [{ role: 'user', parts }] };
  if (typeof temperature === 'number') {
    body.generationConfig = { temperature };
  }

  const response = await fetch(GEMINI_API_URL, {
    method: 'POST',
    headers: {
      'x-goog-api-key': process.env.LLM_API_KEY,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    throw new Error(`Gemini API error ${response.status}: ${errBody}`);
  }

  return response.json();
}

// text: extracted text (PDFs), or null (images — textExtraction.js
//   intentionally skips OCR and hands the file(s) forward instead).
// images: only needed for the image case — an array of { path, mimetype }
//   objects (or a single such object), so each image can be sent straight
//   to the model instead of text. A note set may be built from up to 10
//   album images (e.g. photographed pages of the same notebook), and all
//   of them are sent together in one request so the model sees the full
//   set, not just the first page.
// options.avoidQuestions: when set (regeneration), the model is told to
//   produce a fresh deck that doesn't repeat these existing questions, and
//   a higher temperature is used so the new deck actually differs instead
//   of landing back on the same wording.
async function generateFlashcards(text, images, options = {}) {
  const avoidQuestions = options.avoidQuestions || [];
  let parts;

  if (text) {
    parts = [{ text: buildPrompt(text, avoidQuestions) }];
  } else if (images) {
    const list = Array.isArray(images) ? images : [images];
    if (list.length === 0) {
      throw new Error('generateFlashcards needs at least one image');
    }
    const imageParts = list.map(({ path, mimetype }) => ({
      inline_data: { mime_type: mimetype, data: fs.readFileSync(path).toString('base64') },
    }));
    const sourceDescription =
      list.length > 1
        ? `(see the ${list.length} attached images of notes, in order — they are pages of the same set of notes)`
        : '(see the attached image of notes)';
    parts = [...imageParts, { text: buildPrompt(sourceDescription, avoidQuestions) }];
  } else {
    throw new Error('generateFlashcards needs either extracted text or at least one image');
  }

  const temperature = avoidQuestions.length ? 1.15 : undefined;
  const data = await callGemini(parts, temperature);
  return parseFlashcardsFromResponse(data);
}

module.exports = { generateFlashcards };