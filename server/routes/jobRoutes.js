'use strict';
/* ---------------------------------------------------------------------------
   /api/checklist — Job Management.

   Reading the setup is open to every signed-in account: each phone needs the
   services to generate its kitchen's jobs. Changing it is the Super Admin's.

     GET    /types                     job types
     POST   /types                     { name, description, active }
     PATCH  /types/:id                 { name?, description?, active? }
     DELETE /types/:id                 not a built-in, and nothing under it

     GET    /items                     every service, keyed by slot
     POST   /items                     add a service
     PATCH  /items/:tk                 change a service (built-in or added)
     DELETE /items/:tk?builtInName=    stop scheduling it; recorded work stays
     POST   /items/:tk/restore         put a deleted service back
     GET    /items/history             who changed what
   --------------------------------------------------------------------------- */

var express = require('express');
var jobs = require('../models/jobModel');
var requireAuth = require('../middleware/requireAuth');
var requireSuperadmin = require('../middleware/requireRole').requireSuperadmin;
var asyncHandler = require('../middleware/errorHandler').asyncHandler;

var router = express.Router();
router.use(requireAuth);

var TKEY = /^[WM][0-9]{1,3}$/;
var LOC = /^[A-Z0-9-]{2,40}$/;
var USER_ID = /^[A-Za-z0-9_-]{1,64}$/;
var YMD = /^\d{4}-\d{2}-\d{2}$/;
var HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
var NAME_MAX = 120;

function bad(res, message, status, code) {
  return res.status(status || 400).json({ error: message, code: code || 'VALIDATION_ERROR' });
}
function by(req) { return { id: req.auth.id, name: req.authName || req.auth.uid, role: req.auth.role }; }

/* The signed-in person's name, for the history. */
var userModel = require('../models/userModel');
function withName(req, res, next) {
  userModel.findById(req.auth.id).then(function (u) { req.authName = u ? u.name : req.auth.uid; next(); }, next);
}

function cleanText(v) { return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : ''; }

/* Checks every field a service can carry. Returns { error } or { value }. */
function serviceFields(body, creating) {
  var out = {};
  if (body.name !== undefined || creating) {
    var name = cleanText(body.name);
    if (!name) return { error: 'Enter a name' };
    if (name.length > NAME_MAX) return { error: 'Keep the name to ' + NAME_MAX + ' characters or fewer' };
    out.name = name;
  }
  if (body.zone !== undefined || creating) {
    var zone = cleanText(body.zone);
    if (!zone && creating) return { error: 'Choose or enter an area' };
    if (zone.length > 60) return { error: 'Keep the area to 60 characters or fewer' };
    if (zone) out.zone = zone;
  }
  if (body.freq !== undefined || creating) {
    if (['D', 'W', 'M'].indexOf(body.freq) === -1) return { error: 'Choose Daily, Weekly or Monthly' };
    out.freq = body.freq;
  }
  if (body.day !== undefined) {
    if (body.day !== null && !(Number.isInteger(body.day) && body.day >= 0 && body.day <= 6)) return { error: 'Choose a weekday' };
    out.day = body.day;
  }
  if (body.loc !== undefined) {
    if (body.loc !== null && !(typeof body.loc === 'string' && LOC.test(body.loc))) return { error: 'Unknown restaurant' };
    out.loc = body.loc || null;
    if (body.locs === undefined) out.locs = out.loc ? [out.loc] : [];
  }
  if (body.locs !== undefined) {
    if (!Array.isArray(body.locs) || body.locs.length > 50 || !body.locs.every(function (l) { return typeof l === 'string' && LOC.test(l); })) {
      return { error: 'Unknown restaurant' };
    }
    out.locs = body.locs.filter(function (l, i, a) { return a.indexOf(l) === i; });
  }
  if (body.assignees !== undefined) {
    if (!Array.isArray(body.assignees) || body.assignees.length > 50 || !body.assignees.every(function (u) { return typeof u === 'string' && USER_ID.test(u); })) {
      return { error: 'Unknown person' };
    }
    out.assignees = body.assignees.filter(function (u, i, a) { return a.indexOf(u) === i; });
  }
  if (body.assignedTo !== undefined) {
    if (body.assignedTo !== null && !(typeof body.assignedTo === 'string' && USER_ID.test(body.assignedTo))) return { error: 'Unknown person' };
    out.assignees = body.assignedTo ? [body.assignedTo] : [];
  }
  if (body.atTime !== undefined) {
    if (body.atTime !== null && !(typeof body.atTime === 'string' && HHMM.test(body.atTime))) return { error: 'Enter a valid time' };
    out.atTime = body.atTime || null;
  }
  if (body.endDate !== undefined) {
    if (body.endDate !== null && !(typeof body.endDate === 'string' && YMD.test(body.endDate))) return { error: 'Enter a valid end date' };
    out.endDate = body.endDate || null;
  }
  if (body.jobType !== undefined) {
    if (typeof body.jobType !== 'string' || !/^[a-z0-9-]{1,40}$/.test(body.jobType)) return { error: 'Unknown job type' };
    out.jobType = body.jobType;
  }
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') return { error: 'Status must be on or off' };
    out.enabled = body.enabled;
  }
  if (body.deleted !== undefined) {
    if (typeof body.deleted !== 'boolean') return { error: 'Invalid value' };
    out.deleted = body.deleted;
  }
  return { value: out };
}

function checkJobType(id, res) {
  if (!id) return Promise.resolve(true);
  return jobs.findType(id).then(function (t) {
    if (!t) { bad(res, 'Unknown job type'); return false; }
    return true;
  });
}

function builtInName(req) {
  var n = cleanText((req.body && req.body.builtInName) || req.query.builtInName || '');
  return n.slice(0, NAME_MAX) || null;
}

/* ---------------------------------------------------------------------------
   Job types
   --------------------------------------------------------------------------- */
router.get('/types', asyncHandler(function (req, res) {
  return jobs.listTypes().then(function (types) { res.json({ types: types }); });
}));

function typeFields(body, creating) {
  var out = {};
  if (body.name !== undefined || creating) {
    var name = cleanText(body.name);
    if (!name) return { error: 'Enter a job type name' };
    if (name.length > 60) return { error: 'Keep the name to 60 characters or fewer' };
    out.name = name;
  }
  if (body.description !== undefined) {
    var d = cleanText(body.description);
    if (d.length > 300) return { error: 'Keep the description to 300 characters or fewer' };
    out.description = d;
  }
  if (body.active !== undefined) {
    if (typeof body.active !== 'boolean') return { error: 'Status must be active or inactive' };
    out.active = body.active;
  }
  return { value: out };
}

router.post('/types', requireSuperadmin, asyncHandler(function (req, res) {
  var f = typeFields(req.body || {}, true);
  if (f.error) return bad(res, f.error);
  return jobs.typeNameTaken(f.value.name).then(function (taken) {
    if (taken) return bad(res, 'There is already a job type called “' + f.value.name + '”', 409, 'NAME_TAKEN');
    return jobs.createType(f.value, by(req)).then(function (t) { res.status(201).json({ type: t }); });
  });
}));

router.patch('/types/:id', requireSuperadmin, asyncHandler(function (req, res) {
  var id = String(req.params.id);
  var f = typeFields(req.body || {}, false);
  if (f.error) return bad(res, f.error);
  return jobs.findType(id).then(function (t) {
    if (!t) return bad(res, 'Unknown job type', 404, 'NOT_FOUND');
    var nameCheck = f.value.name ? jobs.typeNameTaken(f.value.name, id) : Promise.resolve(false);
    return nameCheck.then(function (taken) {
      if (taken) return bad(res, 'There is already a job type called “' + f.value.name + '”', 409, 'NAME_TAKEN');
      return jobs.updateType(id, f.value, by(req)).then(function (u) { res.json({ type: u }); });
    });
  });
}));

router.delete('/types/:id', requireSuperadmin, asyncHandler(function (req, res) {
  var id = String(req.params.id);
  return jobs.findType(id).then(function (t) {
    if (!t) return bad(res, 'Unknown job type', 404, 'NOT_FOUND');
    if (t.builtin) return bad(res, t.name + ' is built into the app. It can be switched off, but not removed.', 409, 'BUILTIN');
    return jobs.servicesUsingType(id).then(function (n) {
      if (n) return bad(res, '“' + t.name + '” still has ' + n + ' service' + (n === 1 ? '' : 's') + '. Switch it off instead.', 409, 'IN_USE');
      return jobs.deleteType(id).then(function () { res.json({ ok: true }); });
    });
  });
}));

/* ---------------------------------------------------------------------------
   Services
   --------------------------------------------------------------------------- */
router.get('/items', asyncHandler(function (req, res) {
  return jobs.listItems().then(function (items) { res.json({ items: items }); });
}));

router.get('/items/history', requireSuperadmin, asyncHandler(function (req, res) {
  return jobs.listHistory(300).then(function (history) { res.json({ history: history }); });
}));

router.post('/items', requireSuperadmin, withName, asyncHandler(function (req, res) {
  var f = serviceFields(req.body || {}, true);
  if (f.error) return bad(res, f.error);
  var v = f.value;
  if (v.freq !== 'W') v.day = null;
  return checkJobType(v.jobType, res).then(function (ok) {
    if (!ok) return;
    return jobs.addItem(v, by(req)).then(function (item) {
      console.log('[jobs] ' + req.auth.uid + ' added ' + item.tkey + ' "' + item.name + '"');
      res.status(201).json({ item: item });
    });
  });
}));

router.patch('/items/:tk', requireSuperadmin, withName, asyncHandler(function (req, res) {
  var tk = String(req.params.tk);
  if (!TKEY.test(tk)) return bad(res, 'Unknown job', 404, 'NOT_FOUND');
  var body = Object.assign({}, req.body || {});
  delete body.builtInName;
  var f = serviceFields(body, false);
  if (f.error) return bad(res, f.error);
  if (!Object.keys(f.value).length) return bad(res, 'Nothing to change');
  return checkJobType(f.value.jobType, res).then(function (ok) {
    if (!ok) return;
    return jobs.updateItem(tk, f.value, builtInName(req), by(req)).then(function (item) { res.json({ item: item }); });
  });
}));

router.delete('/items/:tk', requireSuperadmin, withName, asyncHandler(function (req, res) {
  var tk = String(req.params.tk);
  if (!TKEY.test(tk)) return bad(res, 'Unknown job', 404, 'NOT_FOUND');
  return jobs.setDeleted(tk, true, builtInName(req), by(req)).then(function (item) { res.json({ item: item }); });
}));

router.post('/items/:tk/restore', requireSuperadmin, withName, asyncHandler(function (req, res) {
  var tk = String(req.params.tk);
  if (!TKEY.test(tk)) return bad(res, 'Unknown job', 404, 'NOT_FOUND');
  return jobs.findItem(tk).then(function (cur) {
    if (!cur || !cur.deleted) return bad(res, 'That job is not deleted', 409, 'NOT_DELETED');
    return jobs.setDeleted(tk, false, builtInName(req), by(req)).then(function (item) { res.json({ item: item }); });
  });
}));

module.exports = router;
module.exports.serviceFields = serviceFields;
