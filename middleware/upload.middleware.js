// middleware/upload.middleware.js
// Multer config for handling the multipart file upload on POST /api/notesets.
// Stores files locally in /uploads with a unique filename.

const multer = require('multer');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, path.join(__dirname, '..', 'uploads'));
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB cap per file
  fileFilter: (req, file, cb) => {
    const allowed = ['application/pdf', 'image/png', 'image/jpeg'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Unsupported file type. Only PDF, PNG, and JPEG are allowed.'));
    }
  },
});

// A note set is either: one PDF (field "file"), or up to 10 images
// (field "images"). Using .fields() instead of .single() lets the
// multi-image case actually reach the server instead of being dropped
// down to a single file client-side.
const uploadNoteSetFiles = upload.fields([
  { name: 'file', maxCount: 1 },
  { name: 'images', maxCount: 10 },
]);

module.exports = uploadNoteSetFiles;
