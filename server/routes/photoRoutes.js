'use strict';
/* ---------------------------------------------------------------------------
   POST /api/photos — store one cleaning or product photo.

   Body: the image itself (Content-Type image/jpeg or image/png), at most
   12 MB. Photos are sent at the size they were taken, so a real one is a
   few MB. Query ?loc=<kitchen> files it under that kitchen.

   Note for Vercel: a serverless function there will not receive a request
   body over about 4.5 MB, so that — not this limit — is what a photo has
   to fit through on that host. The app keeps its uploads under it.

   Replies { url }. The photo goes to Vercel Blob under a random name, so its
   address cannot be guessed from a task id. Previously the browser uploaded
   straight to Supabase Storage with the public anon key, which also let
   anyone upload anything; now only a signed-in user who may write records
   can store a photo, and only an actual image is accepted.
   --------------------------------------------------------------------------- */

var express = require('express');
var crypto = require('crypto');
var config = require('../config/env');
var requireAuth = require('../middleware/requireAuth');
var asyncHandler = require('../middleware/errorHandler').asyncHandler;

var router = express.Router();

/* Generous enough for a full-resolution photo from any phone. Nothing here
   resizes or re-compresses what arrives: the bytes are stored as sent. */
var MAX_BYTES = 12 * 1024 * 1024;
var READ_ONLY_ROLES = ['auditor'];
var LOC_RE = /^[A-Za-z0-9_-]{1,32}$/;

/* The file's first bytes, not the Content-Type the client claims, decide
   what it is. */
function imageType(buf) {
  if (buf.length > 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return { ext: 'jpg', mime: 'image/jpeg' };
  if (buf.length > 8 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))) return { ext: 'png', mime: 'image/png' };
  return null;
}

router.post('/',
  requireAuth,
  express.raw({ type: ['image/jpeg', 'image/png'], limit: MAX_BYTES }),
  asyncHandler(function (req, res) {
    if (READ_ONLY_ROLES.indexOf(req.auth.role) > -1) {
      return res.status(403).json({ error: 'Your account can view records but not change them', code: 'READ_ONLY' });
    }
    if (!config.blobToken) {
      /* No photo store configured (local development). The app keeps the
         photo on the device, exactly as it does when offline. */
      return res.status(501).json({ error: 'Photo storage is not set up on this server', code: 'NO_PHOTO_STORE' });
    }
    if (!Buffer.isBuffer(req.body) || !req.body.length) {
      return res.status(400).json({ error: 'Send the photo as image/jpeg or image/png', code: 'VALIDATION_ERROR' });
    }
    var type = imageType(req.body);
    if (!type) return res.status(415).json({ error: 'That file is not a JPEG or PNG image', code: 'NOT_AN_IMAGE' });

    var loc = typeof req.query.loc === 'string' && LOC_RE.test(req.query.loc) ? req.query.loc : 'misc';
    var name = 'photos/' + loc + '/' + crypto.randomBytes(12).toString('hex') + '.' + type.ext;

    /* Loaded here rather than at the top so the app still starts where the
       package is not installed (it is only needed on Vercel). */
    var put = require('@vercel/blob').put;
    return put(name, req.body, {
      access: 'public',
      contentType: type.mime,
      addRandomSuffix: true,
      token: config.blobToken
    }).then(function (blob) {
      res.status(201).json({ url: blob.url });
    });
  })
);

module.exports = router;
