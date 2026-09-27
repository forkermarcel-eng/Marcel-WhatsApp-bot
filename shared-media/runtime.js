import path from "node:path";
import { createLocalFilesystemMediaStorage } from "./storage.js";
import { createSharedMediaRepository } from "./repository.js";
import { createSharedAttachmentIngress } from "./ingress.js";
import { createSharedMediaContactGalleryAdapter } from "./contact-gallery.js";
import { mediaDeliveryUrl, registerMediaDelivery } from "./delivery.js";
import { createMediaContextReader } from "./media-context.js";
import { createContactMediaProjection } from "./contact-projection.js";
import { createMediaProcessor } from "./ffmpeg.js";

export function createSharedMediaRuntime({ pool, environment = process.env }) {
  // Deployment switch, not a READ permission: disabled leaves all current
  // channels intact until storage and the explicit schema apply are ready.
  if (environment.SHARED_MEDIA_ENABLED !== "true") return null;
  const root = environment.MEDIA_STORAGE_ROOT;
  if (!root || !path.isAbsolute(root)) throw new Error("MEDIA_STORAGE_ROOT_REQUIRED");
  if (environment.RAILWAY_ENVIRONMENT_ID) {
    const volume = environment.RAILWAY_VOLUME_MOUNT_PATH;
    if (!volume || !path.isAbsolute(volume)) throw new Error("PERSISTENT_MEDIA_VOLUME_REQUIRED");
    const relative = path.relative(volume,root);
    if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) throw new Error("MEDIA_ROOT_OUTSIDE_VOLUME");
  }
  const storage = createLocalFilesystemMediaStorage({ rootDirectory: root });
  const repository = createSharedMediaRepository(pool);
  const processor = createMediaProcessor({ ffmpeg: environment.FFMPEG_PATH || "ffmpeg", ffprobe: environment.FFPROBE_PATH || "ffprobe" });
  const ingress = createSharedAttachmentIngress({ storage,repository,processor });
  const gallery = createSharedMediaContactGalleryAdapter({ repository,
    publicRefForAsset: (asset,variant,owner) => mediaDeliveryUrl(asset.assetId,owner,variant) });
  const contextReader = createMediaContextReader({ listAttachments: repository.listAttachments });
  const projectContact = createContactMediaProjection({ repository,pool });
  return Object.freeze({ storage, repository, ingress, gallery, contextReader, projectContact,
    registerRoutes(app, authorized) { registerMediaDelivery({ app,authorized,repository,storage }); }
  });
}
