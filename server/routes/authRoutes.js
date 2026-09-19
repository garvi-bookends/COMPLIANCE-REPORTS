'use strict';
/* ---------------------------------------------------------------------------
   /api/auth — login, session refresh, logout, password change.

   Endpoints:
     POST /api/auth/login             public   username + password -> session
     POST /api/auth/refresh           cookie   -> a new access token
     POST /api/auth/logout            cookie   revoke this session
     GET  /api/auth/me                bearer   the signed-in user's profile
     POST /api/auth/change-password   bearer   user picks their own password
   --------------------------------------------------------------------------- */

var express = require('express');
var authService = require('../services/authService');
var tokens = require('../services/tokenService');
var userModel = require('../models/userModel');
var requireAuth = require('../middleware/requireAuth');
var validate = require('../middleware/validate');
var rateLimit = require('../middleware/rateLimit');
var asyncHandler = require('../middleware/errorHandler').asyncHandler;

var router = express.Router();

function ctxOf(req) {
  return { ip: req.ip, userAgent: req.headers['user-agent'] || '' };
}

/* The only user object that ever crosses the wire. Built by explicitly naming
   fields rather than deleting unwanted ones, so a column added to app_users
   later cannot leak by default (req 10). */
function publicUser(user) {
  return {
    id: user.id,
    uid: user.uid,
    name: user.name,
    role: user.role,
    loc: user.loc,
    mustChange: user.mustChange,
    firstLogin: user.firstLogin,
    lastLogin: user.lastLogin,
    createdAt: user.createdAt
  };
}

/* Login is rate limited by IP and by the username being attempted, so neither
   one account nor one source can be hammered. */
var loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 40,
  message: 'Too many sign-in attempts from this device. Please wait a few minutes.'
});

/* ---------------------------------------------------------------------------
   POST /api/auth/login        (reqs 4, 5, 7)
   --------------------------------------------------------------------------- */
router.post('/login', loginLimiter, validate.validateLogin, asyncHandler(function (req, res) {
  return authService.login(req.valid.uid, req.valid.password, ctxOf(req))
    .then(function (session) {
      /* The refresh token goes out as an httpOnly cookie — not in the JSON —
         so page scripts can never read it. */
      tokens.setRefreshCookie(res, session.refreshToken);

      /* A clean sign-in clears this device's failed-attempt budget. */
      rateLimit.reset(req.ip);

      res.json({
        user: publicUser(session.user),
        accessToken: session.accessToken,
        expiresIn: session.expiresIn,
        /* Tells the frontend whether to show the forced password-change
           screen, replacing the old client-side mustChange flag. */
        mustChangePassword: session.user.mustChange
      });
    });
}));

/* ---------------------------------------------------------------------------
   POST /api/auth/register           — self sign-up

   Body: { name, uid, password, confirmPassword, loc? }

   Creates a PENDING staff account. No session is issued: the person cannot
   sign in until an admin approves them (POST /api/admin/users/:id/approve).

   Public by necessity, so it is throttled hard — ten sign-ups an hour from
   one address is plenty for a kitchen and useless for flooding the table.
   --------------------------------------------------------------------------- */
var registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  keyBy: function (req) { return 'register:' + req.ip; },
  message: 'Too many accounts created from this device. Please try again later.'
});

router.post('/register', registerLimiter, validate.validateRegister, asyncHandler(function (req, res) {
  return authService.register(req.valid).then(function (user) {
    console.log('[auth] self sign-up: ' + user.uid + ' (' + user.name + ') — waiting for approval');
    res.status(201).json({
      ok: true,
      pending: true,
      user: { uid: user.uid, name: user.name },
      message: 'Account created. It needs to be approved before you can sign in.'
    });
  });
}));

/* ---------------------------------------------------------------------------
   POST /api/auth/forgot             — "Forgot password?"

   Body: { uid }

   There is no email or SMS in this system, so a reset cannot be self-service.
   Instead the request lands on the Super Admin's dashboard, and they set a
   temporary password that the person must change at their next sign-in.

   The response is IDENTICAL whether or not the username exists, so this
   form cannot be used to find out who has an account. Throttled because it
   is public.
   --------------------------------------------------------------------------- */
var forgotLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  keyBy: function (req) { return 'forgot:' + req.ip; },
  message: 'Too many reset requests from this device. Please try again later.'
});

var FORGOT_REPLY = {
  ok: true,
  message: 'If that username exists, the Super Admin has been asked to reset it. ' +
           'They will give you a temporary password.'
};

router.post('/forgot', forgotLimiter, asyncHandler(function (req, res) {
  var u = validate.uid((req.body || {}).uid, 'Username');
  if (!u.ok) return res.status(400).json({ error: u.error, code: 'VALIDATION_ERROR' });

  return userModel.requestPasswordReset(u.value).then(function (found) {
    if (found) console.log('[auth] password reset requested for ' + u.value);
    res.json(FORGOT_REPLY);
  });
}));

/* ---------------------------------------------------------------------------
   POST /api/auth/refresh

   Called on app start and shortly before the access token expires, so the
   user is not signed out mid-shift. Rotates the refresh token.
   --------------------------------------------------------------------------- */
router.post('/refresh', asyncHandler(function (req, res) {
  var raw = tokens.readRefreshCookie(req);

  return authService.refresh(raw, ctxOf(req))
    .then(function (session) {
      tokens.setRefreshCookie(res, session.refreshToken);
      res.json({
        user: publicUser(session.user),
        accessToken: session.accessToken,
        expiresIn: session.expiresIn,
        mustChangePassword: session.user.mustChange
      });
    })
    .catch(function (err) {
      /* A dead session must not leave a stale cookie behind, or the client
         will retry with it forever. */
      tokens.clearRefreshCookie(res);
      throw err;
    });
}));

/* ---------------------------------------------------------------------------
   POST /api/auth/logout

   Deliberately not behind requireAuth: logging out has to work even when the
   access token has already expired. The refresh cookie is the authority here.
   --------------------------------------------------------------------------- */
router.post('/logout', asyncHandler(function (req, res) {
  var raw = tokens.readRefreshCookie(req);
  return authService.logout(raw).then(function () {
    tokens.clearRefreshCookie(res);
    res.json({ ok: true });
  });
}));

/* ---------------------------------------------------------------------------
   GET /api/auth/me

   Re-reads the profile from the database rather than trusting the token
   claims, so a role change or a disabled account takes effect on the next
   call instead of when the token expires.
   --------------------------------------------------------------------------- */
router.get('/me', requireAuth, asyncHandler(function (req, res) {
  return userModel.findById(req.auth.id).then(function (user) {
    if (!user || user.disabled) {
      return res.status(401).json({ error: 'Your account is no longer active', code: 'ACCOUNT_INACTIVE' });
    }
    res.json({ user: publicUser(user) });
  });
}));

/* ---------------------------------------------------------------------------
   POST /api/auth/change-password

   The user id comes from req.auth, never from the body, so one signed-in user
   cannot change another user's password through this route.
   --------------------------------------------------------------------------- */
router.post('/change-password', requireAuth, validate.validateChangePassword, asyncHandler(function (req, res) {
  return authService.changePassword(req.auth.id, req.valid.currentPassword, req.valid.newPassword)
    .then(function (user) {
      /* Every session was just revoked, including this one. Issue a fresh one
         so the user is not thrown back to the login screen after doing the
         right thing. */
      return authService.issueSession(user, ctxOf(req)).then(function (session) {
        tokens.setRefreshCookie(res, session.refreshToken);
        res.json({
          ok: true,
          user: publicUser(session.user),
          accessToken: session.accessToken,
          expiresIn: session.expiresIn,
          mustChangePassword: false
        });
      });
    });
}));

module.exports = router;
module.exports.publicUser = publicUser;
