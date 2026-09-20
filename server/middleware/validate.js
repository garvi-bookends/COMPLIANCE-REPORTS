'use strict';
/* ---------------------------------------------------------------------------
   Request validation (req 8).

   Hand-rolled rather than pulling in a schema library, to match a codebase
   that currently has no dependencies at all. The job is narrow: reject
   malformed input with a 400 and a clear message before it reaches a model,
   so bad data never gets as far as the database and a missing field never
   surfaces as a 500.

   Every validator returns { ok: true, value } or { ok: false, error }.
   --------------------------------------------------------------------------- */

var userModel = require('../models/userModel');

function fail(res, message, code) {
  return res.status(400).json({ error: message, code: code || 'VALIDATION_ERROR' });
}

/* A string field: present, a string, trimmed, within length bounds. */
function str(value, label, opts) {
  opts = opts || {};
  if (value === undefined || value === null) {
    if (opts.optional) return { ok: true, value: undefined };
    return { ok: false, error: label + ' is required' };
  }
  if (typeof value !== 'string') return { ok: false, error: label + ' must be text' };
  var v = opts.trim === false ? value : value.trim();
  if (!v.length) {
    if (opts.optional) return { ok: true, value: undefined };
    return { ok: false, error: label + ' is required' };
  }
  if (opts.min && v.length < opts.min) return { ok: false, error: label + ' must be at least ' + opts.min + ' characters' };
  if (opts.max && v.length > opts.max) return { ok: false, error: label + ' must be ' + opts.max + ' characters or fewer' };
  return { ok: true, value: v };
}

/* Login IDs are lower-case letters and digits only — the rule the database
   CHECK constraint also enforces, so an invalid one is caught here with a
   friendly message rather than as a constraint violation. */
/* A contact address. Optional everywhere, and never used to sign in, so the
   check is deliberately loose: something@something.something, no more. An
   empty value clears it rather than failing. */
function email(value, label) {
  if (value === undefined || value === null || String(value).trim() === '') return { ok: true, value: null };
  var v = String(value).trim();
  if (v.length > 120) return { ok: false, error: label + ' must be 120 characters or fewer' };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v)) return { ok: false, error: 'Enter a valid email address, or leave it blank' };
  return { ok: true, value: v.toLowerCase() };
}

function uid(value, label) {
  var s = str(value, label || 'User ID', { max: 32 });
  if (!s.ok) return s;
  var normalised = userModel.normaliseUid(s.value);
  if (normalised.length < 2) {
    return { ok: false, error: 'A login ID needs at least 2 letters or numbers' };
  }
  if (normalised.length > 32) {
    return { ok: false, error: 'A login ID must be 32 characters or fewer' };
  }
  return { ok: true, value: normalised };
}

function role(value) {
  var s = str(value, 'Role');
  if (!s.ok) return s;
  if (s.value === userModel.SUPERADMIN) {
    return { ok: false, error: 'The Super Admin role cannot be given from the app' };
  }
  if (userModel.ASSIGNABLE_ROLES.indexOf(s.value) === -1) {
    return { ok: false, error: 'Unknown role "' + s.value + '"' };
  }
  return { ok: true, value: s.value };
}

/* Passwords are NOT trimmed and NOT length-capped here — a leading space is a
   legitimate part of a password, and strength rules belong to
   passwordService so there is exactly one definition of them. */
function password(value, label) {
  if (typeof value !== 'string' || !value.length) {
    return { ok: false, error: (label || 'Password') + ' is required' };
  }
  return { ok: true, value: value };
}

function bool(value, label, opts) {
  opts = opts || {};
  if (value === undefined || value === null) {
    if (opts.optional) return { ok: true, value: undefined };
    return { ok: false, error: label + ' is required' };
  }
  if (typeof value !== 'boolean') return { ok: false, error: label + ' must be true or false' };
  return { ok: true, value: value };
}

/* --------------------------------------------------------------------------
   Route validators
   -------------------------------------------------------------------------- */

function validateLogin(req, res, next) {
  var body = req.body || {};
  /* The frontend field is called `uid`; `username` is accepted too so the API
     is usable from curl and from any other client without surprises. */
  var rawUid = body.uid !== undefined ? body.uid : body.username;

  var u = uid(rawUid, 'User ID');
  if (!u.ok) return fail(res, u.error);

  var p = password(body.password);
  if (!p.ok) return fail(res, p.error);

  req.valid = { uid: u.value, password: p.value };
  next();
}

function validateChangePassword(req, res, next) {
  var body = req.body || {};

  var next1 = password(body.newPassword, 'New password');
  if (!next1.ok) return fail(res, next1.error);

  if (body.confirmPassword !== undefined && body.confirmPassword !== body.newPassword) {
    return fail(res, 'The two passwords do not match', 'PASSWORD_MISMATCH');
  }

  req.valid = {
    currentPassword: typeof body.currentPassword === 'string' ? body.currentPassword : '',
    newPassword: next1.value
  };
  next();
}

/* Self sign-up. Deliberately has no role field: whatever a client sends as
   `role` is ignored, because the server always creates a pending staff
   account and an admin sets the real role on approval. */
function validateRegister(req, res, next) {
  var body = req.body || {};

  var name = str(body.name, 'Your name', { min: 2, max: 80 });
  if (!name.ok) return fail(res, name.error);

  var u = uid(body.uid !== undefined ? body.uid : body.username, 'Username');
  if (!u.ok) return fail(res, u.error);

  var p = password(body.password, 'Password');
  if (!p.ok) return fail(res, p.error);

  if (body.confirmPassword !== undefined && body.confirmPassword !== body.password) {
    return fail(res, 'The two passwords do not match', 'PASSWORD_MISMATCH');
  }

  var loc = str(body.loc, 'Kitchen', { optional: true, max: 40 });
  if (!loc.ok) return fail(res, loc.error);

  req.valid = { name: name.value, uid: u.value, password: p.value, loc: loc.value || null };
  next();
}

/* Admin approving a self sign-up: the role is required, since choosing it is
   the whole point of the approval. */
function validateApprove(req, res, next) {
  var body = req.body || {};

  var r = role(body.role);
  if (!r.ok) return fail(res, r.error);

  var loc = str(body.loc, 'Location', { optional: true, max: 40 });
  if (!loc.ok) return fail(res, loc.error);

  req.valid = { role: r.value, loc: loc.value || null };
  next();
}

function validateCreateUser(req, res, next) {
  var body = req.body || {};

  var name = str(body.name, 'Full name', { min: 2, max: 80 });
  if (!name.ok) return fail(res, name.error);

  var r = role(body.role);
  if (!r.ok) return fail(res, r.error);

  /* uid is optional: left out, the server derives it from the first name the
     same way the old frontend did. */
  var u = { ok: true, value: undefined };
  if (body.uid !== undefined && String(body.uid).trim() !== '') {
    u = uid(body.uid, 'Login ID');
    if (!u.ok) return fail(res, u.error);
  }

  var loc = str(body.loc, 'Location', { optional: true, max: 40 });
  if (!loc.ok) return fail(res, loc.error);

  /* An initial password may be supplied; otherwise DEFAULT_PASSWORD is used. */
  var pw = { ok: true, value: undefined };
  if (body.password !== undefined && body.password !== null && body.password !== '') {
    pw = password(body.password, 'Initial password');
    if (!pw.ok) return fail(res, pw.error);
  }

  /* An account may be created already switched off, for someone who starts
     later. Absent means active, which is how every existing caller behaves. */
  var dis = { ok: true, value: false };
  if (body.disabled !== undefined) {
    dis = bool(body.disabled, 'Disabled');
    if (!dis.ok) return fail(res, dis.error);
  }

  var em = email(body.email, 'Email');
  if (!em.ok) return fail(res, em.error);

  req.valid = {
    name: name.value,
    uid: u.value,
    role: r.value,
    loc: loc.value || null,
    password: pw.value,
    disabled: dis.value,
    email: em.value
  };
  next();
}

function validateUpdateUser(req, res, next) {
  var body = req.body || {};
  var out = {};

  if (body.name !== undefined) {
    var name = str(body.name, 'Full name', { min: 2, max: 80 });
    if (!name.ok) return fail(res, name.error);
    out.name = name.value;
  }
  if (body.role !== undefined) {
    var r = role(body.role);
    if (!r.ok) return fail(res, r.error);
    out.role = r.value;
  }
  if (body.loc !== undefined) {
    var loc = str(body.loc, 'Location', { optional: true, max: 40 });
    if (!loc.ok) return fail(res, loc.error);
    out.loc = loc.value || null;
  }
  if (body.email !== undefined) {
    var em2 = email(body.email, 'Email');
    if (!em2.ok) return fail(res, em2.error);
    out.email = em2.value;
  }
  if (body.disabled !== undefined) {
    var d = bool(body.disabled, 'Disabled');
    if (!d.ok) return fail(res, d.error);
    out.disabled = d.value;
  }

  if (!Object.keys(out).length) return fail(res, 'Nothing to update');

  req.valid = out;
  next();
}

function validateResetPassword(req, res, next) {
  var body = req.body || {};
  var out = {};

  /* No password in the body means "back to the shared starting password",
     which is what the 🔑 button in the UI does. */
  if (body.password !== undefined && body.password !== null && body.password !== '') {
    var p = password(body.password, 'New password');
    if (!p.ok) return fail(res, p.error);
    out.password = p.value;
  }

  req.valid = out;
  next();
}

/* A URL path parameter that must look like one of our ids. Stops a stray
   path segment reaching a query as a wildcard. */
function validateUserIdParam(req, res, next) {
  var id = String(req.params.id || '').trim();
  if (!id || id.length > 64 || !/^[A-Za-z0-9_-]+$/.test(id)) {
    return fail(res, 'Invalid user id', 'INVALID_ID');
  }
  req.params.id = id;
  next();
}

module.exports = {
  str: str,
  uid: uid,
  role: role,
  password: password,
  bool: bool,
  validateLogin: validateLogin,
  validateChangePassword: validateChangePassword,
  validateRegister: validateRegister,
  validateApprove: validateApprove,
  validateCreateUser: validateCreateUser,
  validateUpdateUser: validateUpdateUser,
  validateResetPassword: validateResetPassword,
  validateUserIdParam: validateUserIdParam
};
