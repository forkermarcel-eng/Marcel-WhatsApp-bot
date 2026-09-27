import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export async function proxyDashboardMedia(req,res,authorized) {
  if (!["GET","HEAD"].includes(req.method)) return res.status(405).end();
  if (!authorized(req)) return res.status(401).end();
  const id = req.query?.assetId;
  if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).end();
  const base = process.env.RAILWAY_BACKEND_URL?.replace(/\/+$/,"");
  const secret = process.env.DASHBOARD_API_SECRET;
  if (!base || !secret) return res.status(503).end();
  const query = new URLSearchParams();
  for (const field of ["variant","ownerChannel","ownerType","ownerReference"]) {
    if (typeof req.query[field] !== "string" || req.query[field].length > 2048) return res.status(400).end();
    query.set(field,req.query[field]);
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  res.once("close",abort);
  const timer = setTimeout(abort,30000);
  try {
    const headers = { Authorization: `Bearer ${secret}` };
    for (const name of ["range","if-range","if-none-match","if-modified-since"]) {
      if (typeof req.headers[name] === "string") headers[name] = req.headers[name];
    }
    const response = await fetch(`${base}/dashboard-api/media/${id}?${query}`, {
      method: req.method, headers, signal: controller.signal, redirect: "error"
    });
    clearTimeout(timer);
    res.status(response.status);
    for (const name of ["content-type","content-length","content-range","accept-ranges","etag",
      "last-modified","content-disposition"]) {
      const value = response.headers.get(name);
      if (value) res.setHeader(name,value);
    }
    res.setHeader("Cache-Control","private, no-cache");
    res.setHeader("X-Content-Type-Options","nosniff");
    if (req.method === "HEAD" || !response.body) return res.end();
    await pipeline(Readable.fromWeb(response.body),res);
  } catch {
    if (!res.headersSent) res.status(502).end();
    else res.destroy();
  } finally { clearTimeout(timer); res.off("close",abort); }
}
