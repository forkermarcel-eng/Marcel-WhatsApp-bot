(function (root) {
  "use strict";

  const labels = Object.freeze({
    primary_language: "Sprache", birthday: "Geburtstag", age: "Alter", day: "Tag", month: "Monat", year: "Jahr", seeking_new_job: "Arbeit",
    seed_shared_history: "Gemeinsame Geschichte", shared_history: "Gemeinsame Geschichte",
    temporary_state: "Temporärer Zustand", interaction_patterns: "Interaktionsmuster",
    current_context: "Aktueller Kontext", profile_summary: "Profil", relationship: "Beziehung",
    lifestyle_routines: "Alltag und Routinen", personality: "Persönlichkeit",
    work_education: "Arbeit und Ausbildung", financial_context: "Finanzen",
    goals_dreams: "Ziele und Träume", travel_future_location: "Reisen und künftiger Wohnort",
    living_situation: "Wohnsituation", personal_boundaries: "Persönliche Grenzen",
    stress_support_style: "Umgang mit Stress", decision_style: "Entscheidungsstil",
    social_media: "Soziale Medien", cultural_interest: "Kulturelle Interessen",
    meaningful_details: "Wichtige Details", running_gags: "Gemeinsame Insider",
    open_threads: "Offene Themen", plans: "Pläne", promises: "Versprechen",
    marcel_knowledge_map: "Wissen über Marcel", identity: "Identität", languages: "Sprachen",
    work: "Arbeit", family: "Familie", communication: "Kommunikation", lifestyle: "Lebensstil",
    food_drinks: "Essen und Getränke", skills: "Fähigkeiten", personal_stories: "Persönliche Geschichten",
    relationship_history: "Beziehungsgeschichte", relationship_values: "Beziehungswerte",
    marriage_religion: "Ehe und Religion", sexuality: "Intimität", housing: "Wohnen",
    preferences: "Vorlieben", health: "Gesundheit", travel: "Reisen", finance: "Finanzen",
    name: "Name", has_children: "Hat Kinder", themes: "Themen", accepted_whatsapp: "WhatsApp akzeptiert",
    current_country: "Aktuelles Land", current_city: "Aktuelle Stadt", current_timezone: "Zeitzone",
    location_status: "Ortsstatus", relocation_target_country: "Umzugs-Zielland",
    relocation_target_city: "Umzugs-Zielstadt", relocation_stage: "Umzugsphase",
    relocation_eta: "Umzugszeitraum", temporary_travel_country: "Temporäres Reiseland",
    temporary_travel_city: "Temporäre Reisestadt", temporary_travel_until: "Temporär bis",
    housing_stage: "Wohnstatus", manual_location_lock: "Manuelle Ortssperre"
  });
  const statuses = Object.freeze({ active:"Aktiv", historical:"Historisch", retired:"Historisch", open:"Offen", pending:"Prüfung offen", confirmed:"Menschlich bestätigt", corrected:"Menschlich korrigiert", rejected:"Abgelehnt", online:"Online", offline:"Offline", connected:"Verbunden", disconnected:"Getrennt", running:"Aktiv", stopped:"Gestoppt", unknown:"Unbekannt", auth_required:"Anmeldung erforderlich", review_required:"Prüfung erforderlich" });
  const channels = Object.freeze({ whatsapp:"WhatsApp", tinder:"Tinder", instagram:"Instagram", x:"X (Twitter)", twitter:"X (Twitter)" });
  const types = Object.freeze({ self_reported:"Selbst mitgeteilt", explicit_fact:"Expliziter Fakt", observed_pattern:"Beobachtetes Muster", interpretation:"Einordnung", temporary_state:"Temporärer Zustand" });
  const words = Object.freeze({ true:"Ja", false:"Nein", null:"Keine Angabe", planned:"Geplant", current:"Aktuell", completed:"Abgeschlossen" });

  function humanize(value) {
    const key=String(value??"").trim().toLowerCase().replace(/^seed_/,"");
    if (!key) return "Keine Angabe";
    if (labels[key]) return labels[key];
    return key.replace(/[_-]+/g," ").replace(/\b\w/g,letter=>letter.toUpperCase());
  }
  function label(value){return labels[String(value??"").toLowerCase()]||humanize(value)}
  function status(value){return statuses[String(value??"").toLowerCase()]||humanize(value)}
  function channel(value){return channels[String(value??"").toLowerCase()]||humanize(value)}
  const topicRules = Object.freeze([
    ["Aktueller Kontext", /current|temporary|context|status|open_threads/],
    ["Intimität", /sexual|intim|physical|affection/],
    ["Beziehungen & Liebe", /relationship|romance|love|marriage|partner|dating/],
    ["Kommunikation", /communication|language|interaction|conflict|support|humor/],
    ["Familie", /family|children|parent|mother|father|sister|brother/],
    ["Arbeit & Alltag", /work|education|career|job|routine|lifestyle|finance/],
    ["Zukunft & Pläne", /goal|dream|future|plan|promise|relocation/],
    ["Wohnort & Reisen", /travel|location|country|city|housing|living/],
    ["Gesundheit", /health|medical|wellbeing/],
    ["Vorlieben", /preference|food|drink|cultural|interest|like|favorite/],
    ["Persönlichkeit", /personality|identity|profile|decision|boundary|story|meaningful|knowledge_map/]
  ]);
  function topic(category,key="") {
    const source=`${category||""} ${key||""}`.toLowerCase();
    const match=topicRules.find(([,pattern])=>pattern.test(source));
    return match?match[0]:label(category||"Wissen");
  }
  function memoryType(value){return types[String(value??"").toLowerCase()]||humanize(value)}
  function scalar(value){if(value===null||value===undefined||value==="")return "Keine Angabe";const mapped=words[String(value).toLowerCase()];if(mapped)return mapped;if(typeof value==="string"&&/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value)){const date=new Date(value.length===10?`${value}T12:00:00`:value);if(!Number.isNaN(date.getTime()))return new Intl.DateTimeFormat("de-DE",{dateStyle:"medium"}).format(date)}return String(value)}
  function displayRows(value, path="") {
    if (Array.isArray(value)) return value.flatMap((item,index)=>displayRows(item,`${path}${path?" · ":""}${index+1}`));
    if (value&&typeof value==="object") return Object.entries(value).flatMap(([key,item])=>displayRows(item,`${path}${path?" · ":""}${label(key)}`));
    return [{ label:path||"Wert", value:scalar(value) }];
  }
  const technicalKeys = /(?:^|_)(?:id|inferred|source|audit|review|status|updated|created|confidence|importance)(?:_|$)/i;
  const monthNames = ["", "Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];
  function normalizedKey(value){return String(value??"").trim().toLowerCase().replace(/[^a-z0-9äöüß]+/g,"_").replace(/^_+|_+$/g,"")}
  function birthdayText(value) {
    if(!value||typeof value!=="object"||Array.isArray(value))return "";
    const entries=Object.entries(value),get=pattern=>entries.find(([key])=>pattern.test(normalizedKey(key)))?.[1];
    const day=Number(get(/^(?:birth_?)?day$|^(?:geburtstags?_?)?tag$/)),monthRaw=get(/^(?:birth_?)?month$|^(?:geburts_?)?monat$/),year=Number(get(/^(?:birth_?)?year$|^(?:geburts_?)?jahr$/));
    const monthNumber=Number(monthRaw),month=monthNames[monthNumber]||(typeof monthRaw==="string"&&!/^\d+$/.test(monthRaw.trim())?monthRaw.trim():"");
    if(!Number.isInteger(day)||day<1||day>31)return "";
    const parts=[`${day}.`,month,Number.isInteger(year)&&year>0?String(year):""].filter(Boolean);
    return `Geburtstag: ${parts.join(" ")}`;
  }
  const booleanPhrases = Object.freeze({
    hair_pulling:"Mag es, wenn Marcel ihr an den Haaren zieht",
    likes_hair_pulling:"Mag es, wenn Marcel ihr an den Haaren zieht",
    soft_kisses:"Mag sanfte Küsse",
    likes_soft_kisses:"Mag sanfte Küsse",
    explicitly_confirmed_desire:"Sexuelles Verlangen ausdrücklich bestätigt"
  });
  function semanticLabel(value){
    const raw=String(value??"").trim(),known=booleanPhrases[normalizedKey(raw)];
    if(known)return known;
    if(/[\säöüÄÖÜß]/.test(raw)&&!raw.includes("_"))return raw.replace(/^./,letter=>letter.toUpperCase());
    return label(raw||"Information");
  }
  function semanticFactText(factLabel,value) {
    const normalized=normalizedKey(factLabel),known=booleanPhrases[normalized];
    if(typeof value==="boolean"){
      if(known)return value?`${known}.`:`${known}: Nein.`;
      const shownLabel=semanticLabel(factLabel);
      if(value&&/^(?:Mag|Möchte|Hat|Ist|Kann|Will|Braucht|Sucht|Akzeptiert|Reagiert)\b|bestätigt$/i.test(shownLabel))return `${shownLabel}.`;
      return `${shownLabel}: ${value?"Ja":"Nein"}.`;
    }
    if(Array.isArray(value)){
      const values=value.filter(item=>item!==null&&item!==undefined&&item!=="").map(scalar);
      return values.length?`${semanticLabel(factLabel)}: ${list(values)}.`:"";
    }
    if(value===null||value===undefined||value==="")return "";
    const shown=scalar(value),shownLabel=semanticLabel(factLabel);
    return `${shownLabel}: ${shown}.`;
  }
  function semanticFacts(input) {
    const items=Array.isArray(input)?input:[input],facts=[];
    const add=(text,labelText,path,value)=>{if(text&&!facts.some(fact=>fact.text.toLowerCase()===text.toLowerCase()))facts.push({text,label:labelText,path,value})};
    const walk=(value,path,rootKey)=>{
      if(Array.isArray(value)&&value.some(item=>item&&typeof item==="object")){
        value.forEach(item=>walk(item,path,rootKey));
        return;
      }
      if(value&&typeof value==="object"&&!Array.isArray(value)){
        const birthday=birthdayText(value);
        if(birthday&&/(?:birth|birthday|geburtstag)/i.test(`${path} ${rootKey}`)){add(`${birthday}.`,"Geburtstag",path,value);return}
        for(const [key,item] of Object.entries(value)){
          if(technicalKeys.test(normalizedKey(key)))continue;
          walk(item,key,rootKey);
        }
        return;
      }
      const factLabel=path||rootKey||"Information",text=semanticFactText(factLabel,value);
      add(text,semanticLabel(factLabel),path,value);
    };
    for(const item of items){
      if(item===null||item===undefined)continue;
      const value=item&&typeof item==="object"&&Object.prototype.hasOwnProperty.call(item,"value")?item.value:item;
      const rootKey=item&&typeof item==="object"?(item.key||item.memory_key||item.category||""):"";
      if(value&&typeof value==="object"&&!Array.isArray(value)){
        const birthday=birthdayText(value);
        if(birthday&&/(?:birth|birthday|geburtstag)/i.test(rootKey)){add(`${birthday}.`,"Geburtstag",rootKey,value);continue}
      }
      walk(value,rootKey,rootKey);
    }
    return facts;
  }
  function semanticSummary(items,fallback="Noch keine verlässliche Kurzbeschreibung vorhanden.",limit=3) {
    const facts=semanticFacts(items).map(fact=>fact.text);
    return facts.length?facts.slice(0,limit).join(" "):fallback;
  }
  function dateTime(value){if(!value)return "Keine Zeitangabe";const date=new Date(value);return Number.isNaN(date.getTime())?scalar(value):new Intl.DateTimeFormat("de-DE",{dateStyle:"medium",timeStyle:"short"}).format(date)}
  function list(values){const clean=[...new Set(values.map(scalar).filter(value=>value!=="Keine Angabe"))];if(clean.length<2)return clean[0]||"";return `${clean.slice(0,-1).join(", ")} und ${clean.at(-1)}`}
  function summary(value, heading="Information") {
    if(Array.isArray(value))return value.length?`${label(heading)}: ${list(value)}.`:"Keine Angaben vorhanden.";
    if(!value||typeof value!=="object")return scalar(value);
    const entries=Object.entries(value),likes=[],positive=[],negative=[],facts=[];
    for(const [key,item] of entries){const clean=key.replace(/^seed_/,"");if(/^likes?(?:_\d+)?$|^mag(?:_\d+)?$|preference/i.test(clean)){if(Array.isArray(item))likes.push(...item);else if(item!==false&&item!=null)likes.push(item);continue}if(item===true){(/avoid|vermeiden|not_|no_/i.test(clean)?negative:positive).push(label(clean));continue}if(item===false)continue;if(Array.isArray(item)){facts.push(`${label(clean)}: ${list(item)}`);continue}if(item&&typeof item==="object"){const nested=summary(item,clean);if(nested)facts.push(nested.replace(/\.$/,""));continue}if(item!==null&&item!=="")facts.push(`${label(clean)}: ${scalar(item)}`)}
    const sentences=[];if(likes.length)sentences.push(`Mag ${list(likes)}`);if(positive.length)sentences.push(`${list(positive)} trifft zu`);if(negative.length)sentences.push(`${list(negative)} vermeiden`);if(facts.length)sentences.push(...facts);return sentences.length?sentences.map(text=>/[.!?]$/.test(text)?text:`${text}.`).join(" "):"Keine Angaben vorhanden."
  }
  const hiddenProfileKeys = /(?:^|_)(?:id|age|birth|birthday|day|month|year|inferred|source|audit|review|status|updated|created|confidence|importance)(?:_|$)/i;
  function readableFragments(value, path="") {
    if (value === null || value === undefined || value === "" || typeof value === "boolean") return [];
    if (Array.isArray(value)) return value.flatMap(item => readableFragments(item, path));
    if (typeof value === "object") return Object.entries(value).flatMap(([key,item]) => hiddenProfileKeys.test(key) ? [] : readableFragments(item, key));
    if (typeof value === "number" || /^\d{4}-\d{2}-\d{2}/.test(String(value))) return [];
    const text=String(value).trim();
    return text && !/^(?:true|false|null|active|historical|confirmed|corrected|unreviewed)$/i.test(text) ? [text] : [];
  }
  function humanProfileSummary(items, fallback="Noch keine verlässliche Kurzbeschreibung vorhanden.") {
    const fragments=[...new Set((items||[]).flatMap(item=>readableFragments(item?.value??item)).filter(text=>text.length>2))].slice(0,3);
    if(!fragments.length)return fallback;
    return fragments.map(text=>/[.!?]$/.test(text)?text:`${text}.`).join(" ");
  }
  function tensionPresentation(memoryItems=[], messages=[], events=[]) {
    const memoryPattern=/(?:sexual|intim|erotic|desire|passion|kiss|kuss|beso|touch|physical|hair.?pull|haar|foreplay|vorspiel|flirt|attraction|anziehung|affection)/i;
    const strongPattern=/(?:sexual|intim|explicit|ausdrücklich|desire|verlangen|hacer el amor|hair.?pull|haar|oral|foreplay|vorspiel)/i;
    let memoryScore=0,strongFacts=0;
    for(const item of memoryItems||[]){
      if(item?.useInReply===false)continue;
      const source=`${item?.category||""} ${item?.key||item?.memory_key||""} ${JSON.stringify(item?.value??item?.memory_value??"")}`;
      if(!memoryPattern.test(source))continue;
      const values=displayRows(item?.value??item?.memory_value).map(row=>row.value);
      if(values.length&&values.every(value=>value==="Nein"||value==="Keine Angabe"))continue;
      const strong=strongPattern.test(source);
      memoryScore+=strong?3:2;
      if(strong)strongFacts++;
      if(["confirmed","corrected"].includes(item?.reviewStatus||item?.human_review_status))memoryScore+=1;
      if(Number(item?.importance)>=4)memoryScore+=1;
      if(Number(item?.confidence)>=0.9)memoryScore+=1;
    }
    const pattern=/(?:\bflirt\w*|sexy|sexuell|anziehung|kuss|küssen|nähe|heiß|hot|\bkiss\w*|attraction|intim|\bbeso\w*|\bdeseo\w*|hacer el amor|sentirnos)/i;
    const hits=(messages||[]).filter(message=>pattern.test(String(message?.translationDe||message?.translation_de||message?.text||"")));
    const eventHits=(events||[]).filter(event=>pattern.test(String(event?.title||event?.evidenceSummary||"")));
    const directions=new Set(hits.map(message=>message?.direction).filter(Boolean));
    const secondaryScore=(directions.size>=2?3:0)+(hits.length+eventHits.length>=4?5:0);
    const score=memoryScore+secondaryScore;
    if(!score&&hits.length+eventHits.length===0)return {level:"Keine",summary:"Bisher sind keine verlässlichen flirtigen oder sexuellen Signale dokumentiert."};
    if(score<3)return {level:"Leicht",summary:"Einzelne flirtige Signale sind vorhanden; eine stärkere gegenseitige Spannung ist noch nicht verlässlich bestätigt."};
    if(score<8)return {level:"Spürbar",summary:"Bestätigte intime Fakten oder wiederkehrende gegenseitige Flirtsignale zeigen eine spürbare Spannung."};
    return {level:"Stark",summary:`Mehrere ${strongFacts?"deutliche intime Fakten und ":""}gegenseitige flirtige oder intime Signale sind dokumentiert.`};
  }
  root.MarcelPresentation=Object.freeze({label,status,channel,memoryType,scalar,displayRows,semanticFacts,semanticSummary,birthdayText,dateTime,summary,topic,readableFragments,humanProfileSummary,tensionPresentation});
})(globalThis);
