import { createBrainWriteProxy } from "../_brain-write-proxy.js";

function factPath(req) {
  const idValue = Array.isArray(req.query?.id) ? req.query.id[0] : req.query?.id;
  if (req.method === "POST") {
    if (idValue !== undefined && idValue !== null && idValue !== "") {
      const error = new Error("Beim Anlegen darf keine ID gesetzt sein.");
      error.statusCode = 400;
      throw error;
    }
    return "/dashboard-api/marcel-brain/facts";
  }
  const id = Number(idValue);
  if (!Number.isInteger(id) || id <= 0) {
    const error = new Error("Ungültige oder fehlende Marcel-Memory-ID.");
    error.statusCode = 400;
    throw error;
  }
  return `/dashboard-api/marcel-brain/facts/${encodeURIComponent(String(id))}`;
}

export default createBrainWriteProxy({
  methods: ["POST", "PATCH"],
  buildPath: factPath
});
