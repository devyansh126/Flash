// controllers/auth.controller.js

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/User');

function signToken(userId) {
  return jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: '7d' });
}

async function register(req, res, next) {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'name, email, and password are required' });
    }

    const existing = User.findByEmail(email);
    if (existing) {
      return res.status(409).json({ error: 'An account with this email already exists' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const user = User.createUser({ name, email, passwordHash });
    const token = signToken(user.id);

    res.status(201).json({ token, user: { id: user.id, name: user.name, email: user.email } });
  } catch (err) {
    next(err);
  }
}

async function login(req, res, next) {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'email and password are required' });
    }

    const user = User.findByEmail(email);
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const passwordMatches = await bcrypt.compare(password, user.passwordHash);
    if (!passwordMatches) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const token = signToken(user.id);
    res.json({ token, user: { id: user.id, name: user.name, email: user.email } });
  } catch (err) {
    next(err);
  }
}

module.exports = { register, login };
