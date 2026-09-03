(function (root) {
  "use strict";

  const labels = Object.freeze({
    primary_language: "Sprache", birthday: "Geburtstag", seeking_new_job: "Arbeit",
    seed_shared_history: "Gemeinsame Geschichte", shared_history: "Gemeinsame Geschichte",
    temporary_state: "Temporärer Zustand", interaction_patterns: "Interaktionsmuster",
    current_context: "Aktueller Kontext", profile_summary: "Profil",
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
    const key=String(value??"").trim().toLowerCase();
    if (!key) return "Keine Angabe";
    if (labels[key]) return labels[key];
    return key.replace(/[_-]+/g," ").replace(/\b\w/g,letter=>letter.toUpperCase());
  }
  function label(value){return labels[String(value??"").toLowerCase()]||humanize(value)}
  function status(value){return statuses[String(value??"").toLowerCase()]||humanize(value)}
  function channel(value){return channels[String(value??"").toLowerCase()]||humanize(value)}
  function memoryType(value){return types[String(value??"").toLowerCase()]||humanize(value)}
  function scalar(value){if(value===null||value===undefined||value==="")return "Keine Angabe";const mapped=words[String(value).toLowerCase()];return mapped||String(value)}
  function displayRows(value, path="") {
    if (Array.isArray(value)) return value.flatMap((item,index)=>displayRows(item,`${path}${path?" · ":""}${index+1}`));
    if (value&&typeof value==="object") return Object.entries(value).flatMap(([key,item])=>displayRows(item,`${path}${path?" · ":""}${label(key)}`));
    return [{ label:path||"Wert", value:scalar(value) }];
  }
  function dateTime(value){if(!value)return "Keine Zeitangabe";const date=new Date(value);return Number.isNaN(date.getTime())?scalar(value):new Intl.DateTimeFormat("de-DE",{dateStyle:"medium",timeStyle:"short"}).format(date)}
  root.MarcelPresentation=Object.freeze({label,status,channel,memoryType,scalar,displayRows,dateTime});
})(globalThis);
