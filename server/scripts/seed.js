'use strict';
/* ---------------------------------------------------------------------------
   Creates the starting roster — the same people freshData() used to seed into
   localStorage, but with bcrypt hashes in Postgres instead of plaintext.

   Run with:  npm run seed

   Idempotent: an account whose login ID already exists is left alone, so
   re-running never overwrites a password someone has since changed.

   The three head-office accounts and the eight location managers get
   DEFAULT_PASSWORD with must_change_password = true, exactly as before. The
   bootstrap admin (SEED_ADMIN_UID) gets SEED_ADMIN_PASSWORD, which must be
   supplied and must not be the shared default — it is the one account that
   can create everyone else.
   --------------------------------------------------------------------------- */

var db = require('../db/pool');
var config = require('../config/env');
var userModel = require('../models/userModel');
var passwords = require('../services/passwordService');

/* Mirrors LOCATIONS in index.html. The frontend is a single static file with
   no module exports, so the backend keeps its own copy — now in one place,
   shared with whatever else needs to check a location. */
var LOCATIONS = require('../config/locations').LOCATIONS;

var HEAD_OFFICE = [
  { id: 'U-HK',  name: 'Husen Khan', role: 'exec'  },
  { id: 'U-MAN', name: 'Manish',     role: 'aexec' },
  { id: 'U-RUT', name: 'Rutvik',     role: 'aexec' }
];

function buildRoster() {
  var roster = HEAD_OFFICE.map(function (p) {
    return { id: p.id, name: p.name, role: p.role, loc: null };
  });
  LOCATIONS.forEach(function (L) {
    roster.push({ id: 'U-' + L.code + '-M', name: L.head, role: 'manager', loc: L.id });
  });
  return roster;
}

/* The bootstrap admin must have a real password of its own. Refusing the
   shared default here is the point: if this account keeps password 1234,
   anyone who can reach the login page owns the whole system. */
function checkAdminPassword() {
  var pw = config.seed.adminPassword;
  if (!pw) {
    throw new Error(
      'SEED_ADMIN_PASSWORD is not set.\n' +
      'Put a strong password for the bootstrap admin in .env, then run npm run seed again.'
    );
  }
  if (pw === config.password.defaultPassword) {
    throw new Error('SEED_ADMIN_PASSWORD must not be the same as DEFAULT_PASSWORD.');
  }
  if (pw.length < 10) {
    throw new Error('SEED_ADMIN_PASSWORD should be at least 10 characters — this account can create every other user.');
  }
  if (/change-this|replace-me|password/i.test(pw)) {
    throw new Error('SEED_ADMIN_PASSWORD still looks like a placeholder. Choose a real password.');
  }
  return pw;
}

/* Creates one account unless the login ID is already taken. */
function ensureUser(spec, uidOverride, plainPassword) {
  var uid = uidOverride || userModel.normaliseUid(String(spec.name).split(/\s+/)[0]);

  return userModel.uidExists(uid).then(function (exists) {
    if (exists) {
      console.log('  = ' + padRight(uid, 12) + ' already exists — left untouched');
      return { created: false, uid: uid };
    }
    return passwords.hash(plainPassword).then(function (hash) {
      return userModel.createUser({
        id: spec.id,
        uid: uid,
        name: spec.name,
        role: spec.role,
        loc: spec.loc,
        passwordHash: hash,
        mustChange: spec.mustChange === undefined ? true : spec.mustChange,
        createdBy: 'seed'
      });
    }).then(function (user) {
      console.log('  + ' + padRight(user.uid, 12) + ' ' + padRight(user.name, 14) + ' ' + user.role +
        (user.loc ? ' @ ' + user.loc : ' (all locations)'));
      return { created: true, uid: user.uid };
    });
  });
}

function padRight(s, n) {
  s = String(s);
  while (s.length < n) s += ' ';
  return s;
}

function run() {
  var adminPassword = checkAdminPassword();
  var adminUid = userModel.normaliseUid(config.seed.adminUid);
  var roster = buildRoster();

  console.log('[seed] creating the starting roster\n');

  /* The bootstrap admin first, so there is always an account that can manage
     users even if a later step fails. */
  return ensureUser(
    /* The bootstrap admin is the Super Admin: the one account that approves
       self sign-ups. The database allows only one. */
    { id: 'U-ADMIN', name: config.seed.adminName, role: 'superadmin', loc: null, mustChange: false },
    adminUid,
    adminPassword
  ).then(function (adminResult) {

    /* Then everyone else, one at a time so the log reads in order. */
    return roster.reduce(function (chain, spec) {
      return chain.then(function (acc) {
        /* Skip anyone whose derived login ID collides with the bootstrap
           admin — the admin account already covers that person. */
        var derived = userModel.normaliseUid(String(spec.name).split(/\s+/)[0]);
        if (derived === adminUid) {
          console.log('  = ' + padRight(derived, 12) + ' is the bootstrap admin — skipped');
          return acc;
        }
        return ensureUser(spec, derived, config.password.defaultPassword).then(function (r) {
          if (r.created) acc.created++;
          return acc;
        });
      });
    }, Promise.resolve({ created: 0 })).then(function (acc) {

      console.log('\n[seed] done — ' + (acc.created + (adminResult.created ? 1 : 0)) + ' account(s) created');
      console.log('[seed] admin login ID : ' + adminUid);
      console.log('[seed] admin password : the SEED_ADMIN_PASSWORD you set in .env');
      console.log('[seed] everyone else  : password ' + config.password.defaultPassword +
        ', and must choose their own on first sign-in');
      console.log('\n[seed] Remove SEED_ADMIN_PASSWORD from .env once you have signed in successfully.');
    });
  });
}

run()
  .then(function () { return db.close(); })
  .then(function () { process.exit(0); })
  .catch(function (err) {
    console.error('\n[seed] FAILED: ' + err.message);
    db.close().then(function () { process.exit(1); }, function () { process.exit(1); });
  });
