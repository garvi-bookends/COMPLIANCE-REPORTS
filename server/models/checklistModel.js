'use strict';
/* ---------------------------------------------------------------------------
   Daily checklist records (app_checklists) — every read and write goes here.
   --------------------------------------------------------------------------- */

var crypto = require('crypto');
var db = require('../db/pool');

var COLUMNS =
  'id, user_id, user_name, loc, checklist_type, shift_date, start_time, end_time, ' +
  'photo, answers, status, submitted_at, created_at';

function newId() {
  return 'CL-' + crypto.randomBytes(6).toString('hex').toUpperCase();
}

function pad2(n) { return (n < 10 ? '0' : '') + n; }

/* A `date` column comes back from pg as a local-midnight Date. Read it back
   with local getters so the calendar day is exactly what was stored. */
function dateOnly(v) {
  if (!v) return null;
  if (typeof v === 'string') return v.slice(0, 10);
  return v.getFullYear() + '-' + pad2(v.getMonth() + 1) + '-' + pad2(v.getDate());
}

function ms(v) { return v ? new Date(v).getTime() : null; }

/* Row -> API shape. Timestamps are epoch ms, as elsewhere in this API.
   Checklists no longer carry a photo; the column only holds what older
   records were sent with, and is not handed out. */
function toApi(row, opts) {
  if (!row) return null;
  /* Lists stay small: the ticked answers come with the single record. */
  var full = !(opts && opts.list);
  /* Items may be left unticked, so every record says how many were ticked.
     Records without answers predate that and were all ticked. */
  var a = Array.isArray(row.answers) ? row.answers : null;
  return {
    id: row.id,
    userId: row.user_id,
    userName: row.user_name,
    loc: row.loc,
    type: row.checklist_type,
    shiftDate: dateOnly(row.shift_date),
    startTime: ms(row.start_time),
    endTime: ms(row.end_time),
    answers: full ? (row.answers || null) : undefined,
    ticked: a ? a.filter(function (x) { return x && x.done; }).length : null,
    total: a ? a.length : null,
    status: row.status,
    submittedAt: ms(row.submitted_at),
    createdAt: ms(row.created_at)
  };
}

/* Resolves to the new record, or to null when this person already has one
   for this checklist and shift (the unique index decides, so two taps at the
   same instant still cannot make two rows). */
function create(rec) {
  return db.query(
    'insert into app_checklists (id, user_id, user_name, loc, checklist_type, shift_date, start_time, end_time, photo, answers, status, submitted_at) ' +
    "values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $11::jsonb, 'SUBMITTED', $10) " +
    'on conflict (user_id, checklist_type, shift_date) do nothing ' +
    'returning ' + COLUMNS,
    [newId(), rec.userId, rec.userName, rec.loc, rec.type, rec.shiftDate,
      new Date(rec.startTime), new Date(rec.endTime), null, new Date(rec.submittedAt),
      rec.answers ? JSON.stringify(rec.answers) : null]
  ).then(function (r) { return r.rows[0] ? toApi(r.rows[0]) : null; });
}

function findById(id) {
  return db.query('select ' + COLUMNS + ' from app_checklists where id = $1', [id])
    .then(function (r) { return toApi(r.rows[0]); });
}

/* This person's records for the given shift dates — what the checklist page
   needs to show "Submitted" on a card. */
function listForUser(userId, shiftDates) {
  return db.query(
    'select ' + COLUMNS + ' from app_checklists where user_id = $1 and shift_date = any($2::date[]) order by submitted_at desc',
    [userId, shiftDates]
  ).then(function (r) { return r.rows.map(function (row) { return toApi(row); }); });
}

/* The admin list. `loc` limits it to one kitchen; null means every kitchen. */
function list(opts) {
  var params = [opts.from, opts.to];
  var sql = 'select ' + COLUMNS + ' from app_checklists where shift_date between $1::date and $2::date';
  if (opts.loc) { params.push(opts.loc); sql += ' and loc = $' + params.length; }
  sql += ' order by shift_date desc, submitted_at desc limit 2000';
  return db.query(sql, params).then(function (r) {
    return r.rows.map(function (row) { return toApi(row, { list: true }); });
  });
}

module.exports = {
  create: create,
  findById: findById,
  listForUser: listForUser,
  list: list,
  toApi: toApi
};
