// services/textExtraction.js
// Given an uploaded file (or files), returns raw text to feed into
// generateFlashcards.
// - PDFs: extracted with pdf-parse (all pages — pdf-parse has no page cap
//   unless you pass `options.max`, and we don't).
// - Images: text extraction is skipped here on purpose. This returns null
//   and generateFlashcards() is expected to handle that case (e.g. by
//   calling a vision model on the file path(s) directly instead of on
//   text).

const fs = require('fs');
const pdfParse = require('pdf-parse');

// filePath: a single path (PDF) or an array of paths (images — a note set
// can be built from up to 10 album images, all belonging to one set).
async function extractText(filePath, mimetype) {
  if (mimetype === 'application/pdf') {
    // Only ever a single path for PDFs.
    const singlePath = Array.isArray(filePath) ? filePath[0] : filePath;
    const buffer = fs.readFileSync(singlePath);
    // pdf-parse's bundled (old) pdf.js chokes on Node's Buffer subclass in
    // recent Node versions — wrapping as a plain Uint8Array avoids it.
    const data = await pdfParse(new Uint8Array(buffer));

    // Scanned/image-only PDFs have no embedded text layer, so pdf-parse
    // comes back with little or nothing per page even though numpages is
    // correct. Surface that clearly instead of silently generating cards
    // from a handful of stray characters.
    const charsPerPage = data.text.trim().length / Math.max(data.numpages, 1);
    if (charsPerPage < 20) {
      throw new Error(
        `This PDF appears to be scanned/image-based — only ${data.text.trim().length} characters of text were found across ${data.numpages} page(s). Text extraction can't OCR scanned pages; try uploading it as images instead.`
      );
    }

    return data.text;
  }

  if (mimetype.startsWith('image/')) {
    // No OCR/vision call here — just hand the file path(s) forward.
    return null;
  }

  throw new Error(`Unsupported mimetype for text extraction: ${mimetype}`);
}

function sourceTypeFromMimetype(mimetype) {
  if (mimetype === 'application/pdf') return 'pdf';
  if (mimetype.startsWith('image/')) return 'image';
  throw new Error(`Unsupported mimetype: ${mimetype}`);
}

module.exports = { extractText, sourceTypeFromMimetype };
