'use strict';
/* ---------------------------------------------------------------------------
   /api/users — the roster every signed-in user is allowed to read.

   The app needs this: uname(), initials(), the assignee pickers and
   ensureJobs() all look up people by id. Previously that list came out of
   localStorage and out of the bk_users table, where it sat next to everyone's
   plaintext password. Now it comes from here, and it contains no credential
   material at all — id, uid, name, role, location, nothing else.

   Behind requireAuth, so an unauthenticated caller cannot harvest staff names
   and login IDs.
   --------------------------------------------------------------------------- */

var express = require('express');
var userModel = require('../models/userModel');
var requireAuth = require('../middleware/requireAuth');
var asyncHandler = require('../middleware/errorHandler').asyncHandler;

var router = express.Router();

/* ---------------------------------------------------------------------------
   GET /api/users/roster
   --------------------------------------------------------------------------- */
router.get('/roster', requireAuth, asyncHandler(function (req, res) {
  return userModel.listRoster().then(function (users) {
    /* Cacheable for a minute: the roster changes rarely and the app asks for
       it on every foreground. */
    res.set('Cache-Control', 'private, max-age=60');
    res.json({ users: users });
  });
}));

module.exports = router;
