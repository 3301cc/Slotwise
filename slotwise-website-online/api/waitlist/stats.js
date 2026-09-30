"use strict";
// Vercel-Einstieg: GET /api/waitlist/stats  (Authorization: Bearer <WAITLIST_ADMIN_TOKEN>) → { confirmed }
module.exports = require("../_lib/http").routes["GET /api/waitlist/stats"];
