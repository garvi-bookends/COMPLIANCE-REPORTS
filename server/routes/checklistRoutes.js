'use strict';
/* ---------------------------------------------------------------------------
   /api/checklist — managing the cleaning checklist.

   The built-in checklist is a fixed list inside the app. A job is identified
   by its slot in that list — 'W12' is the 13th weekly job, 'M3' the 4th
   monthly one — which is also the tail of every task id generated from it
   ('T-AKA-2026-W38-W12'). The slot is what a job really is; its name is only
   what it is called this week.

   This route stores the CHANGES to that list: jobs renamed, jobs deleted and
   jobs added. Everything else comes from the built-in list in the app.

   Endpoints:
     GET    /api/checklist/items          the changes, for any signed-in user
     GET    /api/checklist/items/history  what was changed, by whom and when
     POST   /api/checklist/items          add a job
     PATCH  /api/checklist/items/:tkey    rename a job
     DELETE /api/checklist/items/:tkey    stop a job (keeps recorded work)
     POST   /api/checklist/items/:tkey/restore   put a stopped job back

   Only the Super Admin may change anything. There is exactly one such
   account, enforced by a unique index on app_users. The app hides these
   controls from everyone else, but that is only tidiness — the check below
   is the one that decides.

   Nothing here can write to a task record. That is deliberate: it is what
   guarantees that renaming or deleting a job cannot disturb a recorded
   job's due date, status, photo, approval or rejection reason.
   --------------------------------------------------------------------------- */

var express = require('express');
var db = require('../db/pool');
var requireAuth = require('../middleware/requireAuth');
var asyncHandler = require('../middleware/errorHandler').asyncHandler;

var router = express.Router();

var TKEY_RE = /^[WM][0-9]{1,3}$/;
var NAME_MAX = 120;
var ZONE_MAX = 60;
var HISTORY_LIMIT = 200;

/* Slots below this belong to the built-in checklist, which grows only when a
   new version of the app ships. Jobs added here start above it, so the two
   can never land on the same slot. */
var CUSTOM_BASE = 500;
var CUSTOM_MAX = 999;              // the slot is 3 digits — see the tkey check

router.use(requireAuth);

/* Collapses runs of whitespace and trims the ends, so a name cannot be padded
   out to look different from an identical one, and a stray double space typed
   on a phone does not become part of the record. */
function tidy(v) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
}

function superadminOnly(req, res, next) {
  if (req.auth.role !== 'superadmin') {
    return res.status(403).json({
      error: 'Only the Super Admin can change the cleaning checklist',
      code: 'FORBIDDEN'
    });
  }
  next();
}

function badRequest(res, msg) {
  return res.status(400).json({ error: msg, code: 'VALIDATION_ERROR' });
}

function rowToItem(x) {
  return {
    tkey: x.tkey,
    assignedTo: x.assigned_to || null,
    atTime: x.at_time || null,
    endDate: x.end_date || null,
    jobType: x.job_type || 'cleaning',
    name: x.name,
    zone: x.zone,
    freq: x.freq,
    day: x.day,
    loc: x.loc,
    custom: x.custom,
    enabled: x.enabled === true,
    deleted: x.deleted,
    prevName: x.prev_name,
    by: x.edited_by || x.created_by,
    byName: x.edited_by_name || x.created_by_name,
    at: (x.edited_at || x.created_at) ? (x.edited_at || x.created_at).toISOString() : null
  };
}

var SELECT_ITEMS =
  'select c.*, e.name as edited_by_name, k.name as created_by_name ' +
  '  from bk_checklist c ' +
  '  left join app_users e on e.id = c.edited_by ' +
  '  left join app_users k on k.id = c.created_by';

/* Writes the audit row. The acting person's name is read from their account
   rather than taken from the request, so the trail cannot be signed with
   someone else's name. */
function audit(client, action, tkey, prevName, newName, auth) {
  return client.query(
    'insert into bk_checklist_audit (action, tkey, prev_name, new_name, user_id, user_name, user_role) ' +
    'select $1, $2, $3, $4, $5, u.name, $6 from app_users u where u.id = $5',
    [action, tkey, prevName, newName, auth.id, auth.role]
  );
}

/* ---------------------------------------------------------------------------
   GET /api/checklist/items

   Readable by everyone signed in, including Kitchen Staff and the Auditor:
   they must see the renamed, added and stopped jobs. They just cannot change
   them.
   --------------------------------------------------------------------------- */
router.get('/items', asyncHandler(function (req, res) {
  return db.query(SELECT_ITEMS).then(function (r) {
    var items = {};
    r.rows.forEach(function (x) { items[x.tkey] = rowToItem(x); });
    return res.json({ items: items });
  });
}));

/* ---------------------------------------------------------------------------
   GET /api/checklist/items/history[?tkey=W12]
   --------------------------------------------------------------------------- */
router.get('/items/history', asyncHandler(function (req, res) {
  var tkey = typeof req.query.tkey === 'string' && TKEY_RE.test(req.query.tkey) ? req.query.tkey : null;
  var sql = 'select at, action, tkey, prev_name, new_name, user_id, user_name, user_role from bk_checklist_audit' +
            (tkey ? ' where tkey = $1' : '') + ' order by at desc limit ' + HISTORY_LIMIT;

  return db.query(sql, tkey ? [tkey] : []).then(function (r) {
    return res.json({
      history: r.rows.map(function (x) {
        return {
          at: x.at.toISOString(), action: x.action, tkey: x.tkey,
          prevName: x.prev_name, newName: x.new_name,
          by: x.user_id, byName: x.user_name, byRole: x.user_role
        };
      })
    });
  });
}));

/* ---------------------------------------------------------------------------
   POST /api/checklist/items   { name, zone, freq, day, loc }

   Adds a job to the checklist. The slot is allocated HERE, not by the app:
   two Super Admin devices adding a job at the same moment must not be handed
   the same slot, so the number comes from the table inside a transaction.
   --------------------------------------------------------------------------- */
router.post('/items', superadminOnly, asyncHandler(function (req, res) {
  var body = req.body || {};

  var name = tidy(body.name);
  if (!name) return badRequest(res, 'Enter a cleaning name');
  if (name.length > NAME_MAX) return badRequest(res, 'Keep the cleaning name to ' + NAME_MAX + ' characters or fewer');

  var zone = tidy(body.zone);
  if (!zone) return badRequest(res, 'Choose an area');
  if (zone.length > ZONE_MAX) return badRequest(res, 'That area name is too long');

  var freq = tidy(body.freq).toUpperCase();
  if (['D', 'W', 'M'].indexOf(freq) === -1) return badRequest(res, 'Choose how often this job runs');

  /* A weekly job may be pinned to one weekday; a monthly one is not. */
  var day = null;
  if (freq === 'W' && body.day !== null && body.day !== undefined && body.day !== '') {
    day = Number(body.day);
    if (!isFinite(day) || day < 0 || day > 6 || Math.floor(day) !== day) return badRequest(res, 'Choose a valid day');
  }

  var loc = body.loc === null || body.loc === undefined || body.loc === '' ? null : String(body.loc).slice(0, 40);

  /* Which job type this service belongs to. Cleaning when nothing is said, so
     every existing caller keeps working. */
  var assignedTo = tidy(body.assignedTo) ? tidy(body.assignedTo).slice(0, 40) : null;

  /* A time of day, and a date the job stops being scheduled. Both optional. */
  var atTime = tidy(body.atTime);
  if (atTime && !/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(atTime)) return badRequest(res, 'Enter a time as HH:MM');
  var endDate = tidy(body.endDate);
  if (endDate && !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(endDate)) return badRequest(res, 'Enter an end date as YYYY-MM-DD');

  var jobType = tidy(body.jobType) || 'cleaning';
  if (!/^[a-z0-9][a-z0-9-]{0,38}$/.test(jobType)) return badRequest(res, 'Unknown job type');

  return db.transaction(function (client) {
    /* Lock the table for the moment it takes to pick the next slot, so two
       simultaneous adds cannot both read the same highest number. */
    return client.query('lock table bk_checklist in exclusive mode').then(function () {
      return client.query(
        "select coalesce(max(substring(tkey from 2)::int), $1 - 1) as top from bk_checklist " +
        " where custom and substring(tkey from 1 for 1) = $2 and substring(tkey from 2)::int >= $1",
        [CUSTOM_BASE, freq]
      );
    }).then(function (r) {
      var next = Number(r.rows[0].top) + 1;
      if (next > CUSTOM_MAX) {
        var e = new Error('No room left for another cleaning job');
        e.status = 400;
        throw e;
      }
      var tkey = freq + next;
      return client.query(
        'insert into bk_checklist (tkey, name, zone, freq, day, loc, job_type, assigned_to, at_time, end_date, custom, enabled, created_by, created_at, updated_at) ' +
        'values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, true, true, $11, now(), now())',
        [tkey, name, zone, freq, day, loc, jobType, assignedTo, atTime || null, endDate || null, req.auth.id]
      ).then(function () {
        return audit(client, 'add', tkey, null, name, req.auth);
      }).then(function () {
        return client.query(SELECT_ITEMS + ' where c.tkey = $1', [tkey]);
      });
    });
  }).then(function (r) {
    res.status(201).json({ item: rowToItem(r.rows[0]) });
  }, function (err) {
    if (err.status === 400) return badRequest(res, err.message);
    throw err;
  });
}));

/* ---------------------------------------------------------------------------
   PATCH /api/checklist/items/:tkey
     { name?, zone?, freq?, day?, loc?, atTime?, endDate?, deleted?, builtInName? }

   Edits one service, built-in or added. Any field may be sent on its own —
   the app sends exactly the one that was edited in place.

   A built-in service has no row here until it is first changed, so this is an
   upsert. Whatever is not being changed keeps the value already stored, and a
   built-in falls back to the list inside the app, so a row written here can
   never be half a service.

   `builtInName` is what the app currently shows for a service that has never
   been edited, so the audit trail reads properly for the first change.
   --------------------------------------------------------------------------- */
router.patch('/items/:tkey', superadminOnly, asyncHandler(function (req, res) {
  var tkey = req.params.tkey;
  if (!TKEY_RE.test(tkey)) return badRequest(res, 'Unknown cleaning job');

  var body = req.body || {};
  var has = function (k) { return Object.prototype.hasOwnProperty.call(body, k); };
  var patch = {}, err = null;

  if (has('name')) {
    var name = tidy(body.name);
    if (!name) err = 'The cleaning name cannot be empty';
    else if (name.length > NAME_MAX) err = 'Keep the cleaning name to ' + NAME_MAX + ' characters or fewer';
    else patch.name = name;
  }
  if (!err && has('zone')) {
    var zone = tidy(body.zone);
    if (!zone) err = 'The area cannot be empty';
    else if (zone.length > ZONE_MAX) err = 'That area name is too long';
    else patch.zone = zone;
  }
  if (!err && has('freq')) {
    var freq = tidy(body.freq).toUpperCase();
    if (['D', 'W', 'M'].indexOf(freq) === -1) err = 'Choose how often this job runs';
    else {
      patch.freq = freq;
      /* Only a weekly job can be pinned to a weekday. Changing to daily or
         monthly clears the pin rather than leaving a stale one behind. */
      if (freq !== 'W' && !has('day')) patch.day = null;
    }
  }
  if (!err && has('day')) {
    if (body.day === null || body.day === '' || body.day === undefined) patch.day = null;
    else {
      var day = Number(body.day);
      if (!isFinite(day) || day < 0 || day > 6 || Math.floor(day) !== day) err = 'Choose a valid day';
      else patch.day = day;
    }
  }
  if (!err && has('loc')) {
    patch.loc = body.loc === null || body.loc === '' || body.loc === undefined ? null : String(body.loc).slice(0, 40);
  }
  if (!err && has('assignedTo')) {
    /* Empty means nobody in particular — whoever is on shift picks it up. */
    patch.assigned_to = body.assignedTo === null || body.assignedTo === '' || body.assignedTo === undefined
      ? null : String(body.assignedTo).slice(0, 40);
  }
  if (!err && has('atTime')) {
    var atTime = tidy(body.atTime);
    if (atTime && !/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(atTime)) err = 'Enter a time as HH:MM';
    else patch.at_time = atTime || null;
  }
  if (!err && has('endDate')) {
    var endDate = tidy(body.endDate);
    if (endDate && !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(endDate)) err = 'Enter an end date as YYYY-MM-DD';
    else patch.end_date = endDate || null;
  }
  if (!err && has('deleted')) patch.deleted = !!body.deleted;
  if (!err && has('enabled')) patch.enabled = !!body.enabled;

  if (err) return badRequest(res, err);
  if (!Object.keys(patch).length) return badRequest(res, 'Nothing to change');

  var builtIn = tidy(body.builtInName).slice(0, NAME_MAX) || null;

  return db.transaction(function (client) {
    return client.query('select * from bk_checklist where tkey = $1', [tkey]).then(function (r) {
      var row = r.rows.length ? r.rows[0] : null;
      var prev = (row && row.name) || builtIn;

      /* A rename is the only change with a before-and-after worth recording in
         the name columns; the rest are recorded as an edit of the service. */
      var renaming = patch.name !== undefined && patch.name !== prev;
      if (patch.name !== undefined && !renaming && Object.keys(patch).length === 1) {
        return { unchanged: true, tkey: tkey };
      }

      var cols = ['tkey', 'name', 'zone', 'freq', 'day', 'loc', 'job_type',
                  'assigned_to', 'at_time', 'end_date', 'custom', 'deleted', 'enabled',
                  'prev_name', 'edited_by', 'edited_at', 'updated_at'];
      var pick = function (col, fallback) {
        return Object.prototype.hasOwnProperty.call(patch, col) ? patch[col]
          : (row ? row[col] : fallback);
      };
      var vals = [
        tkey,
        pick('name', builtIn),
        pick('zone', null),
        pick('freq', null),
        pick('day', null),
        pick('loc', null),
        row ? row.job_type : 'cleaning',
        pick('assigned_to', null),
        pick('at_time', null),
        pick('end_date', null),
        row ? row.custom : false,
        pick('deleted', false),
        pick('enabled', false),
        renaming ? prev : (row ? row.prev_name : null),
        req.auth.id
      ];

      return client.query(
        'insert into bk_checklist (' + cols.join(', ') + ') ' +
        'values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15, now(), now()) ' +
        'on conflict (tkey) do update set ' +
        cols.slice(1, 15).map(function (c, i) { return c + ' = $' + (i + 2); }).join(', ') +
        ', edited_at = now(), updated_at = now()',
        vals
      ).then(function () {
        return audit(client, renaming ? 'rename' : 'edit', tkey, prev,
          patch.name !== undefined ? patch.name : prev, req.auth);
      }).then(function () {
        return client.query(SELECT_ITEMS + ' where c.tkey = $1', [tkey]);
      }).then(function (q) {
        return { unchanged: false, item: rowToItem(q.rows[0]) };
      });
    });
  }).then(function (out) { res.json(out); });
}));

/* ---------------------------------------------------------------------------
   DELETE /api/checklist/items/:tkey

   Stops the job. The row is flagged, never removed: the slot has to stay
   reserved because task ids are built from it, and reusing it would silently
   re-label work recorded years ago. The cleaning already done against this
   job keeps its photos, approvals and history untouched — this route cannot
   write to a task record at all.
   --------------------------------------------------------------------------- */
router.delete('/items/:tkey', superadminOnly, asyncHandler(function (req, res) {
  var tkey = req.params.tkey;
  if (!TKEY_RE.test(tkey)) return badRequest(res, 'Unknown cleaning job');

  var builtIn = tidy(req.query.builtInName).slice(0, NAME_MAX) || null;

  return db.transaction(function (client) {
    return client.query('select name from bk_checklist where tkey = $1', [tkey]).then(function (r) {
      var prev = r.rows.length && r.rows[0].name ? r.rows[0].name : builtIn;
      return client.query(
        'insert into bk_checklist (tkey, name, deleted, edited_by, edited_at, updated_at) ' +
        'values ($1, $2, true, $3, now(), now()) ' +
        'on conflict (tkey) do update set deleted = true, edited_by = excluded.edited_by, ' +
        '  edited_at = now(), updated_at = now()',
        [tkey, prev, req.auth.id]
      ).then(function () {
        return audit(client, 'delete', tkey, prev, prev, req.auth);
      }).then(function () {
        return client.query(SELECT_ITEMS + ' where c.tkey = $1', [tkey]);
      });
    });
  }).then(function (r) { res.json({ item: rowToItem(r.rows[0]) }); });
}));

/* ---------------------------------------------------------------------------
   POST /api/checklist/items/:tkey/restore

   Undoes a delete. Worth having: a job stopped by mistake would otherwise be
   unrecoverable for a built-in job, since its slot can never be re-added.
   --------------------------------------------------------------------------- */
router.post('/items/:tkey/restore', superadminOnly, asyncHandler(function (req, res) {
  var tkey = req.params.tkey;
  if (!TKEY_RE.test(tkey)) return badRequest(res, 'Unknown cleaning job');

  return db.transaction(function (client) {
    return client.query('select name from bk_checklist where tkey = $1', [tkey]).then(function (r) {
      if (!r.rows.length) return null;
      return client.query(
        'update bk_checklist set deleted = false, edited_by = $2, edited_at = now(), updated_at = now() where tkey = $1',
        [tkey, req.auth.id]
      ).then(function () {
        return audit(client, 'restore', tkey, r.rows[0].name, r.rows[0].name, req.auth);
      }).then(function () {
        return client.query(SELECT_ITEMS + ' where c.tkey = $1', [tkey]);
      });
    });
  }).then(function (r) {
    if (!r) return res.status(404).json({ error: 'That cleaning job is not stopped', code: 'NOT_FOUND' });
    res.json({ item: rowToItem(r.rows[0]) });
  });
}));

/* ---------------------------------------------------------------------------
   Job types — the headings the group's work sits under.

     GET    /api/checklist/types        every type, for any signed-in user
     POST   /api/checklist/types        add one
     PATCH  /api/checklist/types/:id    rename, re-describe, activate/deactivate
     DELETE /api/checklist/types/:id    remove one that has no services

   Only the Super Admin may change them. A type that still has services is
   never deleted — switching it off is what "stop using this" means, and that
   keeps the work already recorded against it readable.
   --------------------------------------------------------------------------- */

var TYPE_ID_RE = /^[a-z0-9][a-z0-9-]{0,38}$/;
var TYPE_NAME_MAX = 60;
var TYPE_DESC_MAX = 300;

function typeRow(x) {
  return {
    id: x.id, name: x.name, description: x.description,
    active: x.active, builtin: x.builtin, sort: x.sort,
    services: x.services === undefined ? undefined : Number(x.services)
  };
}

/* 'Food Safety' -> 'food-safety'. The id is what every service points at, so
   it is derived once here and never changes afterwards. */
function slugify(name) {
  return String(name || '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 39);
}

var SELECT_TYPES =
  'select t.*, (select count(*) from bk_checklist c where c.job_type = t.id and not c.deleted) as services ' +
  '  from bk_job_types t';

router.get('/types', asyncHandler(function (req, res) {
  return db.query(SELECT_TYPES + ' order by t.sort, t.name').then(function (r) {
    return res.json({ types: r.rows.map(typeRow) });
  });
}));

router.post('/types', superadminOnly, asyncHandler(function (req, res) {
  var body = req.body || {};
  var name = tidy(body.name);
  if (!name) return badRequest(res, 'Enter a job type name');
  if (name.length > TYPE_NAME_MAX) return badRequest(res, 'Keep the name to ' + TYPE_NAME_MAX + ' characters or fewer');

  var description = tidy(body.description);
  if (description.length > TYPE_DESC_MAX) return badRequest(res, 'Keep the description to ' + TYPE_DESC_MAX + ' characters or fewer');

  var id = slugify(body.id || name);
  if (!TYPE_ID_RE.test(id)) return badRequest(res, 'That name cannot be used — try plain letters and numbers');

  var active = body.active === undefined ? true : !!body.active;

  return db.query('select 1 from bk_job_types where id = $1', [id]).then(function (r) {
    if (r.rows.length) return badRequest(res, 'A job type called “' + name + '” already exists');
    return db.query(
      'insert into bk_job_types (id, name, description, active, builtin, sort, created_by, created_at, updated_at) ' +
      'values ($1, $2, $3, $4, false, ' +
      '  (select coalesce(max(sort), 0) + 10 from bk_job_types), $5, now(), now())',
      [id, name, description || null, active, req.auth.id]
    ).then(function () {
      return db.query(SELECT_TYPES + ' where t.id = $1', [id]);
    }).then(function (q) {
      res.status(201).json({ type: typeRow(q.rows[0]) });
    });
  });
}));

router.patch('/types/:id', superadminOnly, asyncHandler(function (req, res) {
  var id = req.params.id;
  if (!TYPE_ID_RE.test(id)) return badRequest(res, 'Unknown job type');
  var body = req.body || {};

  var sets = [], params = [id], i = 2;
  if (body.name !== undefined) {
    var name = tidy(body.name);
    if (!name) return badRequest(res, 'The job type name cannot be empty');
    if (name.length > TYPE_NAME_MAX) return badRequest(res, 'Keep the name to ' + TYPE_NAME_MAX + ' characters or fewer');
    sets.push('name = $' + i++); params.push(name);
  }
  if (body.description !== undefined) {
    var desc = tidy(body.description);
    if (desc.length > TYPE_DESC_MAX) return badRequest(res, 'Keep the description to ' + TYPE_DESC_MAX + ' characters or fewer');
    sets.push('description = $' + i++); params.push(desc || null);
  }
  if (body.active !== undefined) { sets.push('active = $' + i++); params.push(!!body.active); }
  if (!sets.length) return badRequest(res, 'Nothing to change');

  sets.push('edited_by = $' + i++); params.push(req.auth.id);
  sets.push('edited_at = now()', 'updated_at = now()');

  return db.query('update bk_job_types set ' + sets.join(', ') + ' where id = $1', params).then(function (r) {
    if (!r.rowCount) return res.status(404).json({ error: 'That job type no longer exists', code: 'NOT_FOUND' });
    return db.query(SELECT_TYPES + ' where t.id = $1', [id]).then(function (q) {
      res.json({ type: typeRow(q.rows[0]) });
    });
  });
}));

router.delete('/types/:id', superadminOnly, asyncHandler(function (req, res) {
  var id = req.params.id;
  if (!TYPE_ID_RE.test(id)) return badRequest(res, 'Unknown job type');

  return db.query('select builtin from bk_job_types where id = $1', [id]).then(function (r) {
    if (!r.rows.length) return res.status(404).json({ error: 'That job type no longer exists', code: 'NOT_FOUND' });
    if (r.rows[0].builtin) {
      return badRequest(res, 'Cleaning is built into the app and cannot be removed. Switch it off instead.');
    }
    /* Services point at the type by id. Removing a type out from under them
       would orphan work already recorded, so it has to be emptied first —
       or simply switched off, which is what people usually mean. */
    return db.query('select count(*)::int n from bk_checklist where job_type = $1 and not deleted', [id]).then(function (c) {
      if (c.rows[0].n > 0) {
        return badRequest(res, 'That job type still has ' + c.rows[0].n + ' service' + (c.rows[0].n === 1 ? '' : 's') +
          '. Delete them first, or switch the job type off instead.');
      }
      return db.query('delete from bk_job_types where id = $1', [id]).then(function () {
        res.json({ deleted: id });
      });
    });
  });
}));

module.exports = router;
