// server.js
// Entry point: sets up Express, mounts middleware/routes, serves the
// frontend, and starts listening. Business logic lives in
// controllers/services, not here.

require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');

const authRoutes = require('./routes/auth.routes');
const noteSetsRoutes = require('./routes/notesets.routes');
const { errorHandler } = require('./middleware/error.middleware');

const app = express();
const PORT = process.env.PORT || 5000;

// Frontend and API are served from the same origin (this server), so no
// cross-origin requests happen in normal use. CORS is still enabled and
// configurable via ALLOWED_ORIGIN for cases like running the frontend
// through a separate dev server (e.g. `live-server` on another port).
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || true }));
app.use(express.json());

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.use('/api/auth', authRoutes);
app.use('/api/notesets', noteSetsRoutes);

// Static frontend (public/index.html, style.css, app.js)
app.use(express.static(path.join(__dirname, 'public')));

// Any non-API route falls back to index.html so the hash-based router
// in app.js can handle it client-side.
app.get(/^(?!\/api\/).*/, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use(errorHandler);

app.listen(PORT, () => {
  console.log(`Flash running on http://localhost:${PORT}`);
});
