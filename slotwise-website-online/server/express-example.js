"use strict";
/*
 * Beispiel: dieselbe API in einer bestehenden Express-App (nicht im Deployment genutzt).
 *   npm i express
 *   node server/express-example.js
 */
const express = require("express");
const path = require("node:path");
const { apiHandler } = require("../api/_lib/http");

const app = express();
app.use(apiHandler);                                        // liest den Body selbst; kein express.json() nötig
app.use(express.static(path.join(__dirname, ".."), { index: "index.html" }));
app.get("*", (_req, res) => res.sendFile(path.join(__dirname, "..", "index.html")));
app.listen(process.env.PORT || 3000);
