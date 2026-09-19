'use strict';
/* ---------------------------------------------------------------------------
   Authorisation middleware.

   requireAuth answers "who is this?". requireRole answers "are they allowed
   to do this?". Creating users and resetting passwords sit behind
   requireManager, so a signed-in kitchen staff account cannot call the admin
   API even though it holds a perfectly valid token.

   The role comes from req.auth (a signed claim), never from the request body.
   --------------------------------------------------------------------------- */

var userModel = require('../models/userModel');

function requireRole(allowedRoles) {
  var allowed = Array.isArray(allowedRoles) ? allowedRoles : [allowedRoles];

  return function (req, res, next) {
    if (!req.auth) {
      /* requireRole used without requireAuth in front of it — a wiring bug,
         not a client problem. Fail closed and say so in the log. */
      console.error('[auth] requireRole reached without requireAuth on ' + req.method + ' ' + req.originalUrl);
      return res.status(401).json({ error: 'Sign in to continue', code: 'NO_TOKEN' });
    }
    if (allowed.indexOf(req.auth.role) === -1) {
      return res.status(403).json({
        error: 'You do not have permission to do that',
        code: 'FORBIDDEN'
      });
    }
    next();
  };
}

/* Roles with ROLES[].manage === true in the frontend: superadmin, exec, aexec, admin. */
var requireManager = requireRole(userModel.MANAGER_ROLES);

/* The single Super Admin. Approving self sign-ups sits behind this. */
var requireSuperadmin = requireRole([userModel.SUPERADMIN]);

module.exports = requireRole;
module.exports.requireRole = requireRole;
module.exports.requireManager = requireManager;
module.exports.requireSuperadmin = requireSuperadmin;
