'use strict';
/* ---------------------------------------------------------------------------
   Wiping the application's data — the Super Admin's last resort, for handing
   the app to a new group or starting a season again.

   What goes:
     bk_tasks             every cleaning job ever recorded, done or not
     bk_products          every label / expiry record
     bk_checklist         the services, including the ones that were added
     bk_checklist_audit   the history of those services
     bk_job_types         only the ones somebody added; the built-in ones stay
     app_users            every account except the Super Admin
     app_login_audit      sign-in history, which is otherwise a list of the
                          people who no longer exist
     app_rate_limits      short-lived counters
     the photo store      every uploaded photo

   What stays, and why:
     the schema           no table is dropped; the app must still run
     the Super Admin      including the password — otherwise nobody can sign
                          in afterwards and the app is finished, not wiped
     the built-in job types  Cleaning and Labelling are screens, not data:
                          without them a person cannot be given work at all
     app_admin_audit      the record that this happened. See schema.sql 4f.

   Credentials and refresh tokens are not deleted by name: both are
   `on delete cascade` from app_users, so removing an account takes its
   password hash and its sessions with it. The Super Admin's own session is
   left alone, so the person doing this is not signed out mid-wipe.

   All of it is one transaction. The photos are deleted before the commit, so
   a storage failure rolls the database back rather than leaving records that
   point at pictures which no longer exist. A photo store cannot itself be
   rolled back, so the one thing this cannot promise is a photo deleted just
   before a failure — that is stated where it is returned, not hidden.
   --------------------------------------------------------------------------- */

var db = require('../db/pool');
var config = require('../config/env');
var userModel = require('../models/userModel');

/* The phrase the caller has to send. Typed by hand in the browser, checked
   again here: a wipe should not be reachable by a mis-click or a replayed
   request, and the server is the only place that decision can be trusted. */
var CONFIRM_PHRASE = 'WIPE ALL DATA';

/* Tables emptied outright, children before parents. app_users is last and on
   its own because a row of it is kept. */
var EMPTY_WHOLE = [
  'bk_tasks',
  'bk_products',
  'bk_checklist_audit',
  'bk_checklist',
  'app_login_audit',
  'app_rate_limits'
];

/* One wipe at a time per process. A double-tap sends two requests; the second
   would otherwise count what the first had already deleted and report a wipe
   of nothing as a success. */
var running = false;

function countRows(client) {
  return client.query(
    'select' +
    ' (select count(*) from bk_tasks)                                  as tasks,' +
    ' (select count(*) from bk_products)                               as labels,' +
    ' (select count(*) from bk_checklist)                              as services,' +
    ' (select count(*) from bk_checklist_audit)                         as service_history,' +
    ' (select count(*) from bk_job_types where not builtin)             as job_types,' +
    ' (select count(*) from app_users where role <> $1)                 as accounts,' +
    ' (select count(*) from app_login_audit)                            as login_history',
    [userModel.SUPERADMIN]
  ).then(function (r) {
    var c = r.rows[0], out = {};
    Object.keys(c).forEach(function (k) { out[k] = Number(c[k]); });
    return out;
  });
}

/* Deletes every uploaded photo. Vercel Blob is the store the app is
   configured with; with no token there is nothing to delete, which is the
   normal case on a developer's machine. `@vercel/blob` is required here
   rather than at the top of the file for the same reason photoRoutes does
   it: the app still starts where the package is not installed. */
function wipePhotos() {
  if (!config.blobToken) return Promise.resolve({ photos: 0, store: 'none configured' });

  var blob = require('@vercel/blob');
  var deleted = 0;

  function page(cursor) {
    return blob.list({ token: config.blobToken, cursor: cursor, limit: 1000 }).then(function (res) {
      var urls = (res.blobs || []).map(function (b) { return b.url; });
      if (!urls.length) return res.hasMore ? page(res.cursor) : null;
      return blob.del(urls, { token: config.blobToken }).then(function () {
        deleted += urls.length;
        /* The cursor belongs to a listing of files that no longer exist, so
           start again from the beginning rather than paging on through it. */
        return page(null);
      });
    });
  }

  return page(null).then(function () { return { photos: deleted, store: 'vercel-blob' }; });
}

/* actor: { id, uid, role }, ip: string. Resolves with the summary, which is
   what the browser is shown and what the audit row keeps. */
function run(actor, ip) {
  if (running) {
    var busy = new Error('A wipe is already running');
    busy.status = 409; busy.code = 'WIPE_IN_PROGRESS'; busy.expected = true;
    return Promise.reject(busy);
  }
  running = true;

  return db.transaction(function (client) {
    var summary;
    return countRows(client)
      .then(function (counts) {
        summary = counts;
        /* Refuse to leave the app unreachable. This cannot normally happen —
           the caller is the Super Admin — but a wipe is the wrong moment to
           assume anything about the roster. */
        return client.query('select count(*) as n from app_users where role = $1 and coalesce(disabled, false) = false',
          [userModel.SUPERADMIN]);
      })
      .then(function (r) {
        if (Number(r.rows[0].n) < 1) {
          var err = new Error('There is no enabled Super Admin account to keep — nothing was wiped');
          err.status = 409; err.code = 'NO_SUPERADMIN'; err.expected = true;
          throw err;
        }
        return EMPTY_WHOLE.reduce(function (chain, table) {
          return chain.then(function () { return client.query('delete from ' + table); });
        }, Promise.resolve());
      })
      /* Added job types go; Cleaning and Labelling are part of the app. */
      .then(function () { return client.query('delete from bk_job_types where not builtin'); })
      /* Last, and the only table with a survivor. Credentials and sessions of
         everyone removed here go with them, by cascade. */
      .then(function () { return client.query('delete from app_users where role <> $1', [userModel.SUPERADMIN]); })
      .then(function () { return wipePhotos(); })
      .then(function (storage) {
        summary.photos = storage.photos;
        summary.store = storage.store;
        return client.query(
          'insert into app_admin_audit (action, actor_id, actor_uid, actor_role, ip, detail)' +
          " values ('wipe', $1, $2, $3, $4, $5::jsonb) returning at",
          [actor.id, actor.uid, actor.role, ip || null, JSON.stringify(summary)]
        );
      })
      .then(function (r) {
        /* The wipe's timestamp is also the epoch every device compares itself
           against, so it is part of the answer. */
        summary.at = r.rows[0].at.toISOString();
        return summary;
      });
  }).then(function (s) { running = false; return s; }, function (e) { running = false; throw e; });
}

/* The most recent wipe, as an ISO string, or '' where there has never been
   one. Devices carry this; see epochOf in syncRoutes. */
function lastWipeAt() {
  return db.query("select at from app_admin_audit where action = 'wipe' order by at desc limit 1")
    .then(function (r) { return r.rows.length ? r.rows[0].at.toISOString() : ''; });
}

module.exports = {
  run: run,
  lastWipeAt: lastWipeAt,
  CONFIRM_PHRASE: CONFIRM_PHRASE
};
