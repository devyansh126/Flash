// config/db.js
// Sets up the SQLite database connection and creates tables if they don't
// exist yet. Swapping to MongoDB later would mean rewriting this file plus
// the /models files — nothing else in the app touches the DB directly.
//
// Uses Node's built-in `node:sqlite` (available Node 22.5+, no flag needed
// on Node 23.4+/24+) instead of the `better-sqlite3` npm package — this
// avoids the native-compile step that requires Visual Studio Build Tools
// on Windows. It'll print an "experimental feature" warning on startup;
// that's expected and harmless.

const { DatabaseSync } = require('node:sqlite');
const path = require('path');
require('dotenv').config();

const dbPath = process.env.DATABASE_URL || path.join(__dirname, '..', 'data.sqlite');
const db = new DatabaseSync(dbPath);

db.exec('PRAGMA journal_mode = WAL;');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    passwordHash TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS note_sets (
    id TEXT PRIMARY KEY,
    userId TEXT NOT NULL,
    title TEXT NOT NULL,
    sourceType TEXT NOT NULL CHECK (sourceType IN ('pdf', 'image')),
    status TEXT NOT NULL CHECK (status IN ('processing', 'ready', 'failed')),
    createdAt TEXT NOT NULL,
    filePath TEXT,
    FOREIGN KEY (userId) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS flashcards (
    id TEXT PRIMARY KEY,
    noteSetId TEXT NOT NULL,
    question TEXT NOT NULL,
    answer TEXT NOT NULL,
    explanation TEXT,
    FOREIGN KEY (noteSetId) REFERENCES note_sets(id)
  );
`);

module.exports = db;
