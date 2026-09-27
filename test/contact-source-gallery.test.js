import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { createContactMediaService } from "../services/contact-media.js";

test("Contacts source-only projection cannot invoke either translation generator", async () => {
  const source = await readFile(new URL("../index.js", import.meta.url), "utf8");
  const start = source.indexOf("  const translatedFixedDisplay =");
  const end = source.indexOf("  const translatedProfile =", start);
  assert.ok(start > 0 && end > start);
  const run = vm.runInNewContext(`(async () => {${source.slice(start, end)}
    return {translatedFixedDisplay,structuredDisplayValues};})`, {
    req: {query:{source_only:"1"}},fixedDisplaySource:{contact:{bio:"source"},events:[]},
    contactDisplaySource:{bio:"source"},normalizedActiveItems:[{value:{source:"unaltered"}}],
    normalizedHistoricalItems:[],normalizedEvents:[],
    translateDashboardValueListToGerman(){throw Error("AI MUST NOT RUN");},
    translateDashboardStructuredValueListToGerman(){throw Error("AI MUST NOT RUN");}
  });
  const result = JSON.parse(JSON.stringify(await run()));
  assert.equal(result.translatedFixedDisplay.contact.bio,"source");
  assert.deepEqual(result.structuredDisplayValues,[{source:"unaltered"}]);
  const html = await readFile(new URL("../Kontakte/index.html",import.meta.url),"utf8");
  assert.match(html,/source_only=1/);
});

test("Gallery retains legacy media unless explicit source row or exact resource is shared",async()=>{
  const pool={query:async()=>({rows:[1,2,3].map(id=>({id,contact_id:7,media_type:"image",
    storage_path:`/legacy/${id}`,created_at:"2026-09-27",caption:"same text"}))})};
  const sharedGallery={listSharedItemsForContact:async()=>[
    {id:"shared:a",fileRef:"/protected/a",metadata:{legacyMediaId:1}},
    {id:"shared:b",fileRef:"/legacy/2",metadata:{}},
    {id:"shared:c",fileRef:"/protected/c",metadata:{caption:"same text"}}
  ]};
  const result=await createContactMediaService(pool,{sharedGallery}).listContactMedia(7);
  assert.deepEqual(result.map(x=>x.id),[3,"shared:a","shared:b","shared:c"]);
  assert.equal((await createContactMediaService(pool).listContactMedia(7)).length,3);
});
