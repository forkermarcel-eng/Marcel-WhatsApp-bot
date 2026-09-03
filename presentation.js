(function (root) {
  "use strict";

  const labels = Object.freeze({
    primary_language: "Sprache", birthday: "Geburtstag", seeking_new_job: "Arbeit",
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
  function dateTime(value){if(!value)return "Keine Zeitangabe";const date=new Date(value);return Number.isNaN(date.getTime())?scalar(value):new Intl.DateTimeFormat("de-DE",{dateStyle:"medium",timeStyle:"short"}).format(date)}
  function list(values){const clean=[...new Set(values.map(scalar).filter(value=>value!=="Keine Angabe"))];if(clean.length<2)return clean[0]||"";return `${clean.slice(0,-1).join(", ")} und ${clean.at(-1)}`}
  function summary(value, heading="Information") {
    if(Array.isArray(value))return value.length?`${label(heading)}: ${list(value)}.`:"Keine Angaben vorhanden.";
    if(!value||typeof value!=="object")return scalar(value);
    const entries=Object.entries(value),likes=[],positive=[],negative=[],facts=[];
    for(const [key,item] of entries){const clean=key.replace(/^seed_/,"");if(/^likes?(?:_\d+)?$|^mag(?:_\d+)?$|preference/i.test(clean)){if(Array.isArray(item))likes.push(...item);else if(item!==false&&item!=null)likes.push(item);continue}if(item===true){(/avoid|vermeiden|not_|no_/i.test(clean)?negative:positive).push(label(clean));continue}if(item===false)continue;if(Array.isArray(item)){facts.push(`${label(clean)}: ${list(item)}`);continue}if(item&&typeof item==="object"){const nested=summary(item,clean);if(nested)facts.push(nested.replace(/\.$/,""));continue}if(item!==null&&item!=="")facts.push(`${label(clean)}: ${scalar(item)}`)}
    const sentences=[];if(likes.length)sentences.push(`Mag ${list(likes)}`);if(positive.length)sentences.push(`${list(positive)} trifft zu`);if(negative.length)sentences.push(`${list(negative)} vermeiden`);if(facts.length)sentences.push(...facts);return sentences.length?sentences.map(text=>/[.!?]$/.test(text)?text:`${text}.`).join(" "):"Keine Angaben vorhanden."
  }
  root.MarcelPresentation=Object.freeze({label,status,channel,memoryType,scalar,displayRows,dateTime,summary,topic});
})(globalThis);
