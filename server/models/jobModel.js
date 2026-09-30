'use strict';
/* ---------------------------------------------------------------------------
   Job Management — job types (bk_job_types), services (bk_checklist) and their
   history (bk_checklist_audit). The same tables the live site uses, so the
   jobs already set up there are read as they are.

   A service is keyed by its SLOT ('W12', 'M3', 'W100'). The app builds task
   ids from that slot ('T-AKA-2026-W38-W12'), so a slot is what a job IS and a
   name is only what it is called. Slots are never reused: deleting a service
   marks it deleted and keeps the row, so recorded work is never re-labelled.

   Built-in cleaning jobs live in index.html; a row for one of them holds only
   what the Super Admin changed. A service the Super Admin added has
   custom = true and carries everything about itself.
   --------------------------------------------------------------------------- */

var crypto = require('crypto');
var db = require('../db/pool');

function ms(v) { return v ? new Date(v).getTime() : null; }

/* ---------------------------------------------------------------------------
   Job types
   --------------------------------------------------------------------------- */
function toType(r) {
  return { id: r.id, name: r.name, description: r.description || '', active: r.active, builtin: r.builtin };
}

function listTypes() {
  return db.query('select * from bk_job_types order by sort asc, created_at asc, name asc')
    .then(function (r) { return r.rows.map(toType); });
}

function findType(id) {
  return db.query('select * from bk_job_types where id = $1', [id]).then(function (r) { return r.rows[0] ? toType(r.rows[0]) : null; });
}

function typeNameTaken(name, exceptId) {
  return db.query('select 1 from bk_job_types where lower(name) = lower($1) and id <> $2', [name, exceptId || ''])
    .then(function (r) { return r.rows.length > 0; });
}

/* 'Food Safety' -> 'food-safety', with a number added if that is taken. */
function newTypeId(name) {
  var base = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'type';
  return db.query("select id from bk_job_types where id = $1 or id like $1 || '-%'", [base]).then(function (r) {
    var taken = {}; r.rows.forEach(function (x) { taken[x.id] = 1; });
    if (!taken[base]) return base;
    for (var n = 2; n < 1000; n++) if (!taken[base + '-' + n]) return base + '-' + n;
    return base + '-' + crypto.randomBytes(3).toString('hex');
  });
}

function createType(fields, by) {
  return newTypeId(fields.name).then(function (id) {
    return db.query(
      'insert into bk_job_types (id, name, description, active, sort, created_by) ' +
      'values ($1, $2, $3, $4, (select coalesce(max(sort), 0) + 10 from bk_job_types), $5) returning *',
      [id, fields.name, fields.description || null, fields.active !== false, by.id]
    ).then(function (r) { return toType(r.rows[0]); });
  });
}

function updateType(id, patch, by) {
  var sets = [], params = [id], i = 2;
  if (patch.name !== undefined) { sets.push('name = $' + i++); params.push(patch.name); }
  if (patch.description !== undefined) { sets.push('description = $' + i++); params.push(patch.description || null); }
  if (patch.active !== undefined) { sets.push('active = $' + i++); params.push(!!patch.active); }
  if (!sets.length) return findType(id);
  sets.push('edited_by = $' + i++); params.push(by.id);
  sets.push('edited_at = now()', 'updated_at = now()');
  return db.query('update bk_job_types set ' + sets.join(', ') + ' where id = $1 returning *', params)
    .then(function (r) { return r.rows[0] ? toType(r.rows[0]) : null; });
}

/* Services still set up under a type (deleted ones do not count). */
function servicesUsingType(id) {
  return db.query('select count(*)::int as n from bk_checklist where job_type = $1 and deleted = false', [id])
    .then(function (r) { return r.rows[0].n; });
}

function deleteType(id) {
  return db.query('delete from bk_job_types where id = $1 and builtin = false', [id]).then(function (r) { return r.rowCount; });
}

function existingTypeIds(ids) {
  if (!ids || !ids.length) return Promise.resolve([]);
  return db.query('select id from bk_job_types where id = any($1::text[])', [ids])
    .then(function (r) { return r.rows.map(function (x) { return x.id; }); });
}

/* ---------------------------------------------------------------------------
   Services (bk_checklist)
   --------------------------------------------------------------------------- */

/* Row -> the object the app keeps in DB.checklist[tkey]. */
function toItem(r) {
  var locs = Array.isArray(r.locs) ? r.locs : [];
  var people = Array.isArray(r.assignees) ? r.assignees : (r.assigned_to ? [r.assigned_to] : []);
  var out = {
    tkey: r.tkey, custom: r.custom, deleted: r.deleted, enabled: r.enabled,
    jobType: r.job_type || 'cleaning',
    locs: locs, loc: r.loc || (locs.length === 1 ? locs[0] : null),
    assignees: people, assignedTo: r.assigned_to || people[0] || null,
    atTime: r.at_time || null, endDate: r.end_date || null,
    prevName: r.prev_name || null,
    createdBy: r.created_by || null, editedBy: r.edited_by || null, editedAt: ms(r.edited_at),
    updatedAt: ms(r.updated_at)
  };
  /* A built-in job only carries what was changed about it; everything else
     comes from the list in the app, so unset fields are left out. */
  if (r.name != null) out.name = r.name;
  if (r.zone != null) out.zone = r.zone;
  if (r.freq != null) { out.freq = r.freq; out.day = r.day == null ? null : r.day; }
  else if (r.day != null) out.day = r.day;
  return out;
}

function listItems() {
  return db.query('select * from bk_checklist order by tkey').then(function (r) {
    var out = {};
    r.rows.forEach(function (x) { out[x.tkey] = toItem(x); });
    return out;
  });
}

function findRow(tkey, client) {
  return (client || db).query('select * from bk_checklist where tkey = $1', [tkey]).then(function (r) { return r.rows[0] || null; });
}
function findItem(tkey) { return findRow(tkey).then(function (r) { return r ? toItem(r) : null; }); }

/* A fresh slot for an added service: 'W' (or 'M' for monthly) and a number
   past every slot ever handed out, and past the built-in list's. The lock
   stops two admins adding at the same moment getting the same slot. */
function nextSlot(client, freq) {
  return client.query('lock table bk_checklist in share row exclusive mode').then(function () {
    return client.query("select coalesce(max(substring(tkey from 2)::int), 99) as m from bk_checklist where custom");
  }).then(function (r) {
    var n = Math.max(99, r.rows[0].m) + 1;
    if (n > 999) { var e = new Error('No more job slots are free'); e.status = 409; e.code = 'NO_SLOTS'; throw e; }
    return (freq === 'M' ? 'M' : 'W') + n;
  });
}

function addItem(f, by) {
  return db.transaction(function (client) {
    return nextSlot(client, f.freq).then(function (tkey) {
      var locs = f.locs || (f.loc ? [f.loc] : []);
      var people = f.assignees || [];
      return client.query(
        'insert into bk_checklist (tkey, name, zone, freq, day, loc, custom, deleted, enabled, job_type, ' +
        '  assigned_to, assignees, at_time, end_date, locs, created_by) ' +
        'values ($1, $2, $3, $4, $5, $6, true, false, true, $7, $8, $9, $10, $11, $12, $13) returning *',
        [tkey, f.name, f.zone, f.freq, f.freq === 'W' && f.day != null ? f.day : null,
          locs.length === 1 ? locs[0] : null, f.jobType || 'cleaning',
          people[0] || null, JSON.stringify(people), f.atTime || null, f.endDate || null,
          JSON.stringify(locs), by.id]
      ).then(function (r) {
        return audit(client, 'add', tkey, null, f.name, by).then(function () { return toItem(r.rows[0]); });
      });
    });
  });
}

/* Column for each field the app may change. */
var COLS = { name: 'name', zone: 'zone', freq: 'freq', day: 'day', enabled: 'enabled', deleted: 'deleted',
             jobType: 'job_type', atTime: 'at_time', endDate: 'end_date' };

/* Applies a change to a service, creating the row for a built-in job the
   first time it is changed. `builtInName` is what the app calls a built-in
   job that has never been renamed, for the history. */
function updateItem(tkey, patch, builtInName, by) {
  return db.transaction(function (client) {
    return findRow(tkey, client).then(function (cur) {
      var prevName = (cur && cur.name) || builtInName || null;
      var ensure = cur ? Promise.resolve() :
        client.query('insert into bk_checklist (tkey, created_by) values ($1, $2)', [tkey, by.id]);
      return ensure.then(function () {
        var sets = [], params = [tkey], i = 2;
        Object.keys(COLS).forEach(function (k) {
          if (patch[k] === undefined) return;
          sets.push(COLS[k] + ' = $' + i++); params.push(patch[k]);
        });
        if (patch.locs !== undefined) {
          sets.push('locs = $' + i++); params.push(JSON.stringify(patch.locs));
          sets.push('loc = $' + i++); params.push(patch.locs.length === 1 ? patch.locs[0] : null);
        } else if (patch.loc !== undefined) {
          sets.push('loc = $' + i++); params.push(patch.loc);
          sets.push('locs = $' + i++); params.push(JSON.stringify(patch.loc ? [patch.loc] : []));
        }
        if (patch.assignees !== undefined) {
          sets.push('assignees = $' + i++); params.push(JSON.stringify(patch.assignees));
          sets.push('assigned_to = $' + i++); params.push(patch.assignees[0] || null);
        }
        /* A frequency change without a weekday clears a pinned weekday that
           no longer means anything. */
        if (patch.freq !== undefined && patch.freq !== 'W' && patch.day === undefined) sets.push('day = null');
        var renamed = patch.name !== undefined && patch.name !== prevName;
        if (renamed) { sets.push('prev_name = $' + i++); params.push(prevName); }
        sets.push('edited_by = $' + i++); params.push(by.id);
        sets.push('edited_at = now()', 'updated_at = now()');
        return client.query('update bk_checklist set ' + sets.join(', ') + ' where tkey = $1 returning *', params);
      }).then(function (r) {
        var row = r.rows[0];
        var action = patch.deleted === false && cur && cur.deleted ? 'restore'
          : patch.name !== undefined && patch.name !== prevName ? 'rename' : 'edit';
        return audit(client, action, tkey, prevName, row.name || prevName, by).then(function () { return toItem(row); });
      });
    });
  });
}

function setDeleted(tkey, deleted, builtInName, by) {
  return db.transaction(function (client) {
    return findRow(tkey, client).then(function (cur) {
      var name = (cur && cur.name) || builtInName || tkey;
      var ensure = cur ? Promise.resolve() :
        client.query('insert into bk_checklist (tkey, created_by) values ($1, $2)', [tkey, by.id]);
      return ensure.then(function () {
        /* Putting a job back means scheduling it again. */
        return client.query(
          'update bk_checklist set deleted = $2, enabled = case when $2 then enabled else true end, ' +
          '  edited_by = $3, edited_at = now(), updated_at = now() where tkey = $1 returning *',
          [tkey, deleted, by.id]);
      }).then(function (r) {
        return audit(client, deleted ? 'delete' : 'restore', tkey, name, name, by).then(function () { return toItem(r.rows[0]); });
      });
    });
  });
}

function audit(client, action, tkey, prevName, newName, by) {
  return client.query(
    'insert into bk_checklist_audit (action, tkey, prev_name, new_name, user_id, user_name, user_role) values ($1, $2, $3, $4, $5, $6, $7)',
    [action, tkey, prevName, newName, by.id, by.name || null, by.role || null]
  );
}

function listHistory(limit) {
  return db.query('select * from bk_checklist_audit order by at desc, id desc limit $1', [limit || 300]).then(function (r) {
    return r.rows.map(function (x) {
      return { tkey: x.tkey, action: x.action, prevName: x.prev_name, newName: x.new_name,
               byId: x.user_id, byName: x.user_name, at: new Date(x.at).toISOString() };
    });
  });
}

/* ---------------------------------------------------------------------------
   Sync epoch — the time of the latest wipe ('' if there never was one). A
   device that last synced before it drops its copy of the records instead of
   uploading them back.
   --------------------------------------------------------------------------- */
function getEpoch(client) {
  return (client || db).query("select max(at) as at from app_admin_audit where action = 'wipe'")
    .then(function (r) { return r.rows[0].at ? new Date(r.rows[0].at).toISOString() : ''; });
}

module.exports = {
  listTypes: listTypes, findType: findType, typeNameTaken: typeNameTaken, createType: createType,
  updateType: updateType, deleteType: deleteType, servicesUsingType: servicesUsingType,
  existingTypeIds: existingTypeIds,
  listItems: listItems, findItem: findItem, addItem: addItem, updateItem: updateItem, setDeleted: setDeleted,
  listHistory: listHistory,
  getEpoch: getEpoch
};
