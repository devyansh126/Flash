// models/Flashcard.js

const { v4: uuidv4 } = require('uuid');
const db = require('../config/db');

function createMany(noteSetId, cards) {
  const insert = db.prepare(
    `INSERT INTO flashcards (id, noteSetId, question, answer, explanation)
     VALUES (?, ?, ?, ?, ?)`
  );
  db.exec('BEGIN');
  try {
    for (const card of cards) {
      insert.run(uuidv4(), noteSetId, card.question, card.answer, card.explanation || '');
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function getByNoteSetId(noteSetId) {
  return db
    .prepare(
      `SELECT id, question, answer, explanation FROM flashcards WHERE noteSetId = ?`
    )
    .all(noteSetId);
}

function deleteByNoteSetId(noteSetId) {
  db.prepare(`DELETE FROM flashcards WHERE noteSetId = ?`).run(noteSetId);
}

module.exports = { createMany, getByNoteSetId, deleteByNoteSetId };
