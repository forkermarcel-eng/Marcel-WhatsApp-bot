import sharp from "sharp";
import { readVerifiedTinderProfileMedia } from "./appium-profile-media-runner.js";

// The existing initial read has no durable conversation ID yet. Keep only
// bounded crops in RAM until that SAME read yields its accepted mirror ID.
export function createProfileMediaBuffer({ maxBytes = 48 * 1024 * 1024 } = {}) {
  const pages = [];
  let size = 0, outcome = null;
  return Object.freeze({
    async read(runtime, expectedDisplayName) {
      const mediaIngestor = {
        async ingestVerifiedScreenRegion({screenBytes,verifiedMediaBounds:b,position}) {
          const bytes = await sharp(screenBytes,{limitInputPixels:64_000_000})
            .extract({left:b.left,top:b.top,width:b.width,height:b.height}).png().toBuffer();
          if (pages.length >= 40 || bytes.length > 8*1024*1024 || size+bytes.length > maxBytes) throw Error("PROFILE_MEDIA_RAM_LIMIT");
          pages.push({bytes,position});size+=bytes.length;
        },
        async recordUnavailable() {}
      };
      try {
        outcome = await readVerifiedTinderProfileMedia(runtime,{expectedDisplayName,
          profileReference:"current-initial-profile",mediaIngestor});
      } catch {
        pages.length=0;size=0;outcome={status:"PROFILE_MEDIA_READ_FAILED",end_actually_reached:false};
      }
      return outcome;
    },
    async flush({deviceId,conversationId,matchId,transport}) {
      if(pages.length && Boolean(conversationId)===Boolean(matchId))throw new TypeError("one persisted profile owner required");
      let persisted=0;
      try {
        for(const page of pages){
          await transport.ingestMedia({deviceId,ownerId:matchId||conversationId,ownerType:matchId?"match":"conversation",
            kind:"profile",ordinal:page.position,sourceBytes:page.bytes,
            profileCollectionSize:outcome?.end_actually_reached===true?pages.length:null});
          persisted++;
        }
        return {...outcome,persisted};
      } catch {
        // A media upload failure is not a new gate on the working text mirror.
        return {status:"PROFILE_MEDIA_UPLOAD_FAILED",persisted,end_actually_reached:outcome?.end_actually_reached === true};
      } finally {pages.length=0;size=0;}
    },
    clear(){pages.length=0;size=0;}
  });
}
