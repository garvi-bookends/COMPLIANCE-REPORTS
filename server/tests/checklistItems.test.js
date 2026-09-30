'use strict';
/* ---------------------------------------------------------------------------
   Checklist answers — a checklist may be sent with items left unticked, and
   the record says exactly which.

   Run with:  npm test
   --------------------------------------------------------------------------- */

var test = require('node:test');
var assert = require('node:assert');

var items = require('../services/checklistItems');
var model = require('../models/checklistModel');

var N = items.ITEMS.length;
function answers(fn) { var a = []; for (var i = 0; i < N; i++) a.push(fn(i)); return a; }

test('every item ticked is accepted', function () {
  var r = items.check(answers(function () { return true; }));
  assert.ok(!r.error);
  assert.strictEqual(r.answers.filter(function (a) { return a.done; }).length, N);
});

test('items left unticked are accepted and stored as not done', function () {
  var r = items.check(answers(function (i) { return i % 3 !== 0; }));
  assert.ok(!r.error);
  r.answers.forEach(function (a, i) {
    assert.strictEqual(a.done, i % 3 !== 0);
    assert.strictEqual(a.question, items.ITEMS[i].question);
  });
});

test('nothing ticked is still accepted', function () {
  var r = items.check(answers(function () { return false; }));
  assert.ok(!r.error);
  assert.strictEqual(r.answers.filter(function (a) { return a.done; }).length, 0);
});

test('a wrong length or a non-boolean answer is refused', function () {
  assert.ok(items.check(answers(function () { return true; }).slice(1)).error);
  assert.ok(items.check(null).error);
  assert.ok(items.check(answers(function (i) { return i === 0 ? 'yes' : true; })).error);
});

test('records carry the ticked count, in lists too', function () {
  var stored = items.check(answers(function (i) { return i < 20; })).answers;
  var row = { id: 'CL-000000000000', answers: stored };
  var one = model.toApi(row), listed = model.toApi(row, { list: true });
  assert.strictEqual(one.ticked, Math.min(20, N));
  assert.strictEqual(one.total, N);
  assert.strictEqual(listed.ticked, Math.min(20, N));
  assert.strictEqual(listed.answers, undefined);
  assert.strictEqual(model.toApi({ id: 'CL-000000000001', answers: null }).ticked, null);
});
