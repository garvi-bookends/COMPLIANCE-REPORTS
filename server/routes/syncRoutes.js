'use strict';
/* ---------------------------------------------------------------------------
   /api/sync — cleaning tasks and expiry products, shared across devices.

   This replaces the browser talking to Supabase directly with a public anon
   key, which let anyone who opened the page read or overwrite every kitchen's
   records. Now every read and write is checked here:

     - signed in at all                       requireAuth
     - which kitchens they may touch          all-location roles: every one;
                                              everyone else: their own only
     - whether they may write                 the Auditor is read-only

   Endpoints (kind = tasks | products):
     GET  /api/sync/:kind?since=ISO&after=ID   changed rows, a page at a time
     POST /api/sync/:kind   { rows: [...] }    upload changed rows

   Ordering. `updated_at` is set by THIS server when a row is written, so it
   is a reliable cursor for "what changed since I last asked" no matter how
   wrong a phone's clock is. Which of two edits wins is decided by the
   record's own `_u` (the device time of the edit), exactly as before.
   --------------------------------------------------------------------------- */

var express = require('express');
var db = require('../db/pool');
var userModel = require('../models/userModel');
var requireAuth = require('../middleware/requireAuth');
var asyncHandler = require('../middleware/errorHandler').asyncHandler;

var router = express.Router();

var TABLES = { tasks: 'bk_tasks', products: 'bk_products' };
var READ_ONLY_ROLES = ['auditor'];
var PAGE = 300;                 // rows per GET — keeps a response well under Vercel's 4.5 MB
var MAX_ROWS_PER_POST = 200;
var ID_RE = /^[A-Za-z0-9_.:-]{1,80}$/;

/* The cursor handed back is a few seconds behind the clock, so a row whose
   write was still committing while we read is picked up next time. Seeing a
   row twice is harmless: merging is idempotent. */
var OVERLAP = "interval '5 seconds'";

router.use(requireAuth);

function tableFor(req, res) {
  var t = TABLES[req.params.kind];
  if (!t) res.status(404).json({ error: 'Unknown data type', code: 'NOT_FOUND' });
  return t;
}

function seesAll(auth) {
  return userModel.ALL_LOCATION_ROLES.indexOf(auth.role) > -1;
}

/* ---------------------------------------------------------------------------
   GET /api/sync/:kind?since=ISO&after=ID

   Keyset pagination on (updated_at, id). The reply says either
     { rows, more: true,  next: { since, after } }   — ask again with these
     { rows, more: false, cursor }                    — next time, since=cursor
   --------------------------------------------------------------------------- */
router.get('/:kind', asyncHandler(function (req, res) {
  var table = tableFor(req, res); if (!table) return;

  var since = new Date(req.query.since || 0);
  if (isNaN(since.getTime())) since = new Date(0);
  var after = typeof req.query.after === 'string' && ID_RE.test(req.query.after) ? req.query.after : '';

  var all = seesAll(req.auth);
  if (!all && !req.auth.loc) return res.json({ rows: [], more: false, cursor: new Date().toISOString() });

  var params = [since.toISOString(), after, PAGE + 1];
  var scope = '';
  if (!all) { params.push(req.auth.loc); scope = ' and loc = $4'; }
  /* Kitchen Staff get the labels they entered and no others. The screen
     filters too, but this is the line that matters: without it every
     product in the kitchen sits on their device, one export away. Cleaning
     is untouched — a kitchen's jobs are shared work, handed out by the
     Super Admin, and a job nobody could see is a job nobody does. */
  if (req.params.kind === 'products' && req.auth.role === 'staff') {
    params.push(req.auth.id);
    scope += " and data->>'by' = $" + params.length;
  }

  return db.query(
    'select id, updated_at, data, (now() - ' + OVERLAP + ') as cursor from ' + table +
    ' where (updated_at, id) > ($1::timestamptz, $2)' + scope +
    ' order by updated_at, id limit $3',
    params
  ).then(function (r) {
    var rows = r.rows.slice(0, PAGE).map(function (x) {
      return { id: x.id, updated_at: x.updated_at.toISOString(), data: x.data };
    });
    if (r.rows.length > PAGE) {
      var last = rows[rows.length - 1];
      return res.json({ rows: rows, more: true, next: { since: last.updated_at, after: last.id } });
    }
    /* No rows means no `cursor` column came back; ask the clock directly. */
    var cursor = r.rows.length ? r.rows[0].cursor : null;
    return (cursor ? Promise.resolve(cursor) : db.query('select now() - ' + OVERLAP + ' as c').then(function (q) { return q.rows[0].c; }))
      .then(function (c) { res.json({ rows: rows, more: false, cursor: new Date(c).toISOString() }); });
  });
}));

/* ---------------------------------------------------------------------------
   POST /api/sync/:kind   { rows: [{ id, loc, data }] }

   Each row is checked on its own. Rows the caller may not write (another
   kitchen's, or malformed) are skipped and listed in `rejected`, so one bad
   row cannot block the rest — a phone at one kitchen still generates the
   weekly jobs for every kitchen locally, and those must simply be ignored.

   A row only replaces what is stored when its edit is at least as new
   (data._u), and — for a single-kitchen user — only when the stored row is
   theirs too, so an id cannot be used to overwrite another kitchen's record.
   --------------------------------------------------------------------------- */
router.post('/:kind', asyncHandler(function (req, res) {
  var table = tableFor(req, res); if (!table) return;

  if (READ_ONLY_ROLES.indexOf(req.auth.role) > -1) {
    return res.status(403).json({ error: 'Your account can view records but not change them', code: 'READ_ONLY' });
  }

  var rows = req.body && Array.isArray(req.body.rows) ? req.body.rows : null;
  if (!rows) return res.status(400).json({ error: 'Expected { rows: [...] }', code: 'VALIDATION_ERROR' });
  if (rows.length > MAX_ROWS_PER_POST) {
    return res.status(413).json({ error: 'Send at most ' + MAX_ROWS_PER_POST + ' rows at a time', code: 'TOO_MANY_ROWS' });
  }

  var all = seesAll(req.auth);
  var accepted = [], rejected = [];

  rows.forEach(function (row) {
    var id = row && row.id, data = row && row.data;
    var loc = row && row.loc != null ? String(row.loc) : null;
    var ok = typeof id === 'string' && ID_RE.test(id) &&
             data && typeof data === 'object' && !Array.isArray(data) &&
             data.id === id &&
             (data._u === undefined || (typeof data._u === 'number' && isFinite(data._u))) &&
             /* a tombstone carries only { id, deleted } */
             (data.deleted === true || (data.loc == null ? null : String(data.loc)) === loc) &&
             (all || (loc !== null && loc === req.auth.loc));
    if (ok) accepted.push({ id: id, loc: loc, data: data });
    else rejected.push(typeof id === 'string' ? id.slice(0, 80) : null);
  });

  if (!accepted.length) return res.json({ saved: [], rejected: rejected });

  /* Cleaning jobs from a role without approval rights (Kitchen Staff) are
     checked field by field against what is stored, so approving, rejecting
     or re-opening a job cannot be done by editing the record on a phone. */
  var checkJobs = req.params.kind === 'tasks' && APPROVER_ROLES.indexOf(req.auth.role) === -1;

  return (checkJobs ? currentRows(table, accepted) : Promise.resolve(null)).then(function (prevById) {
    var denied = [];
    if (prevById) {
      accepted = accepted.filter(function (row) {
        var why = jobChangeRefused(prevById[row.id] || null, row.data);
        if (why) { denied.push(row.id); return false; }
        return true;
      });
    }
    return writeRows(table, accepted, all).then(function (saved) {
      if (!denied.length) return res.json({ saved: saved, rejected: rejected });
      /* Hand back the stored copy of each refused job, so the phone drops
         its local edit instead of showing a status the server never took. */
      var current = denied.filter(function (id) { return prevById[id]; }).map(function (id) {
        var p = prevById[id];
        return { id: id, updated_at: p.updated_at.toISOString(), data: p.data };
      });
      res.json({ saved: saved, rejected: rejected.concat(denied), current: current });
    });
  });
}));

/* Who may approve and reject cleaning: the Super Admin, and nobody else.
   Everyone else sends completed work for review, so this is also what stops
   someone signing off their own job by editing the record on a phone. */
var APPROVER_ROLES = ['superadmin'];

/* Fields only an approver may change. `approved` is handled on its own,
   because sending a rejected job again legitimately clears it. */
var APPROVAL_FIELDS = ['approvedBy', 'approvedAt'];

function norm(v) { return v === undefined || v === '' ? null : v; }
function same(a, b) { return JSON.stringify(norm(a)) === JSON.stringify(norm(b)); }

function currentRows(table, rows) {
  return db.query('select id, data, updated_at from ' + table + ' where id = any($1::text[])',
    [rows.map(function (r) { return r.id; })]).then(function (r) {
    var out = {};
    r.rows.forEach(function (x) { out[x.id] = x; });
    return out;
  });
}

/* What someone without approval rights may do to a cleaning job:
     - create a new, pending job (every phone generates the week's jobs)
     - add or remove the photo, add notes, mark it done ("awaiting OK")
     - redo a rejected job and send it again
   and nothing else. Returns the reason for refusing, or null to allow. */
function jobChangeRefused(prev, next) {
  if (next.deleted === true) return 'only an approver can delete a job';
  if (next.approved === true || next.approved === false) {
    if (!prev || !same(prev.data.approved, next.approved)) return 'only an approver can approve or reject';
  }
  if (!prev) return next.status === 'pending' || next.status === 'completed' ? null : 'a new job must start as pending';

  var old = prev.data;
  if (old.approved === true) return 'the job is already approved';
  var resubmit = old.approved === false && norm(next.approved) === null && next.status === 'completed';
  if (!same(old.approved, next.approved) && !resubmit) return 'only an approver can approve or reject';
  for (var i = 0; i < APPROVAL_FIELDS.length; i++) {
    if (!same(old[APPROVAL_FIELDS[i]], next[APPROVAL_FIELDS[i]])) return 'only an approver can change ' + APPROVAL_FIELDS[i];
  }
  if (next.status === 'rejected' && old.status !== 'rejected') return 'only an approver can reject';
  /* The rejection reason stays until the job is sent again. */
  if (!same(old.reject, next.reject) && !(next.status === 'completed' && norm(next.reject) === null)) {
    return 'only an approver can change the rejection reason';
  }
  if (next.status === 'pending' && old.status !== 'pending') return 'only an approver can re-open a job';
  /* The cleaning name is never edited on the task record — a rename is stored
     once, group-wide, through /api/checklist/names, which checks the role
     itself. So `area` changing here is always wrong, and refusing it stops a
     phone rewriting the job it was handed. */
  if (!same(old.area, next.area)) return 'a cleaning job is renamed through the checklist, not on the job';
  if (!same(old.zone, next.zone)) return 'only an approver can move a job to another area';
  return null;
}

/* One statement for the whole batch. jsonb_to_recordset keeps every value
   a bound parameter — no SQL is built from the rows themselves. */
function writeRows(table, accepted, all) {
  if (!accepted.length) return Promise.resolve([]);
  var sql =
    'insert into ' + table + ' as t (id, loc, data, updated_at) ' +
    'select r.id, r.loc, r.data, now() from jsonb_to_recordset($1::jsonb) as r(id text, loc text, data jsonb) ' +
    'on conflict (id) do update set loc = excluded.loc, data = excluded.data, updated_at = now() ' +
    "where coalesce((excluded.data->>'_u')::numeric, 0) >= coalesce((t.data->>'_u')::numeric, 0) " +
    '  and ($2::boolean or t.loc = excluded.loc) ' +
    'returning id';

  /* Rows not saved because the stored copy was newer are not errors — the
     device will receive the newer copy on its next pull. */
  return db.query(sql, [JSON.stringify(accepted), all]).then(function (r) {
    return r.rows.map(function (x) { return x.id; });
  });
}

module.exports = router;
module.exports.jobChangeRefused = jobChangeRefused;
