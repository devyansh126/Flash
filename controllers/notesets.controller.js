// controllers/notesets.controller.js

const path = require('path');
const NoteSet = require('../models/NoteSet');
const Flashcard = require('../models/Flashcard');
const { extractText, sourceTypeFromMimetype } = require('../services/textExtraction');
const { generateFlashcards } = require('../services/generateFlashcards');

// note_sets only stores the coarse sourceType ('pdf' | 'image'), not the
// exact mimetype multer saw at upload time, so retry has to re-derive one
// from the stored file's extension in order to call extractText/
// sourceTypeFromMimetype again.
const MIME_BY_EXT = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};

function guessMimetype(filePath) {
  return MIME_BY_EXT[path.extname(filePath).toLowerCase()];
}

// PDFs store a single path string in note_sets.filePath (unchanged, for
// backwards compatibility with existing rows). Image sets can have up to
// 10 files, so they're stored as a JSON array string in the same column.
function encodeFilePath(sourceType, files) {
  if (sourceType === 'pdf') return files[0].path;
  return JSON.stringify(files.map((f) => f.path));
}

function decodeFilePaths(sourceType, storedFilePath) {
  if (sourceType === 'pdf') return [storedFilePath];
  try {
    const parsed = JSON.parse(storedFilePath);
    return Array.isArray(parsed) ? parsed : [storedFilePath];
  } catch {
    // Old rows created before multi-image support stored a bare path.
    return [storedFilePath];
  }
}

// Runs extractText + generateFlashcards for a note set, given its
// sourceType and the on-disk file path(s) (with mimetypes when available
// straight from multer, or re-derived by extension on retry).
// options.avoidQuestions is forwarded to generateFlashcards so a
// regeneration pass asks the model for a genuinely different deck instead
// of reproducing the same cards.
async function runPipeline(sourceType, filesWithMime, options = {}) {
  if (sourceType === 'pdf') {
    const { path: filePath, mimetype } = filesWithMime[0];
    const text = await extractText(filePath, mimetype);
    return generateFlashcards(text, null, options);
  }

  // image sourceType: send every image straight to the model.
  const images = filesWithMime.map(({ path: p, mimetype }) => ({ path: p, mimetype }));
  return generateFlashcards(null, images, options);
}

// POST /api/notesets
// Runs the whole pipeline synchronously: save "processing" NoteSet ->
// extract text -> generate flashcards -> save cards -> flip status to
// "ready" (or "failed" if anything throws). No background queue —
// hackathon simplicity over correctness, per the spec.
async function uploadNoteSet(req, res, next) {
  let noteSet;
  try {
    const { title } = req.body;
    // upload.fields() puts files under req.files.file (the PDF) and/or
    // req.files.images (up to 10 album images) instead of the single
    // req.file multer gave us before.
    const pdfFile = req.files && req.files.file && req.files.file[0];
    const imageFiles = (req.files && req.files.images) || [];
    const files = pdfFile ? [pdfFile] : imageFiles;

    if (!title || files.length === 0) {
      return res.status(400).json({ error: 'title and at least one file are required' });
    }

    const sourceType = sourceTypeFromMimetype(files[0].mimetype);

    noteSet = NoteSet.createNoteSet({
      userId: req.userId,
      title,
      sourceType,
      filePath: encodeFilePath(sourceType, files),
    });

    // Respond immediately with "processing" so the client can move on,
    // then keep working in the background before we resolve fully.
    res.status(202).json({ noteSetId: noteSet.id, status: 'processing' });

    const filesWithMime = files.map((f) => ({ path: f.path, mimetype: f.mimetype }));
    const cards = await runPipeline(sourceType, filesWithMime);

    Flashcard.createMany(noteSet.id, cards);
    NoteSet.updateStatus(noteSet.id, 'ready');
  } catch (err) {
    console.error('Failed to process note set:', err);
    if (noteSet) {
      NoteSet.updateStatus(noteSet.id, 'failed');
    }
    // Response was already sent above, so just log — nothing more to do here.
  }
}

// GET /api/notesets
function listNoteSets(req, res, next) {
  try {
    const noteSets = NoteSet.getByUser(req.userId);
    res.json({ noteSets });
  } catch (err) {
    next(err);
  }
}

// GET /api/notesets/:id/cards
function getCards(req, res, next) {
  try {
    const noteSet = NoteSet.getById(req.params.id);

    if (!noteSet || noteSet.userId !== req.userId) {
      return res.status(404).json({ error: 'Note set not found' });
    }

    const cards = noteSet.status === 'ready' ? Flashcard.getByNoteSetId(noteSet.id) : [];
    res.json({ status: noteSet.status, cards });
  } catch (err) {
    next(err);
  }
}

// POST /api/notesets/:id/retry
// Re-runs the same extract -> generate pipeline against the file that's
// already on disk from the original upload. Same "respond early, keep
// working" shape as uploadNoteSet.
async function retryNoteSet(req, res, next) {
  try {
    const noteSet = NoteSet.getById(req.params.id);

    if (!noteSet || noteSet.userId !== req.userId) {
      return res.status(404).json({ error: 'Note set not found' });
    }

    if (!noteSet.filePath) {
      return res.status(400).json({ error: 'No source file on record for this note set' });
    }

    const paths = decodeFilePaths(noteSet.sourceType, noteSet.filePath);
    const filesWithMime = paths.map((p) => ({ path: p, mimetype: guessMimetype(p) }));
    if (filesWithMime.some((f) => !f.mimetype)) {
      return res.status(400).json({ error: 'Could not determine file type for retry' });
    }

    NoteSet.updateStatus(noteSet.id, 'processing');
    res.status(202).json({ noteSetId: noteSet.id, status: 'processing' });

    const cards = await runPipeline(noteSet.sourceType, filesWithMime);

    Flashcard.deleteByNoteSetId(noteSet.id);
    Flashcard.createMany(noteSet.id, cards);
    NoteSet.updateStatus(noteSet.id, 'ready');
  } catch (err) {
    console.error('Failed to retry note set:', err);
    if (req.params.id) {
      NoteSet.updateStatus(req.params.id, 'failed');
    }
    // Response was already sent above, so just log.
  }
}

// POST /api/notesets/:id/regenerate
// Like retry, but for sets that already generated successfully and the
// user just wants a fresh deck. Re-runs the same extract -> generate
// pipeline against the file already on disk, telling the model to avoid
// the questions currently in the deck so the new cards are genuinely
// different rather than a reshuffle of the same ones. New cards only
// replace the old ones after generation succeeds, so a failed regenerate
// leaves the existing deck untouched.
async function regenerateNoteSet(req, res, next) {
  try {
    const noteSet = NoteSet.getById(req.params.id);

    if (!noteSet || noteSet.userId !== req.userId) {
      return res.status(404).json({ error: 'Note set not found' });
    }

    if (!noteSet.filePath) {
      return res.status(400).json({ error: 'No source file on record for this note set' });
    }

    const paths = decodeFilePaths(noteSet.sourceType, noteSet.filePath);
    const filesWithMime = paths.map((p) => ({ path: p, mimetype: guessMimetype(p) }));
    if (filesWithMime.some((f) => !f.mimetype)) {
      return res.status(400).json({ error: 'Could not determine file type for regeneration' });
    }

    const existingCards = Flashcard.getByNoteSetId(noteSet.id);
    const avoidQuestions = existingCards.map((c) => c.question).filter(Boolean);

    NoteSet.updateStatus(noteSet.id, 'processing');
    res.status(202).json({ noteSetId: noteSet.id, status: 'processing' });

    const cards = await runPipeline(noteSet.sourceType, filesWithMime, { avoidQuestions });

    Flashcard.deleteByNoteSetId(noteSet.id);
    Flashcard.createMany(noteSet.id, cards);
    NoteSet.updateStatus(noteSet.id, 'ready');
  } catch (err) {
    console.error('Failed to regenerate note set:', err);
    if (req.params.id) {
      NoteSet.updateStatus(req.params.id, 'failed');
    }
    // Response was already sent above, so just log.
  }
}

module.exports = { uploadNoteSet, listNoteSets, getCards, retryNoteSet, regenerateNoteSet };
