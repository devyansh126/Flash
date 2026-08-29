// middleware/error.middleware.js
// Catch-all error handler. Any controller that calls next(err) or throws
// inside an async wrapper ends up here instead of crashing the process.

function errorHandler(err, req, res, next) {
  console.error(err);
  const status = err.status || 500;
  res.status(status).json({ error: err.message || 'Internal server error' });
}

module.exports = { errorHandler };
