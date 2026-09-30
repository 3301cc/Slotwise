"use strict";
// Vercel-Einstieg: GET/PUT /api/agent/settings (Bearer WAITLIST_ADMIN_TOKEN)
const { routes } = require("../_lib/http");
module.exports = (req, res) => ((req.method || "GET").toUpperCase() === "PUT" ? routes["PUT /api/agent/settings"] : routes["GET /api/agent/settings"])(req, res);
