import sharp from "sharp";
import { createHash } from "node:crypto";
import { observeInboxFromXml, observeMatchCarouselFromXml } from "./appium-conversation-reader.js";

// No navigation capability is accepted. The caller supplies the RAM continuity
// key of a visible row already bound in its current inventory. Neither bounds
// nor RAM keys become durable identity or are uploaded.
export async function ingestVisibleAvatar({ runtime, ownerType, ramKey, ingest }) {
  if (!["conversation","match"].includes(ownerType) || typeof ramKey !== "string"
    || typeof ingest !== "function") throw new TypeError("visible bound owner required");
  const observe = ownerType === "match" ? observeMatchCarouselFromXml : observeInboxFromXml;
  const candidates = projection => projection?.[ownerType === "match" ? "tiles" : "rows"] || [];
  const select = xml => {
    const rows = candidates(observe(xml)).filter(item => item.ram_key === ramKey);
    return rows.length === 1 ? rows[0] : null;
  };
  const before = select(await runtime.sourceXml());
  if (!before?.avatar_bounds) return {status:"AVATAR_BOUNDS_UNAVAILABLE"};
  const screen = await runtime.captureScreen();
  const after = select(await runtime.sourceXml());
  if (!after?.avatar_bounds || JSON.stringify(after.avatar_bounds) !== JSON.stringify(before.avatar_bounds)) {
    return {status:"VISIBLE_ROW_CHANGED"};
  }
  const b = after.avatar_bounds;
  const sourceBytes = await sharp(screen,{limitInputPixels:64_000_000})
    .extract({left:b.left,top:b.top,width:b.width,height:b.height}).png().toBuffer();
  const result = await ingest({sourceBytes,kind:"avatar",ordinal:0});
  return {status:"AVATAR_INGESTED",...result};
}

export function createMatchAvatarCollector({runtime,maxBytes=48*1024*1024}) {
  const crops=new Map();let bytes=0;
  const key=tile=>JSON.stringify(tile);
  return {
    clear(){crops.clear();bytes=0;},
    async observe(carousel){
      for(const item of carousel.tiles){
        const state=key(item.tile);
        if(crops.has(state)||!item.avatar_bounds)continue;
        try {
          await ingestVisibleAvatar({runtime,ownerType:"match",ramKey:item.ram_key,ingest:async({sourceBytes})=>{
            if(bytes+sourceBytes.length>maxBytes)throw Error("AVATAR_RAM_LIMIT");
            crops.set(state,sourceBytes);bytes+=sourceBytes.length;return {};
          }});
        } catch { /* Optional media cannot stop normal Match discovery. */ }
      }
    },
    async flush({inventory,stored,upload}){
      let persisted=0,skipped=0,failed=0;
      try {
        for(const [state,sourceBytes] of crops){
          const observed=inventory.filter(item=>key(item.tile)===state);
          const owners=stored.filter(item=>key(item.tile)===state);
          if(observed.length!==1||owners.length!==1){skipped++;continue;}
          // Existing media content digest only; never used to identify a Match.
          const digest=createHash("sha256").update(sourceBytes).digest("hex");
          if(owners[0].avatar_source_sha256===digest){skipped++;continue;}
          try{await upload(owners[0].id||owners[0].match_id,sourceBytes);persisted++;}catch{failed++;}
        }
        return {persisted,skipped,failed};
      } finally {this.clear();}
    }
  };
}
