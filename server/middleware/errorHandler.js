'use strict';
/* ---------------------------------------------------------------------------
   Central error handling (req 8).

   Two jobs:

   1. Turn a thrown error into a clean JSON response, so a client always gets
      { error, code } and never an HTML stack trace.

   2. Keep internal detail on the server. An unexpected error returns a
      generic message to the caller and puts the stack in the log. Postgres
      error text can name tables, columns and constraints, which is exactly
      the map of the database an attacker would like to have.
   --------------------------------------------------------------------------- */

var config = require('../config/env');

/* Wraps an async route handler so a rejected promise reaches this handler
   instead of hanging the request. Express 4 does not do this by itself. */
function asyncHandler(fn) {
  return function (req, res, next) {
    Promise.resolve()
      .then(function () { return fn(req, res, next); })
      .catch(next);
  };
}

function notFound(req, res) {
  res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' });
}

/* Postgres error codes worth translating into something a user can act on. */
function translatePgError(err) {
  switch (err.code) {
    case '23505':
    case '23:505':
      return null;
    case '23503':  // foreign key violation
      return { status: 400, message: 'That record is still referenced by something else', code: 'IN_USE' };
    case '23514':  // check constraint
      return { status: 400, message: 'One of the values is not allowed', code: 'VALIDATION_ERROR' };
    case '23502':  // not null violation
      return { status: 400, message: 'A required field was missing', code: 'VALIDATION_ERROR' };
    default:
      return null;
  }
}

function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);

  /* A unique-violation on uid is common and user-facing: the admin picked a
     login ID someone already has. */
  if (err.code === '23505' && /app_users_uid_key|app_users_pkey/.test(err.constraint || '')) {
    return res.status(409).json({
      error: 'That login ID is already taken — choose another.',
      code: 'UID_TAKEN'
    });
  }

  var pg = translatePgError(err);
  if (pg) {
    console.warn('[error] ' + req.method + ' ' + req.originalUrl + ' — pg ' + err.code + ': ' + err.message);
    return res.status(pg.status).json({ error: pg.message, code: pg.code });
  }

  /* Errors we raised deliberately (authService, passwordService) carry a
     status and are safe to show. `expected` ones are ordinary outcomes such
     as a wrong password, so they are logged at a lower volume. */
  if (err.status && err.status < 500) {
    if (!err.expected) {
      console.warn('[error] ' + req.method + ' ' + req.originalUrl + ' — ' + err.status + ': ' + err.message);
    }
    return res.status(err.status).json({
      error: err.message,
      code: err.code || 'ERROR'
    });
  }

  /* Anything else is a bug. Full detail to the log, nothing to the client. */
  console.error('[error] unhandled on ' + req.method + ' ' + req.originalUrl + ':', err);

  var body = { error: 'Something went wrong. Please try again.', code: 'INTERNAL_ERROR' };
  if (!config.isProd) body.detail = err.message;   // development only
  res.status(500).json(body);
}

/* Errors thrown outside a request (a bad DB connection at startup, say) would
   otherwise take the process down silently. */
function installProcessHandlers() {
  process.on('unhandledRejection', function (reason) {
    console.error('[fatal] unhandled promise rejection:', reason);
  });
  process.on('uncaughtException', function (err) {
    console.error('[fatal] uncaught exception:', err);
    /* An uncaught exception leaves the process in an unknown state. Exit and
       let the supervisor restart it cleanly. */
    process.exit(1);
  });
}

module.exports = errorHandler;
module.exports.asyncHandler = asyncHandler;
module.exports.notFound = notFound;
module.exports.installProcessHandlers = installProcessHandlers;
