// routes/notesets.routes.js

const express = require('express');
const { requireAuth } = require('../middleware/auth.middleware');
const upload = require('../middleware/upload.middleware');
const {
  uploadNoteSet,
  listNoteSets,
  getCards,
  retryNoteSet,
  regenerateNoteSet,
} = require('../controllers/notesets.controller');

const router = express.Router();

router.post('/', requireAuth, upload, uploadNoteSet);
router.get('/', requireAuth, listNoteSets);
router.get('/:id/cards', requireAuth, getCards);
router.post('/:id/retry', requireAuth, retryNoteSet);
router.post('/:id/regenerate', requireAuth, regenerateNoteSet);

module.exports = router;
