'use strict';
/* ---------------------------------------------------------------------------
   One-time move of cleaning tasks and expiry products from the old Supabase
   cloud-sync tables into this app's database (Neon).

   Run from your own computer, never on Vercel:

     npm run import:supabase                 copy the records
     npm run import:supabase -- --copy-photos   also move the photos to Vercel Blob

   Needs in .env:
     DATABASE_URL               the Neon database (the destination)
     SUPABASE_URL               https://<project>.supabase.co
     SUPABASE_SERVICE_ROLE_KEY  Supabase → Settings → API → service_role.
                                Keep it in .env on your computer only; it is
                                never deployed and the app never uses it.
     BLOB_READ_WRITE_TOKEN      only with --copy-photos

   Safe to run more than once. A record already in Neon is only replaced by a
   copy with a newer edit time (_u), so work recorded through the new app is
   never overwritten by the old Supabase copy.
   --------------------------------------------------------------------------- */

var db = require('../db/pool');
var config = require('../config/env');

var SUPA_URL = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
var SUPA_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '');
var COPY_PHOTOS = process.argv.indexOf('--copy-photos') > -1;
var PAGE = 1000;
var KINDS = { tasks: 'bk_tasks', products: 'bk_products' };

function die(msg) { console.error('[import] ' + msg); process.exit(1); }

if (!SUPA_URL || !SUPA_KEY) die('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env first.');
if (COPY_PHOTOS && !config.blobToken) die('--copy-photos needs BLOB_READ_WRITE_TOKEN in .env.');

function supaGet(table, offset) {
  var url = SUPA_URL + '/rest/v1/' + table + '?select=id,loc,data,updated_at&order=id&limit=' + PAGE + '&offset=' + offset;
  return fetch(url, { headers: { apikey: SUPA_KEY, Authorization: 'Bearer ' + SUPA_KEY } }).then(function (r) {
    if (!r.ok) return r.text().then(function (t) { throw new Error('Supabase ' + table + ' HTTP ' + r.status + ': ' + t.slice(0, 200)); });
    return r.json();
  });
}

/* Old Supabase photos → Vercel Blob. Returns the new URL, or the old one
   untouched if it is not a Supabase URL or the copy fails. */
var photoCount = 0;
function movePhoto(url, loc) {
  if (!COPY_PHOTOS || typeof url !== 'string' || url.indexOf(SUPA_URL + '/storage/') !== 0) return Promise.resolve(url);
  return fetch(url).then(function (r) {
    if (!r.ok) throw new Error('HTTP ' + r.status);
    var type = r.headers.get('content-type') || 'image/jpeg';
    return r.arrayBuffer().then(function (ab) {
      var ext = /png/.test(type) ? 'png' : 'jpg';
      var name = 'photos/' + (loc || 'misc') + '/' + require('crypto').randomBytes(12).toString('hex') + '.' + ext;
      return require('@vercel/blob').put(name, Buffer.from(ab), {
        access: 'public', contentType: type, addRandomSuffix: true, token: config.blobToken
      });
    });
  }).then(function (blob) { photoCount++; return blob.url; }, function (err) {
    console.warn('[import]   photo not copied (' + err.message + '): ' + url);
    return url;
  });
}

function fixPhotos(kind, data) {
  var loc = data.loc;
  if (kind === 'products') {
    return movePhoto(data.photo, loc).then(function (u) { if (data.photo) data.photo = u; return data; });
  }
  return movePhoto(data.before, loc).then(function (u) {
    if (data.before) data.before = u;
    return movePhoto(data.after, loc);
  }).then(function (u) { if (data.after) data.after = u; return data; });
}

var UPSERT =
  'insert into %T as t (id, loc, data, updated_at) values ($1, $2, $3, $4) ' +
  'on conflict (id) do update set loc = excluded.loc, data = excluded.data, updated_at = now() ' +
  "where coalesce((excluded.data->>'_u')::numeric, 0) > coalesce((t.data->>'_u')::numeric, 0) " +
  'returning (xmax = 0) as inserted';

function importKind(kind) {
  var table = KINDS[kind];
  var stats = { read: 0, inserted: 0, updated: 0, skipped: 0 };
  var sql = UPSERT.replace('%T', table);

  function page(offset) {
    return supaGet(table, offset).then(function (rows) {
      stats.read += rows.length;
      return rows.reduce(function (p, row) {
        return p.then(function () {
          var data = row.data;
          if (!data || !data.id || data.id !== row.id) { stats.skipped++; return; }
          /* The sync layer compares _u numerically; make sure it is a number. */
          if (typeof data._u !== 'number' || !isFinite(data._u)) data._u = new Date(row.updated_at).getTime() || 0;
          return fixPhotos(kind, data).then(function (d) {
            return db.query(sql, [row.id, row.loc || d.loc || null, d, row.updated_at || new Date()]);
          }).then(function (r) {
            if (!r.rows.length) stats.skipped++;
            else if (r.rows[0].inserted) stats.inserted++;
            else stats.updated++;
          });
        });
      }, Promise.resolve()).then(function () {
        console.log('[import] ' + table + ': ' + stats.read + ' read so far');
        if (rows.length === PAGE) return page(offset + PAGE);
      });
    });
  }

  return page(0).then(function () {
    console.log('[import] ' + table + ' done — ' + stats.inserted + ' new, ' + stats.updated + ' updated, ' +
      stats.skipped + ' left as they were (Neon already had a newer copy, or the row was malformed)');
  });
}

console.log('[import] from ' + SUPA_URL + (COPY_PHOTOS ? ' (moving photos to Vercel Blob)' : ''));
importKind('tasks')
  .then(function () { return importKind('products'); })
  .then(function () {
    if (COPY_PHOTOS) console.log('[import] photos moved: ' + photoCount);
    console.log('[import] finished. Next: lock the old Supabase tables (SETUP.md, "Lock Supabase").');
    return db.close();
  })
  .then(function () { process.exit(0); })
  .catch(function (err) {
    console.error('[import] FAILED: ' + err.message);
    db.close().then(function () { process.exit(1); }, function () { process.exit(1); });
  });
