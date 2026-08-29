// models/NoteSet.js

const { v4: uuidv4 } = require('uuid');
const db = require('../config/db');

function createNoteSet({ userId, title, sourceType, filePath }) {
  const id = uuidv4();
  const createdAt = new Date().toISOString();
  db.prepare(
    `INSERT INTO note_sets (id, userId, title, sourceType, status, createdAt, filePath)
     VALUES (?, ?, ?, ?, 'processing', ?, ?)`
  ).run(id, userId, title, sourceType, createdAt, filePath);
  return { id, userId, title, sourceType, status: 'processing', createdAt };
}

function updateStatus(id, status) {
  db.prepare(`UPDATE note_sets SET status = ? WHERE id = ?`).run(status, id);
}

function getByUser(userId) {
  return db
    .prepare(
      `SELECT id, title, sourceType, status, createdAt
       FROM note_sets WHERE userId = ? ORDER BY createdAt DESC`
    )
    .all(userId);
}

function getById(id) {
  return db.prepare(`SELECT * FROM note_sets WHERE id = ?`).get(id);
}

module.exports = { createNoteSet, updateStatus, getByUser, getById };
