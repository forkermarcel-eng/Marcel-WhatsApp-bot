const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INLINE = new Set(["image/jpeg","image/png","image/webp","image/gif","image/avif",
  "video/mp4","video/webm","audio/mpeg","audio/ogg","audio/wav","audio/mp4","audio/webm"]);

export function mediaDeliveryUrl(assetId, owner, variant = "display") {
  return `/api/dashboard/contacts?${new URLSearchParams({ resource: "media", assetId, variant,
    ownerChannel: owner.ownerChannel, ownerType: owner.ownerType, ownerReference: owner.ownerReference })}`;
}
export function registerMediaDelivery({ app, authorized, repository, storage }) {
  app.get("/dashboard-api/media/:assetId", async (req,res) => {
    if (!authorized(req)) return res.status(401).json({ error: "Unauthorized" });
    if (!UUID.test(req.params.assetId)) return res.status(400).json({ error: "Invalid asset" });
    const variant = req.query.variant || "display";
    if (!["original","display","thumbnail"].includes(variant)) return res.status(400).json({ error: "Invalid variant" });
    let asset;
    try { asset = await repository.assetForOwner(req.params.assetId, req.query); }
    catch (error) {
      return res.status(error instanceof TypeError ? 400 : 503).json({ error: "Media lookup unavailable" });
    }
    if (!asset || asset.availability !== "AVAILABLE") return res.status(404).json({ error: "Media not found" });
    const derivative = variant === "original" ? null : asset.metadata?.derivatives?.[variant];
    const key = derivative?.storageKey || (variant === "thumbnail" ? asset.thumbnailStorageKey : asset.storageKey);
    if (!key) return res.status(404).end();
    const mimeType = derivative?.mimeType || (variant === "thumbnail" ? "image/webp" : asset.mimeType) || "application/octet-stream";
    try {
      const filename = await storage.resolvePath(key);
      res.setHeader("Content-Type",mimeType);
      res.setHeader("X-Content-Type-Options","nosniff");
      res.setHeader("Cache-Control","private, no-cache");
      res.setHeader("Content-Disposition",variant === "original" || !INLINE.has(mimeType) ? "attachment" : "inline");
      res.sendFile(filename, { acceptRanges: true, cacheControl: false, dotfiles: "deny" }, error => {
        if (error && !res.headersSent) res.status(error.statusCode === 416 ? 416 : 404).end();
      });
    } catch { if (!res.headersSent) res.status(404).end(); }
  });
}
