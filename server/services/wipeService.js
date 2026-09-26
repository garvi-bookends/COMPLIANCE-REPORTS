'use strict';
/* ---------------------------------------------------------------------------
   Wiping the recorded work — the Super Admin's way of starting a season
   again without setting the app up from scratch.

   The line it draws is between what was RECORDED and what was SET UP. The
   records go; the setup stays, because the setup is a day's work to rebuild
   and none of it is what anybody wants rid of.

   What goes — the three screens that fill up:
     bk_tasks             every cleaning job ever recorded, done or not
     bk_products          every label and every expiry record (one table
                          holds both: a label carries the expiry date)
     the photo store      every uploaded photo, which belongs to those records

   What stays, and why:
     the schema           no table is dropped; the app must still run
     every account        and every password. The work is what gets wiped, not
                          the people who did it: rebuilding a roster of twelve
                          by hand, and handing out new passwords, is a worse
                          day than the one that made somebody want a clean
                          slate. Nobody is signed out either — the sessions
                          are left where they are.
     bk_checklist         the services, who they are given to, what they are
                          called: the setup the Super Admin built
     bk_checklist_audit   its history, worth keeping because the services are
     bk_job_types         all of them, added ones included
     app_login_audit      the sign-in trail of those accounts, which is worth
                          keeping precisely because the accounts are
     app_admin_audit      the record that this happened. See schema.sql 4f.

   The week's empty jobs are generated again from the services, as they are
   every week. That is the app working, not the wipe failing.

   All of it is one transaction. The photos are deleted before the commit, so
   a storage failure rolls the database back rather than leaving records that
   point at pictures which no longer exist. A photo store cannot itself be
   rolled back, so the one thing this cannot promise is a photo deleted just
   before a failure — that is stated where it is returned, not hidden.
   --------------------------------------------------------------------------- */

var db = require('../db/pool');
var config = require('../config/env');

/* The phrase the caller has to send. Typed by hand in the browser, checked
   again here: a wipe should not be reachable by a mis-click or a replayed
   request, and the server is the only place that decision can be trusted. */
var CONFIRM_PHRASE = 'WIPE ALL DATA';

/* Emptied outright, and nothing else is touched. Neither is a parent of the
   other, so the order is only the order they read in. */
var EMPTY_WHOLE = [
  'bk_tasks',
  'bk_products'
];

/* One wipe at a time per process. A double-tap sends two requests; the second
   would otherwise count what the first had already deleted and report a wipe
   of nothing as a success. */
var running = false;

function countRows(client) {
  return client.query(
    'select' +
    /* Removed */
    ' (select count(*) from bk_tasks)      as tasks,' +
    ' (select count(*) from bk_products)   as labels,' +
    /* Kept — counted so the audit row says what came through untouched,
       which is the part somebody will want to check afterwards. */
    ' (select count(*) from app_users)     as accounts_kept,' +
    ' (select count(*) from bk_checklist)  as services_kept,' +
    ' (select count(*) from bk_job_types)  as job_types_kept'
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
        return EMPTY_WHOLE.reduce(function (chain, table) {
          return chain.then(function () { return client.query('delete from ' + table); });
        }, Promise.resolve());
      })
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
