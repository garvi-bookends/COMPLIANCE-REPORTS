'use strict';
/* ---------------------------------------------------------------------------
   /api/checklists — Lunch, Dinner and Closing checklists.

   The flow is: the user submits, the server checks the time window and
   records who sent the checklist with every item ticked. There is no Google
   Form and no photo: the answers are stored here, in app_checklists. The
   window is decided HERE, from the server's clock in IST. The browser's clock
   and the browser's opinion of "open" are never trusted, so changing the
   device time or editing the page's JavaScript gets a 403, not a record.

   Endpoints:
     GET  /api/checklists/status   windows right now + my submissions (everyone)
     POST /api/checklists          submit { type, loc?, answers } (not auditors)
     GET  /api/checklists          records for a date range (not kitchen staff)
     GET  /api/checklists/:id      one record
   --------------------------------------------------------------------------- */

var express = require('express');
var userModel = require('../models/userModel');
var checklists = require('../models/checklistModel');
var windows = require('../services/checklistWindows');
var items = require('../services/checklistItems');
var requireAuth = require('../middleware/requireAuth');
var validate = require('../middleware/validate');
var asyncHandler = require('../middleware/errorHandler').asyncHandler;

var router = express.Router();
router.use(requireAuth);

/* Mirrors ROLES[].readonly in index.html. Auditors look; they do not submit. */
var READONLY_ROLES = ['auditor'];
/* Kitchen staff see their own checklists but not everyone else's. */
var NO_LIST_ROLES = ['staff'];

var LOC_FORMAT = /^[A-Z0-9-]{2,40}$/;
var YMD = /^\d{4}-\d{2}-\d{2}$/;

function fail(res, status, message, code) {
  return res.status(status).json({ error: message, code: code });
}

function seesAllLocations(role) {
  return userModel.ALL_LOCATION_ROLES.indexOf(role) > -1;
}

/* ---------------------------------------------------------------------------
   GET /status
   --------------------------------------------------------------------------- */
router.get('/status', asyncHandler(function (req, res) {
  var now = Date.now();
  var states = windows.allStates(now);
  var dates = [];
  states.forEach(function (s) { if (dates.indexOf(s.shiftDate) === -1) dates.push(s.shiftDate); });

  return checklists.listForUser(req.auth.id, dates).then(function (mine) {
    var out = states.map(function (s) {
      var sub = mine.filter(function (m) { return m.type === s.type && m.shiftDate === s.shiftDate; })[0] || null;
      return {
        type: s.type, label: s.label, open: s.open, shiftDate: s.shiftDate,
        startsAt: s.startsAt, endsAt: s.endsAt, nextOpensAt: s.nextOpensAt,
        submission: sub
      };
    });
    res.set('Cache-Control', 'no-store');
    res.json({ serverNow: now, timeZone: 'Asia/Kolkata', windows: out });
  });
}));

/* ---------------------------------------------------------------------------
   POST /   { type: 'LUNCH'|'DINNER'|'CLOSING', loc? }
   --------------------------------------------------------------------------- */
router.post('/', asyncHandler(function (req, res) {
  var body = req.body || {};

  if (READONLY_ROLES.indexOf(req.auth.role) > -1) {
    return fail(res, 403, 'Your account is read-only and cannot submit checklists.', 'FORBIDDEN');
  }

  var type = String(body.type || '').toUpperCase();
  var win = windows.byType(type);
  if (!win) return fail(res, 400, 'Choose Lunch, Dinner or Closing.', 'VALIDATION_ERROR');

  var ticked = items.check(body.answers);
  if (ticked.error) return fail(res, 400, ticked.error, 'VALIDATION_ERROR');

  /* The time check comes before anything else that could succeed. */
  var now = Date.now();
  var state = windows.windowState(win, now);
  if (!state.open) {
    return fail(res, 403, win.label + ' is currently unavailable. Available from ' +
      windows.rangeLabel(win) + '.', 'CHECKLIST_CLOSED');
  }

  /* Staff and location managers are pinned to their own kitchen by their
     signed token. Group-level roles may name the kitchen they are at. */
  var loc = req.auth.loc || null;
  if (seesAllLocations(req.auth.role)) {
    var l = validate.str(body.loc, 'Location', { optional: true, max: 40 });
    loc = l.ok && l.value && LOC_FORMAT.test(l.value) ? l.value : null;
    if (!loc) return fail(res, 400, 'Choose the kitchen this checklist is for.', 'VALIDATION_ERROR');
  }

  return userModel.findById(req.auth.id).then(function (user) {
    if (!user || user.disabled || user.pending) {
      return fail(res, 401, 'Sign in to continue', 'UNAUTHORIZED');
    }
    return checklists.create({
      userId: user.id,
      userName: user.name,
      loc: loc,
      type: type,
      shiftDate: state.shiftDate,
      startTime: state.startsAt,
      endTime: state.endsAt,
      /* The same instant the window was judged at, so a record can never
         show a submission time outside its own window. */
      submittedAt: now,
      answers: ticked.answers
    }).then(function (rec) {
      if (rec) {
        console.log('[checklist] ' + user.uid + ' submitted ' + type + ' for ' + state.shiftDate + (loc ? ' at ' + loc : ''));
        return res.status(201).json({ checklist: rec });
      }
      /* Already done this shift: hand back the record that is there. */
      return checklists.listForUser(user.id, [state.shiftDate]).then(function (mine) {
        var existing = mine.filter(function (m) { return m.type === type; })[0] || null;
        res.status(409).json({
          error: 'You have already submitted the ' + win.label + ' for this shift.',
          code: 'ALREADY_SUBMITTED',
          checklist: existing
        });
      });
    });
  });
}));

/* ---------------------------------------------------------------------------
   GET /?from=YYYY-MM-DD&to=YYYY-MM-DD&loc=
   --------------------------------------------------------------------------- */
router.get('/', asyncHandler(function (req, res) {
  if (NO_LIST_ROLES.indexOf(req.auth.role) > -1) {
    return fail(res, 403, 'You do not have permission to do that', 'FORBIDDEN');
  }
  var today = windows.istParts(Date.now()).ymd;
  var from = YMD.test(req.query.from || '') ? req.query.from : windows.addDaysYmd(today, -6);
  var to = YMD.test(req.query.to || '') ? req.query.to : today;
  if (from > to) { var t = from; from = to; to = t; }

  var loc = null;
  if (seesAllLocations(req.auth.role)) {
    if (req.query.loc && LOC_FORMAT.test(req.query.loc)) loc = req.query.loc;
  } else {
    loc = req.auth.loc;
    if (!loc) return res.json({ from: from, to: to, checklists: [] });
  }

  return checklists.list({ from: from, to: to, loc: loc }).then(function (rows) {
    res.set('Cache-Control', 'no-store');
    res.json({ from: from, to: to, checklists: rows });
  });
}));

/* ---------------------------------------------------------------------------
   GET /:id — one record
   --------------------------------------------------------------------------- */
router.get('/:id', asyncHandler(function (req, res) {
  var id = String(req.params.id || '');
  if (!/^CL-[A-F0-9]{12}$/.test(id)) return fail(res, 400, 'Invalid checklist id', 'INVALID_ID');

  return checklists.findById(id).then(function (rec) {
    if (!rec) return fail(res, 404, 'Not found', 'NOT_FOUND');
    var own = rec.userId === req.auth.id;
    var mayList = NO_LIST_ROLES.indexOf(req.auth.role) === -1 &&
      (seesAllLocations(req.auth.role) || (req.auth.loc && rec.loc === req.auth.loc));
    if (!own && !mayList) return fail(res, 404, 'Not found', 'NOT_FOUND');
    res.set('Cache-Control', 'private, max-age=300');
    res.json({ checklist: rec });
  });
}));

module.exports = router;
