/**
 * Express-Adapter für den SCIM-Endpunkt. Dünne Hülle um createScimNodeHandler – dieselben Guards, Limits
 * und Sicherheitsereignisse wie im node:http-Server (app/src/server.ts).
 *
 *   import express from "express";
 *   import { scimRouter } from "@calensync/scim/expressRouter";
 *   const app = express();
 *   app.disable("x-powered-by");
 *   app.set("trust proxy", 1);                         // genau ein ALB davor
 *   app.use("/scim/v2", scimRouter(deps, { security: logger, log }));   // VOR jedem globalen Body-Parser
 *
 * Der Router liest den Body selbst (Limit 256 KB, striktes UTF-8/JSON). Ist schon ein express.json()
 * davor registriert, antwortet er mit 500 + Log "scim_router_misconfigured" statt Limits zu umgehen.
 *
 * Absicherung auf Transportebene (ALB/WAF, siehe Terraform):
 *   * nur HTTPS (TLS 1.2/1.3) · WAF-Rate-Limit · optional IP-Allowlist der Entra-Provisioning-Dienste
 */
import type { NextFunction, Request, Response, Router } from "express";
import express from "express";
import { createScimNodeHandler, type ScimHttpOptions } from "./nodeHandler.js";
import type { ScimDeps } from "./scimUsers.js";

export function scimRouter(deps: ScimDeps, opts: ScimHttpOptions = {}): Router {
  const router = express.Router();
  const handle = createScimNodeHandler(deps, opts);

  router.use((req: Request, res: Response, next: NextFunction) => {
    // req.url ist relativ zum Mount-Punkt (/scim/v2) inkl. Query
    const url = req.url ?? "/";
    const qi = url.indexOf("?");
    const rel = qi >= 0 ? url.slice(0, qi) : url;
    handle(req, res, rel === "" ? "/" : rel).catch(next);
  });

  return router;
}
