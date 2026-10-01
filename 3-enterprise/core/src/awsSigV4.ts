/**
 * AWS Signature Version 4 – nur node:crypto (portiert aus slotwise-website-online/api/_lib/core/agent/bedrock.js,
 * Query-String jetzt kanonisch sortiert und RFC-3986-kodiert).
 *
 * Gebraucht für Workload Identity Federation AWS → Google (core/src/googleAuth.ts): Google prüft die Identität des
 * ECS-Tasks, indem es einen von uns SIGNIERTEN, aber nie an AWS gesendeten Request "sts:GetCallerIdentity" selbst an
 * AWS weiterreicht. Der Request enthält nur die Signatur, nie den geheimen Schlüssel.
 */
import { createHash, createHmac } from "node:crypto";

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  /** temporäre Credentials (ECS-Task-Rolle) */
  sessionToken?: string;
}

export interface SigV4Request {
  method: string;
  url: string;
  /** zusätzliche Header, die mitsigniert werden (z. B. x-goog-cloud-target-resource) */
  headers: Record<string, string>;
  body?: string;
  region: string;
  service: string;
  credentials: AwsCredentials;
  now?: Date;
}

/** Liefert ALLE Header des signierten Requests (inkl. host, x-amz-date, ggf. x-amz-security-token, Authorization) */
export type SigV4Signer = (r: SigV4Request) => Record<string, string>;

const sha256Hex = (data: string) => createHash("sha256").update(data, "utf8").digest("hex");
const hmac = (key: string | Buffer, data: string) => createHmac("sha256", key).update(data, "utf8").digest();
/** RFC 3986 (AWS): alles außer A-Z a-z 0-9 - _ . ~ kodieren */
const rfc3986 = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

function canonicalQuery(u: URL): string {
  const pairs: Array<[string, string]> = [];
  u.searchParams.forEach((v, k) => pairs.push([rfc3986(k), rfc3986(v)]));
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  return pairs.map(([k, v]) => `${k}=${v}`).join("&");
}

export const signAwsRequest: SigV4Signer = (r) => {
  const u = new URL(r.url);
  const at = r.now ?? new Date();
  const amzDate = at.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const h: Record<string, string> = {};
  for (const [k, v] of Object.entries(r.headers)) h[k.toLowerCase()] = v;
  h.host = u.host;
  h["x-amz-date"] = amzDate;
  if (r.credentials.sessionToken) h["x-amz-security-token"] = r.credentials.sessionToken;
  const names = Object.keys(h).sort();
  const canonicalHeaders = names.map((k) => `${k}:${String(h[k]).trim().replace(/\s+/g, " ")}\n`).join("");
  const signedHeaders = names.join(";");
  // Nicht-S3-Dienste: jedes Pfadsegment doppelt kodiert (wie bedrock.js); für STS ist der Pfad "/"
  const canonicalUri = u.pathname.split("/").map((p) => rfc3986(rfc3986(decodeURIComponent(p)))).join("/") || "/";
  const canonicalRequest = [r.method.toUpperCase(), canonicalUri, canonicalQuery(u), canonicalHeaders, signedHeaders, sha256Hex(r.body ?? "")].join("\n");
  const scope = `${dateStamp}/${r.region}/${r.service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
  const kSigning = hmac(hmac(hmac(hmac(`AWS4${r.credentials.secretAccessKey}`, dateStamp), r.region), r.service), "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");
  h.authorization = `AWS4-HMAC-SHA256 Credential=${r.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return h;
};
