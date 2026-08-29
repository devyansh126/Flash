// models/User.js
// All direct DB access for the User table lives here. Controllers should
// never write raw SQL themselves — they call these functions instead.

const { v4: uuidv4 } = require('uuid');
const db = require('../config/db');

function createUser({ name, email, passwordHash }) {
  const id = uuidv4();
  db.prepare(
    `INSERT INTO users (id, name, email, passwordHash) VALUES (?, ?, ?, ?)`
  ).run(id, name, email, passwordHash);
  return { id, name, email };
}

function findByEmail(email) {
  return db.prepare(`SELECT * FROM users WHERE email = ?`).get(email);
}

function findById(id) {
  return db.prepare(`SELECT * FROM users WHERE id = ?`).get(id);
}

module.exports = { createUser, findByEmail, findById };
