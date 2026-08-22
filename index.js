import express from "express";
import OpenAI from "openai";
import makeWASocket,{DisconnectReason,fetchLatestBaileysVersion,useMultiFileAuthState} from "@whiskeysockets/baileys";
import P from "pino";
import pg from "pg";

const {Pool}=pg;
const app=express();
const port=process.env.PORT||3000;
app.use(express.json({limit:"2mb"}));
app.use(express.urlencoded({extended:true}));

let sock=null;
let whatsappStatus="disabled";
let pairingCode=null;

const logger=P({level:"silent"});
const openai=new OpenAI({apiKey:process.env.OPENAI_API_KEY});
const pool=new Pool({connectionString:process.env.DATABASE_URL});

const WHATSAPP_ENABLED=String(process.env.WHATSAPP_ENABLED||"false").toLowerCase()==="true";
const DUPLICATE_WINDOW_MINUTES=Math.max(1,Number(process.env.DUPLICATE_WINDOW_MINUTES||15));
const MODEL=process.env.OPENAI_MODEL||"gpt-5.6-sol";

const MARCEL_PERSONA_V1_7=`
MARCEL PERSONA V1.7

Du schreibst private Dating-/WhatsApp-Nachrichten im Namen von Marcel.
Conversation first, Memory second.
Die Frau darf niemals merken, dass Regeln oder ein Memory-System dahinterstehen.

MARCEL:
selbstbewusst, entspannt, humorvoll, charmant, direkt, romantisch, verspielt,
sexuell offen, emotional offen, loyal, familienorientiert, in echter Beziehung großzügig,
nicht kontrollierend, ruhig bei Konflikten.

SCHREIBSTIL:
- kurz, natürlich, menschlich
- nicht wie KI, Assistent, Coach, Therapeut oder Kundendienst
- nicht jede Nachricht braucht Frage, Konter, Pointe oder sexuellen Unterton
- Reagieren statt ihre Aussage künstlich zu paraphrasieren
- keine Eigenschaftslisten aus ihrer Nachricht zurückspiegeln
- keine KI-Sätze wie "Jetzt verstehe ich", "Das macht Sinn", "Das muss ich wissen",
  "I have to ask", "Now I need to know", wenn ein Mensch es so nicht schreiben würde
- Fragen dürfen direkt kommen
- grob ihr Investment spiegeln
- bei persönlicher/verletzlicher Nachricht zuerst Wärme
- keine künstlichen abwertenden Kosenamen wie "Fräulein schlechte Laune"
- natürliche Anreden wie amor, mi hermosa, preciosa, princesa, meine Schöne, beautiful sind okay
- Herzen nicht automatisch ans Ende frecher/neckischer Nachrichten hängen
- Emojis sparsam und natürlich

FLIRT:
führend, frech, spielerisch, warm.
Bei Gegenseitigkeit steigern; bei Ausweichen reduzieren; bei Block akzeptieren.
Keine Zustimmung erfinden.

GELD:
Finanzproblem ist nicht automatisch Geldbitte.
Nur bei echter Bitte Grenze setzen.
Vor persönlichem Treffen grundsätzlich kein Geld überweisen.

MARCEL:
41, Geburtstag 7. August, Löwe.
Kinder: Finn 16, Charlotte 14.
Aktuell München/Deutschland.
Definitiver Umzug in ca. 6-8 Wochen nach Medellín.
Deutsch + Englisch, kein Spanisch.
Keine aktuellen Aktivitäten, Reisen, Essen, Musik oder Aufenthalte erfinden.
Solange in Deutschland keine konkreten Kolumbien-Date-Termine festlegen.

TINDER/WHATSAPP:
Tinder nicht reflexartig zu WhatsApp verlagern.
Erst wenn Kommunikation läuft.
Nach 4-5 Tagen eigener Tinder-Funkstille kurz entschuldigen und Busy-/Projektkontext erwähnen.
Wenn WhatsApp angeboten wird, darf der praktische Übersetzungsgrund genannt werden.
Nach Wechsel Verlauf nahtlos fortführen, nicht bei null anfangen.

IDENTITÄTSREGEL:
Gleichnamige Frauen niemals vermischen.
Besonders:
Dani != Daniela (Messe) != Dángela
Kate Castillo != alte Kathe
Paola Maza != ältere Paola
Karla Tinder != Karla Instagram

OUTPUT:
Gib ausschließlich Marcels Nachricht aus.
Keine Analyse, Erklärung, Übersetzung oder Anführungszeichen.
`;

function normalizeText(v){return String(v||"").trim();}
function normalizeForDuplicate(v){return normalizeText(v).toLowerCase().replace(/\s+/g," ").replace(/[“”„"]/g,'"').replace(/[’‘]/g,"'");}
function normalizeIdentityValue(v){return normalizeText(v).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/\s+/g," ").trim();}
function renderJson(v){try{return JSON.stringify(v);}catch{return String(v??"");}}
function safeJsonParse(t,f=null){
  if(!t)return f;
  try{return JSON.parse(t);}catch{}
  const c=String(t).replace(/^```json/i,"").replace(/^```/i,"").replace(/```$/i,"").trim();
  try{return JSON.parse(c);}catch{}
  const a=c.indexOf("{"),b=c.lastIndexOf("}");
  if(a!==-1&&b>a){try{return JSON.parse(c.slice(a,b+1));}catch{}}
  return f;
}
function clampConfidence(v){const n=Number(v);return Number.isNaN(n)?0.5:Math.max(0,Math.min(1,n));}
function clampImportance(v){const n=Number(v);return Number.isNaN(n)?2:Math.max(1,Math.min(5,Math.round(n)));}
function isTestJid(j){return typeof j==="string"&&j.endsWith("@persona.test");}
function isProfileJid(j){return typeof j==="string"&&j.endsWith("@memory.local");}
function createProfileJid(k){return "profile-"+normalizeIdentityValue(k).replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"").slice(0,80)+"@memory.local";}
function createTestSlug(n){return normalizeIdentityValue(n).replace(/[^a-z0-9]+/g,"-").slice(0,40)+"-"+Math.random().toString(36).slice(2,8);}
function cleanIntegerArray(v,m=100){return Array.isArray(v)?[...new Set(v.map(Number).filter(x=>Number.isInteger(x)&&x>0))].slice(0,m):[];}
function extractTextFromMessageContent(c){return c?.conversation||c?.extendedTextMessage?.text||c?.imageMessage?.caption||c?.videoMessage?.caption||"";}
function extractEditedText(u){return extractTextFromMessageContent(u?.message?.editedMessage?.message);}

const PROFILE_COLUMNS=[
"profile_summary","personality","humor_profile","relationship","family","children","social_circle",
"work_education","financial_context","health","religion_values","sexuality_intimacy","communication",
"lifestyle_routines","preferences","dislikes","goals_dreams","travel_future_location","living_situation",
"personal_boundaries","stress_support_style","decision_style","social_media","cultural_interest","investment",
"interaction_patterns","meaningful_details","shared_history","running_gags","open_threads","plans","promises",
"marcel_knowledge_map","current_context"
];

const WOMEN_SEED=[
{identityKey:"zay_20_medellin",canonicalName:"Zay",country:"Colombia",city:"Medellín",language:"Spanish/Some English",sourcePlatform:"tinder",platformStatus:"TINDER_ACTIVE",profile:{
profile_summary:{age:20,notes:["Seit ihrem 16. Lebensjahr unabhängig, also ungefähr vier Jahre.","Ursprünglich aus kleiner Stadt; lebte selbstständig in Cartagena; jetzt Medellín.","Jüngstes Kind; Daddy's Girl und stolz auf Selbstständigkeit."]},
family:{lives_with_brother_in_medellin:true,mother_is_reassured:true},
work_education:{education_completed:true,several_certificates:true,wants_university_again:true,planned_study:"Mikrobiologie und Bioanalyse",english_lessons_paused:true,wants_to_improve_english:true},
preferences:{music:["Vallenato","Silvestre","Poncho"],interests:["Fotografie","Instagram","Kochen","Foodie","Selbstliebe","Lesen","Volleyball","Sprachaustausch","Natur","Fitness"]},
personality:{independent:true,clear_goals:true},
investment:{reinitiated_after_silence:true,examples:["Good morning","good night","He","Hello"]},
running_gags:{independent_woman_and_daddys_girl:true,english_for_spanish_exchange:true},
open_threads:{do_not_ask_again:["Warum seit 16 unabhängig","familienverbunden","warum Bruder","Studium","Englisch"]}}},
{identityKey:"natalia_24_san_cristobal",canonicalName:"Natalia",city:"San Cristóbal",language:"Spanish",sourcePlatform:"tinder",platformStatus:"TINDER_ACTIVE",profile:{
profile_summary:{age:24,height_cm:177},personality:{relaxed:true,calm:true,friendly:true},
relationship:{wants_connection:true,wants_affection:true,wants_open_feelings:true,wants_honest_loving_man:true},
preferences:{likes:["Kino","gutes Essen","gute Gespräche","Filme","Serien","Bücher","Manga","Spaziergänge","Süßigkeiten","True Crime","Plot-Twist-Filme"]},
open_threads:{no_immediate_whatsapp:true}}},
{identityKey:"lu_travel_home_english",canonicalName:"Lu",language:"English/Spanish",sourcePlatform:"tinder",platformStatus:"TINDER_ACTIVE",profile:{
preferences:{likes_home_time_alone:true,travels_a_lot:true},communication:{english_fairly_good:true,says_not_perfect:true},
investment:{liked_marcels_photo:true,said_unusual_message_made_difference:true},open_threads:{do_not_repeat_her_statements:true,no_immediate_whatsapp:true}}},
{identityKey:"lorena_tinder",canonicalName:"Lorena",sourcePlatform:"tinder",platformStatus:"TINDER_ACTIVE",profile:{
investment:{liked_marcels_name:true,liked_non_generic_opener:true},open_threads:{unknown_passion:"Sie sagte, Fotos zeigen ihre Leidenschaft nicht; konkrete Leidenschaft noch unbekannt."}}},
{identityKey:"luu_18",canonicalName:"Luu",language:"Spanish",sourcePlatform:"tinder",platformStatus:"TINDER_ACTIVE",profile:{
profile_summary:{age:18,height_cm:171,adult:true},relationship:{wants_contacts_or_friends:true,open_to_casual_sex:true},
preferences:{likes_motorcycles:true,loves_animals:true,interests:["Shopping","Street Food","TikTok"]},personal_boundaries:{note:"Nicht als reine Beziehungssuche speichern."}}},
{identityKey:"dani_existing_daniela_27_medellin",canonicalName:"Daniela",aliases:["Dani"],country:"Colombia",city:"Medellín",language:"Spanish",sourcePlatform:"whatsapp",platformStatus:"WHATSAPP_ACTIVE",whatsappDisplayName:"Dani",profile:{
profile_summary:{age:27,city:"Medellín"},living_situation:{lives_with_mother_and_siblings:true,context:"Jobverlust; seit ca. 1,5 Monaten dort."},
personality:{extroverted:true,serious_side:true,sin_prisa:true},relationship:{seeks_humble_calm_man:true},
preferences:{love_language:"Geschenke",zodiac:"Taurus"},marcel_knowledge_map:{asked_future_neighborhood:true,knows_move_to_medellin:true},
meaningful_details:{warned_marcel_about_medellin:true},current_context:{whatsapp_name:"Dani",do_not_merge_with_daniela_mass:true}}},
{identityKey:"daniela_mass_separate",canonicalName:"Daniela",aliases:["Daniela Messe"],country:"Colombia",language:"Spanish",sourcePlatform:"whatsapp",platformStatus:"WHATSAPP_ACTIVE",profile:{
religion_values:{self_reported:"Ich gehe jeden Tag zur Messe.",interpretation:"Glaube/Religion scheint wichtig; nicht mehr annehmen als belegt."},
current_context:{separate_person_from_dani:true,whatsapp_active_confirmed:true},open_threads:{early_getting_to_know:true,do_not_invent_religious_assumptions:true}}},
{identityKey:"sandy_san_32",canonicalName:"Sandy",aliases:["San"],language:"Spanish",sourcePlatform:"whatsapp",platformStatus:"WHATSAPP_ACTIVE",profile:{
profile_summary:{age:32},shared_history:{strong_flirt:true,themes:["Dusche","Morgenküsse","acostumbrarnos juntos"],sent_kiss_photo:true,whatsapp_for_photos:true},
communication:{responds_well_to_warmth_and_heart_emojis:true}}},
{identityKey:"karla_tinder_older_men",canonicalName:"Karla",aliases:["Karla Tinder"],sourcePlatform:"tinder",platformStatus:"TINDER_ACTIVE",profile:{
relationship:{attracted_to_older_mature_men:true},open_threads:{age_topic_already_discussed:true,do_not_merge_with_karla_instagram:true}}},
{identityKey:"karla_instagram_bed",canonicalName:"Karla",aliases:["Karla Instagram"],sourcePlatform:"instagram",platformStatus:"CONTACT_KNOWN",profile:{
living_situation:{bed_broken:true,compared_repair_prices_with_mother:true},personality:{affectionate:true,real:true,sensitive:true,loyal:true,independent:true},
religion_values:{catholic_family_background:true},children:{has_children:false},financial_context:{gifts_money_strong_theme:true,asked_early_for_support:true},
personal_boundaries:{marcel_money_boundary_relevant:true},current_context:{do_not_merge_with_karla_tinder:true}}},
{identityKey:"elena_whatsapp",canonicalName:"Elena",sourcePlatform:"whatsapp",platformStatus:"WHATSAPP_ACTIVE",profile:{
relationship:{natural_connection:true,let_it_flow:true,patient:true,no_forcing:true},social_media:{whatsapp:true,instagram:true},
shared_history:{heart_sent:true,nervous_sweet_smile_flirt:true,affectionate_hug_flirt:true}}},
{identityKey:"marcela_medellin_guide",canonicalName:"Marcela",country:"Colombia",city:"Medellín",language:"Spanish",sourcePlatform:"contact",platformStatus:"CONTACT_KNOWN",profile:{
work_education:{tourist_guide:true,spanish_teacher:true,cosmetologist:true},shared_history:{mirador_plan:true,offered_show_medellin:true,offered_massage:true,photo_sent:true},
social_media:{whatsapp_discussed:true,instagram_discussed:true}}},
{identityKey:"michell_home",canonicalName:"Michell",sourcePlatform:"contact",platformStatus:"CONTACT_KNOWN",profile:{preferences:{prefers_home:true,likes_calm_plans:true,likes_cinema:true,likes_food:true}}},
{identityKey:"valeria_adventurous_romantic",canonicalName:"Valeria",sourcePlatform:"contact",platformStatus:"CONTACT_KNOWN",profile:{personality:{sensible:true,adventurous:true,romantic:true}}},
{identityKey:"paola_old_existing",canonicalName:"Paola",aliases:["Paola alt"],sourcePlatform:"contact",platformStatus:"CONTACT_KNOWN",profile:{relationship:{sin_prisa:true,open_to_getting_to_know:true},current_context:{do_not_merge_with_paola_maza:true}}},
{identityKey:"traccy_cosmetology",canonicalName:"Traccy",sourcePlatform:"contact",platformStatus:"CONTACT_KNOWN",profile:{work_education:{cosmetology_student:true,classes_most_of_day:true},running_gags:{lado_travieso:true}}},
{identityKey:"tiana_whatsapp",canonicalName:"Tiana",sourcePlatform:"whatsapp",platformStatus:"WHATSAPP_ACTIVE",profile:{lifestyle_routines:{gym:true,disciplined:true},running_gags:{juice_jugo:true}}},
{identityKey:"evelyn_whatsapp",canonicalName:"Evelyn",sourcePlatform:"whatsapp",platformStatus:"WHATSAPP_ACTIVE",profile:{work_education:{works_in_store:true},shared_history:{noodles_topic:true,working_hours_topic:true}}},
{identityKey:"mafe_whatsapp",canonicalName:"Mafe",sourcePlatform:"whatsapp",platformStatus:"WHATSAPP_ACTIVE",profile:{communication:{attempted_video_call:true},shared_history:{last_known_text:"Que hace"},open_threads:{check_history_before_reply:true}}},
{identityKey:"vanessa_content_money",canonicalName:"Vanessa",sourcePlatform:"contact",platformStatus:"CONTACT_KNOWN",profile:{financial_context:{erotic_content_money_negotiation:true},personal_boundaries:{marcel_rejected_paid_content:true,serious_relationship_emphasized:true}}},
{identityKey:"isabela_university_food",canonicalName:"Isabela",sourcePlatform:"contact",platformStatus:"CONTACT_KNOWN",profile:{financial_context:{asked_for_food_and_university_items:true}}},
{identityKey:"chantall_late_sleep",canonicalName:"Chantall",sourcePlatform:"contact",platformStatus:"CONTACT_KNOWN",profile:{communication:{gave_number:true,late_sleep_4am_topic:true,said_she_thought_marcel_would_write:true}}},
{identityKey:"kira_tinder",canonicalName:"Kira",sourcePlatform:"tinder",platformStatus:"TINDER_ACTIVE",profile:{social_media:{says_no_instagram:true},shared_history:{later_message:"Bien amor"}}},
{identityKey:"milena_work_question",canonicalName:"Milena",sourcePlatform:"contact",platformStatus:"CONTACT_KNOWN",profile:{marcel_knowledge_map:{asked_what_marcel_does_for_work:true}}},
{identityKey:"dayana_vargas",canonicalName:"Dayana Vargas",sourcePlatform:"contact",platformStatus:"CONTACT_KNOWN",profile:{shared_history:{topics:["palabras","no soy así"],photo_with_smile:true,asked:"¿por qué problema?"}}},
{identityKey:"lizeth_32",canonicalName:"Lizeth",sourcePlatform:"tinder",platformStatus:"WHATSAPP_INVITED",profile:{
profile_summary:{age:32},relationship:{does_not_want_casual:true},preferences:{little_party:true,prefers_calm_plans:true,likes_food_and_conversation:true},
shared_history:{important_quote:"me quedaría contigo",meaning:"Ich würde bei dir bleiben.",date_closeness_flirt:true},
open_threads:{do_not_ask_party_vs_calm_again:true,do_not_overinterpret_quote:true}}},
{identityKey:"stephanie_peace",canonicalName:"Stephanie",sourcePlatform:"contact",platformStatus:"CONTACT_KNOWN",profile:{preferences:{prefers_peace_calm:true}}},
{identityKey:"kathe_old_unclear",canonicalName:"Kathe",aliases:["Kathe alt"],sourcePlatform:"contact",platformStatus:"CONTACT_KNOWN",profile:{personality:{strong_temper:true},current_context:{do_not_merge_with_kate_castillo:true}}},
{identityKey:"dulce_working",canonicalName:"Dulce",sourcePlatform:"contact",platformStatus:"CONTACT_KNOWN",profile:{current_context:{last_known:"working"}}},
{identityKey:"miri_busy",canonicalName:"Miri",sourcePlatform:"contact",platformStatus:"CONTACT_KNOWN",profile:{current_context:{busy_day:true,wanted_to_rest:true}}},
{identityKey:"anggie_23",canonicalName:"Anggie",sourcePlatform:"tinder",platformStatus:"WHATSAPP_INVITED",profile:{
profile_summary:{age:23},marcel_knowledge_map:{knows_move_to_medellin:true,knows_self_employed_projects:true},
relationship:{wants_to_feel_again:true,misses_affection:true,wants_someone_by_side:true},running_gags:{profesora_language_translator:true},
shared_history:{tinder_silence_explained_by_projects:true,whatsapp_offered_for_translation:true},
open_threads:{do_not_treat_profesora_as_new:true,do_not_repeat_emotional_openness:true}}},
{identityKey:"maye_existing",canonicalName:"Maye",country:"Colombia",language:"Spanish",sourcePlatform:"whatsapp",platformStatus:"WHATSAPP_ACTIVE",profile:{
personality:{romantic:true,temperamental:true,self_description_context:["mala clase","mal genio"]},
stress_support_style:{needs_distance_when_really_serious:true},personal_boundaries:{values_respectful_treatment:true,says_she_would_not_treat_badly:true},
running_gags:{temper_vs_romantic_side:true},shared_history:{whatsapp_reason:"Tinder-Inaktivität + Übersetzung"},
open_threads:{no_abusive_nickname_from_traits:true,natural_warm_addresses_ok:true,do_not_repeat_conflict_questions:true},current_context:{whatsapp_active_confirmed:true}}},
{identityKey:"and_different_writing",canonicalName:"And",sourcePlatform:"contact",platformStatus:"CONTACT_KNOWN",profile:{meaningful_details:{quote_meaning:"Sie akzeptierte Marcel, weil er anders geschrieben hat."}}},
{identityKey:"neicy_soy_lo_que_ves",canonicalName:"Neicy",sourcePlatform:"contact",platformStatus:"CONTACT_KNOWN",profile:{meaningful_details:{quote:"soy lo que ves",meaning:"Ich bin, was du siehst."}}},
{identityKey:"eri_buenos_dias",canonicalName:"Eri",sourcePlatform:"contact",platformStatus:"CONTACT_KNOWN",profile:{current_context:{last_known:"Buenos días 💋"}}},
{identityKey:"alejandra_bien_y_tu",canonicalName:"Alejandra",sourcePlatform:"contact",platformStatus:"CONTACT_KNOWN",profile:{current_context:{last_known:"Bien y tú"}}},
{identityKey:"yudi_existing",canonicalName:"Yudi",country:"Colombia",language:"Spanish",sourcePlatform:"tinder",platformStatus:"WHATSAPP_INVITED",profile:{
relationship:{seeks_serious_relationship:true},preferences:{likes_travel:true,fitness:true,likes_new_things:true},
running_gags:{spanish_teacher:true,marcel_teaches_german:true},shared_history:{she_offered_teach_spanish:true,whatsapp_offered_number_sent:true},
open_threads:{do_not_ask_again_about_teaching_spanish:true}}},
{identityKey:"niuber_save_pool",canonicalName:"Niuber",sourcePlatform:"tinder",platformStatus:"SAVE_POOL",profile:{current_context:{insufficient_detail_profile:true}}},
{identityKey:"nicol_save_pool",canonicalName:"Nicol",sourcePlatform:"tinder",platformStatus:"SAVE_POOL",profile:{current_context:{insufficient_detail_profile:true}}},
{identityKey:"jesila_save_pool",canonicalName:"Jesila",sourcePlatform:"tinder",platformStatus:"SAVE_POOL",profile:{current_context:{insufficient_detail_profile:true}}},
{identityKey:"karol_save_pool",canonicalName:"Karol",sourcePlatform:"tinder",platformStatus:"SAVE_POOL",profile:{current_context:{insufficient_detail_profile:true}}},
{identityKey:"geral_27_colombia",canonicalName:"Geral",country:"Colombia",language:"Spanish",sourcePlatform:"whatsapp",platformStatus:"WHATSAPP_ACTIVE",profile:{
profile_summary:{age:27},relationship:{not_forcing_serious:true,open_to_serious_if_develops:true},personality:{warm_playful:true},
investment:{reinitiated_after_pause:true,used_carino:true,asked_how_marcel_is:true},running_gags:{local_guide_medellin_flirt:true},
shared_history:{whatsapp_reason:"wenig Tinder + Übersetzung"},open_threads:{do_not_reexplain_tinder_inactivity:true},
current_context:{whatsapp_active_confirmed:true,correct_spelling:"Geral",not_gerald:true}}},
{identityKey:"nia_30",canonicalName:"Nia",sourcePlatform:"tinder",platformStatus:"TINDER_ACTIVE",profile:{
profile_summary:{age:30},personality:{initially_shy:true,very_funny_with_trust:true},
preferences:{likes:["Kulturen/Menschen","Tanzen","Kochen","Sport","Filme","Unternehmungen"]},
investment:{complimented_marcel:"estás muy guapo"},shared_history:{said_marcel_must_find_out_if_she_is_interesting:true},
open_threads:{no_whatsapp_push_yet:true,shy_funny_side_playful_not_interview:true}}},
{identityKey:"sarah_26_teacher",canonicalName:"Sarah",country:"Colombia",language:"English",sourcePlatform:"tinder",platformStatus:"TINDER_ACTIVE",profile:{
profile_summary:{age:26,nationality:"Colombian",profession:"Teacher"},relationship:{serious_or_see_what_develops:true},
preferences:{likes:["Reisen","Natur","Picknick","Camping","gutes Essen","Strandbars","Cocktails","Pole-Dancing"]},
investment:{liked_marcels_photo:true},communication:{speaks_english:true},shared_history:{noted_marcel_did_not_know_english:true},
open_threads:{use_english_directly:true,no_whatsapp_push_early:true}}},
{identityKey:"kate_castillo_31_medellin",canonicalName:"Kate Castillo",aliases:["Kathe Castillo"],country:"Colombia",city:"Medellín",language:"Spanish",sourcePlatform:"whatsapp",platformStatus:"WHATSAPP_ACTIVE",phoneNumber:"573242540896",whatsappDisplayName:"Kate Castillo",profile:{
profile_summary:{age:31,city:"Medellín"},personality:{extroverted:true,friendly:true,strong_temper:true,affectionate:true,not_overly_clingy:true},
relationship:{wants_real_honest_man:true,wants_man_who_knows_what_he_wants:true,no_forcing:true,time_and_interest_show_direction:true},
stress_support_style:{values_communication_trust_security:true,can_get_angry_then_wants_affection:true},
sexuality_intimacy:{hugs_kisses_closeness_flirt:true},running_gags:{hugs_looks_kisses_common_language:true},
shared_history:{would_take_closeness_risk:true,does_not_need_anger_for_affection:true},
open_threads:{do_not_ask_again_hugs_kisses:true,do_not_assume_clinginess:true},
current_context:{whatsapp_active_confirmed:true,correct_name:"Kate Castillo",old_spelling:"Kathe Castillo",do_not_merge_old_kathe:true}}},
{identityKey:"laura_26_medellin",canonicalName:"Laura",country:"Colombia",city:"Medellín",language:"Spanish",sourcePlatform:"tinder",platformStatus:"TINDER_ACTIVE",profile:{
profile_summary:{age:26,city:"Medellín"},personality:{independent:true},relationship:{wants_positive_contribution:true,wants_care_and_pampering:true},
preferences:{likes_attention:true,likes_flowers_without_occasion:true},open_threads:{do_not_assume_money_orientation:true}}},
{identityKey:"dangela_26_venezuela_medellin",canonicalName:"Dángela",aliases:["Dangela"],country:"Colombia",city:"Medellín",language:"Spanish",sourcePlatform:"whatsapp",platformStatus:"WHATSAPP_ACTIVE",profile:{
profile_summary:{age:26,nationality:"Venezuelan",medellin_about_years:8},family:{mother_from_colombia:true,much_family_in_colombia:true},
relationship:{seeks_serious_relationship:true},preferences:{loves_dancing:true,likes_romeo_santos:true,goes_out_with_friends:true},
shared_history:{offered_food:true,offered_show_medellin:true,nervous_flirt:"eso depende",marcel_must_find_out_in_person:true,translator_then_without_words:true,she_confirmed_plan:"Perfecto / Un buen plan"},
running_gags:{dancing_food_medellin_looks_language:true},marcel_knowledge_map:{knows_marcel_no_spanish:true},
open_threads:{do_not_reexplain_no_spanish:true,continue_tinder_history_on_whatsapp:true},current_context:{whatsapp_active_confirmed:true}}},
{identityKey:"veronica_29_medellin",canonicalName:"Veronica",country:"Colombia",city:"Medellín",language:"Spanish/English",sourcePlatform:"tinder",platformStatus:"TINDER_ACTIVE",profile:{
profile_summary:{age:29,city:"Medellín",speaks_spanish:true,speaks_english:true},relationship:{no_casual_sex:true,no_mutual_benefits:true,wants_people_friends_language_exchange:true},
travel_future_location:{new_in_medellin:true},preferences:{likes:["Süßes","Street Food","Outdoor","Tanzen"]},meaningful_details:{birthday_day_of_first_chat:true},
open_threads:{english_can_be_used:true,do_not_ignore_no_casual_boundary:true}}},
{identityKey:"luisa_23_medellin",canonicalName:"Luisa",country:"Colombia",city:"Medellín",language:"Spanish",sourcePlatform:"tinder",platformStatus:"TINDER_ACTIVE",profile:{
profile_summary:{age:23,city:"Medellín",height_cm:155,university_profile:"Universidad Alfonso Reyes, S.C.",double_date_friend:"Manu"},
personality:{original:["chévere","respetuosa","parchada"],relaxed:true,respectful:true,adventurous:true},
relationship:{dating_intent_original:"Conocer y disfrutar por el momento",meaning:"Im Moment kennenlernen und genießen.",not_confirmed_casual_only:true},
sexuality_intimacy:{light_double_meaning_not_rejected:true},
open_threads:{do_not_list_back_traits:true,treat_dating_intent_as_current_changeable:true}}},
{identityKey:"salome_26_cali",canonicalName:"Salome",country:"Colombia",city:"Cali",language:"Spanish",sourcePlatform:"tinder",platformStatus:"WHATSAPP_INVITED",phoneNumber:"573005092127",profile:{
profile_summary:{age:26,city:"Cali"},relationship:{not_serious_required_but_open_to_serious:true},
preferences:{likes:["Selbstliebe","Street Food","Kochen","Musik","Unternehmertum","Walking"]},
shared_history:{gave_whatsapp_number:true,number:"+57 300 509 2127",said_write_me_if_you_want:true},
open_threads:{she_initiated_move:true,first_whatsapp_short:true,active_only_after_actual_message:true}}},
{identityKey:"paola_maza_20",canonicalName:"Paola Maza",country:"Colombia",language:"Spanish/Some English",sourcePlatform:"tinder",platformStatus:"WHATSAPP_INVITED",profile:{
profile_summary:{age:20},personality:{respectful:true,says_good_heart:true},lifestyle_routines:{gym_important:true,disciplined:true},
preferences:{likes:["gutes Essen","Reisen","Filme","Spaziergänge"]},relationship:{tinder_goal:"Feste Beziehung, mal sehen"},
communication:{some_english:true},shared_history:{sent_wave_first:true,accepted_whatsapp:true,quote:"You WhatsApp it is",marcel_number_sent:true},
current_context:{do_not_merge_other_paola:true,waiting_for_whatsapp_message:true}}}
];

async function initDatabase(){
  await pool.query(`CREATE TABLE IF NOT EXISTS contacts(id SERIAL PRIMARY KEY,whatsapp_jid TEXT UNIQUE NOT NULL,created_at TIMESTAMPTZ DEFAULT NOW(),updated_at TIMESTAMPTZ DEFAULT NOW())`);
  await pool.query(`ALTER TABLE contacts
    ADD COLUMN IF NOT EXISTS phone_number TEXT,
    ADD COLUMN IF NOT EXISTS display_name TEXT,
    ADD COLUMN IF NOT EXISTS nickname TEXT,
    ADD COLUMN IF NOT EXISTS country TEXT,
    ADD COLUMN IF NOT EXISTS city TEXT,
    ADD COLUMN IF NOT EXISTS timezone TEXT,
    ADD COLUMN IF NOT EXISTS primary_language TEXT,
    ADD COLUMN IF NOT EXISTS source_platform TEXT,
    ADD COLUMN IF NOT EXISTS source_profile_name TEXT,
    ADD COLUMN IF NOT EXISTS contact_status TEXT DEFAULT 'active',
    ADD COLUMN IF NOT EXISTS relationship_stage TEXT DEFAULT 'new',
    ADD COLUMN IF NOT EXISTS auto_reply_enabled BOOLEAN DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS date_lock_enabled BOOLEAN DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS manual_review_required BOOLEAN DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS location_context JSONB DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS relocation_context JSONB DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS first_contact_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS last_message_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS memory_identity_key TEXT,
    ADD COLUMN IF NOT EXISTS canonical_name TEXT,
    ADD COLUMN IF NOT EXISTS whatsapp_display_name TEXT,
    ADD COLUMN IF NOT EXISTS current_platform TEXT,
    ADD COLUMN IF NOT EXISTS platform_status TEXT,
    ADD COLUMN IF NOT EXISTS identity_locked BOOLEAN DEFAULT FALSE`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_memory_identity_key ON contacts(memory_identity_key) WHERE memory_identity_key IS NOT NULL`);
  await pool.query(`CREATE TABLE IF NOT EXISTS contact_identifiers(
    id BIGSERIAL PRIMARY KEY,contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    identifier_type TEXT NOT NULL,identifier_value TEXT NOT NULL,normalized_value TEXT NOT NULL,
    source_platform TEXT,is_primary BOOLEAN DEFAULT FALSE,human_verified BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),updated_at TIMESTAMPTZ DEFAULT NOW())`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_contact_identifiers_contact ON contact_identifiers(contact_id)`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_contact_identifiers_strong_unique
    ON contact_identifiers(identifier_type,normalized_value)
    WHERE identifier_type IN ('identity_key','phone','whatsapp_jid')`);

  await pool.query(`CREATE TABLE IF NOT EXISTS messages(
    id BIGSERIAL PRIMARY KEY,whatsapp_jid TEXT NOT NULL,direction TEXT NOT NULL,message_text TEXT,
    whatsapp_message_id TEXT,created_at TIMESTAMPTZ DEFAULT NOW())`);
  await pool.query(`ALTER TABLE messages
    ADD COLUMN IF NOT EXISTS is_edited BOOLEAN DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS original_message_text TEXT,
    ADD COLUMN IF NOT EXISTS processing_status TEXT DEFAULT 'processed',
    ADD COLUMN IF NOT EXISTS duplicate_of_message_id BIGINT REFERENCES messages(id) ON DELETE SET NULL`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_messages_jid_id ON messages(whatsapp_jid,id DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_messages_whatsapp_id ON messages(whatsapp_jid,whatsapp_message_id)`);

  await pool.query(`CREATE TABLE IF NOT EXISTS contact_memory_profiles(
    id BIGSERIAL PRIMARY KEY,contact_id INTEGER UNIQUE NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    ${PROFILE_COLUMNS.map(c=>`${c} JSONB DEFAULT '{}'::jsonb`).join(",")},
    profile_version INTEGER DEFAULT 1,last_memory_update_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),updated_at TIMESTAMPTZ DEFAULT NOW())`);

  await pool.query(`CREATE TABLE IF NOT EXISTS memory_items(
    id BIGSERIAL PRIMARY KEY,contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    category TEXT NOT NULL,memory_key TEXT NOT NULL,memory_value JSONB NOT NULL DEFAULT '{}'::jsonb,
    memory_type TEXT NOT NULL DEFAULT 'interpretation',confidence NUMERIC(4,3) DEFAULT 0.5,
    source_message_id BIGINT REFERENCES messages(id) ON DELETE SET NULL,source_quote TEXT,
    source_context JSONB DEFAULT '{}'::jsonb,valid_from TIMESTAMPTZ DEFAULT NOW(),valid_until TIMESTAMPTZ,
    status TEXT DEFAULT 'active',supersedes_memory_id BIGINT REFERENCES memory_items(id) ON DELETE SET NULL,
    human_review_status TEXT DEFAULT 'unreviewed',human_corrected_value JSONB,human_note TEXT,human_reviewed_at TIMESTAMPTZ,
    importance INTEGER DEFAULT 2,use_in_reply BOOLEAN DEFAULT TRUE,created_at TIMESTAMPTZ DEFAULT NOW(),updated_at TIMESTAMPTZ DEFAULT NOW())`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_memory_items_contact_active ON memory_items(contact_id,status,importance DESC,updated_at DESC)`);

  await pool.query(`CREATE TABLE IF NOT EXISTS memory_events(
    id BIGSERIAL PRIMARY KEY,contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL,event_subtype TEXT,title TEXT,event_data JSONB DEFAULT '{}'::jsonb,
    started_at TIMESTAMPTZ DEFAULT NOW(),ended_at TIMESTAMPTZ,event_status TEXT DEFAULT 'active',
    importance INTEGER DEFAULT 2,sensitivity TEXT DEFAULT 'normal',source_message_ids JSONB DEFAULT '[]'::jsonb,
    evidence_summary TEXT,related_memory_item_ids JSONB DEFAULT '[]'::jsonb,
    related_event_id BIGINT REFERENCES memory_events(id) ON DELETE SET NULL,requires_follow_up BOOLEAN DEFAULT FALSE,
    follow_up_after TIMESTAMPTZ,follow_up_status TEXT DEFAULT 'none',bot_action TEXT,
    marcel_review_required BOOLEAN DEFAULT FALSE,created_at TIMESTAMPTZ DEFAULT NOW(),updated_at TIMESTAMPTZ DEFAULT NOW())`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_memory_events_contact_active ON memory_events(contact_id,event_status,importance DESC,started_at DESC)`);

  await pool.query(`CREATE TABLE IF NOT EXISTS media(
    id BIGSERIAL PRIMARY KEY,contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    message_id BIGINT REFERENCES messages(id) ON DELETE SET NULL,whatsapp_message_id TEXT,media_type TEXT,mime_type TEXT,
    storage_path TEXT,thumbnail_path TEXT,is_view_once BOOLEAN DEFAULT FALSE,view_once_status TEXT DEFAULT 'unknown',
    caption TEXT,ai_description TEXT,ai_tags JSONB DEFAULT '[]'::jsonb,sensitivity TEXT DEFAULT 'normal',
    sexual_media_context JSONB DEFAULT '{}'::jsonb,memory_relevance INTEGER DEFAULT 1,
    related_memory_item_ids JSONB DEFAULT '[]'::jsonb,related_event_ids JSONB DEFAULT '[]'::jsonb,
    received_at TIMESTAMPTZ DEFAULT NOW(),created_at TIMESTAMPTZ DEFAULT NOW(),updated_at TIMESTAMPTZ DEFAULT NOW())`);

  await pool.query(`CREATE TABLE IF NOT EXISTS marcel_memory(
    id BIGSERIAL PRIMARY KEY,category TEXT NOT NULL,memory_key TEXT NOT NULL UNIQUE,
    memory_value JSONB NOT NULL DEFAULT '{}'::jsonb,status TEXT DEFAULT 'active',importance INTEGER DEFAULT 3,
    sensitivity TEXT DEFAULT 'normal',source_type TEXT DEFAULT 'marcel',human_verified BOOLEAN DEFAULT TRUE,
    valid_from TIMESTAMPTZ DEFAULT NOW(),valid_until TIMESTAMPTZ,allowed_for_bot BOOLEAN DEFAULT TRUE,
    usage_notes TEXT,created_at TIMESTAMPTZ DEFAULT NOW(),updated_at TIMESTAMPTZ DEFAULT NOW())`);

  await pool.query(`CREATE TABLE IF NOT EXISTS marcel_live_state(
    id INTEGER PRIMARY KEY DEFAULT 1 CHECK(id=1),current_country TEXT,current_city TEXT,current_timezone TEXT,
    location_status TEXT DEFAULT 'living',location_verified_at TIMESTAMPTZ DEFAULT NOW(),
    relocation_target_country TEXT,relocation_target_city TEXT,relocation_stage TEXT,relocation_eta TEXT,
    temporary_travel_country TEXT,temporary_travel_city TEXT,temporary_travel_until TIMESTAMPTZ,
    housing_stage TEXT,manual_location_lock BOOLEAN DEFAULT TRUE,updated_by TEXT DEFAULT 'marcel',
    updated_at TIMESTAMPTZ DEFAULT NOW())`);
  await pool.query(`INSERT INTO marcel_live_state(id,current_country,current_city,current_timezone,location_status,
    relocation_target_country,relocation_target_city,relocation_stage,relocation_eta,housing_stage,manual_location_lock,updated_by)
    VALUES(1,'Germany','Munich','Europe/Berlin','living','Colombia','Medellín','planned','approximately 6 to 8 weeks','not_arrived',TRUE,'marcel')
    ON CONFLICT(id) DO NOTHING`);

  await seedMarcelMemory();
  await seedWomenMemory();
  console.log("PostgreSQL + Langzeit-Memory V1.7 + Frauen-Memory + Identity Registry bereit.");
}

async function seedMarcelMemory(){
  const memories=[
    ["identity","age",{years:41},4,"Nicht ungefragt mit Alter anfangen."],
    ["identity","birthday",{day:7,month:"August",zodiac:"Leo"},2,"Nur natürlich verwenden."],
    ["languages","spoken_languages",{german:true,english:true,spanish:false},5,"Spanisch ist praktische Einschränkung."],
    ["work","self_employed",{self_employed:true,various_projects:true,location_flexible:true},3,"Aktuelle konkrete Tätigkeit niemals erfinden."],
    ["family","children",{count:2,son:{name:"Finn",age:16},daughter:{name:"Charlotte",age:14}},5,"Know a lot, reveal naturally."],
    ["communication","warmth_balance",{loving:true,cheeky:true,avoid_emoji_overload:true,avoid_ai_phrases:true,do_not_paraphrase:true,no_mechanical_question:true,avoid_trait_catalogues:true},5,"Menschlich schreiben."],
    ["communication","tinder_whatsapp_transition",{do_not_move_immediately:true,after_4_5_days_silence_short_busy_apology:true,translation_reason_valid:true,continue_history:true},5,"WhatsApp erst wenn Kommunikation läuft."],
    ["nicknames","romantic_address_style",{preferred:["meine Schöne","meine Hübsche","mi hermosa","preciosa","amor","princesa","beautiful"],avoid_artificial:true},5,"Keine künstlichen Spitznamen."],
    ["communication","emoji_style",{hearts_not_automatic:true,hearts_only_if_warmth_fits:true},4,"Freche Nachricht braucht kein Herz."],
    ["lifestyle","alcohol_and_smoking",{marcel_drinks_alcohol:false,partner_drinking_is_ok:true,partner_smoking_is_ok:true},4,"Nie behaupten Marcel trinkt."],
    ["food_drinks","favorite_food",{name:"German beef roulades"},2,"Natürlich verwenden."],
    ["food_drinks","favorite_drink",{name:"Spezi",explanation:"Cola-Orangen-Limonaden-Mix"},2,"Falls unbekannt kurz erklären."],
    ["skills","cooking",{likes_cooking:true,cooks_well:true},2,"Natürlich verwenden."],
    ["personal_stories","sister_burned_water",{sister_older_by_years:1.5,story:"Schwester hat einmal Wasser im Topf anbrennen lassen."},1,"Nur passend."],
    ["personal_stories","fathers_car_at_14",{story:"Mit 14 Auto des Vaters genommen und von Polizei erwischt."},1,"Nur passend."],
    ["family","parents_long_marriage",{parents_still_married:true,years_over:44},2,"Nur wenn relevant."],
    ["relationship_history","longest_relationship",{years:14,partner:"mother_of_children"},3,"Nicht ungefragt."],
    ["relationship_values","partner_freedom",{partner_can_go_out_without_marcel:true,male_best_friend_ok:true,ex_contact_can_be_ok:true,marcel_values_own_time:true},3,"Kontextabhängig."],
    ["marriage_religion","marriage_and_religion",{never_married:true,open_to_marriage:true,marriage_required:false,religion:"atheist"},3,"Nur wenn relevant."],
    ["sexuality","orientation_and_ffm",{orientation:"heterosexual",open_to_ffm:true,interested_in_male_third_party:false},5,"Nur bei offenem Sexualgespräch."],
    ["communication","contact_style",{likes_frequent_contact:true,likes_writing_a_lot:true,prolonged_silence_matters:true},4,"Viel Kontakt, nicht hinterherlaufen."],
    ["housing","arrival_housing_plan",{temporary_months:"1-2",temporary_options:["hotel","vacation_apartment"],permanent_plan:"Vor Ort feste Unterkunft in sicherer Gegend suchen."},4,"Keine konkrete Gegend erfinden."]
  ];

  for(const [category,key,value,importance,usage] of memories){
    await pool.query(`INSERT INTO marcel_memory(category,memory_key,memory_value,importance,usage_notes,human_verified,allowed_for_bot)
      VALUES($1,$2,$3::jsonb,$4,$5,TRUE,TRUE)
      ON CONFLICT(memory_key) DO UPDATE SET category=EXCLUDED.category,memory_value=EXCLUDED.memory_value,
      importance=EXCLUDED.importance,usage_notes=EXCLUDED.usage_notes,updated_at=NOW()`,
      [category,key,JSON.stringify(value),importance,usage]);
  }
}

async function addContactIdentifier({contactId,type,value,sourcePlatform=null,isPrimary=false}){
  const clean=normalizeText(value);
  if(!contactId||!clean)return;

  const norm=normalizeIdentityValue(clean);

  if(["identity_key","phone","whatsapp_jid"].includes(type)){
    const x=await pool.query(
      `SELECT contact_id FROM contact_identifiers
       WHERE identifier_type=$1 AND normalized_value=$2
       LIMIT 1`,
      [type,norm]
    );

    if(x.rows[0]&&x.rows[0].contact_id!==contactId){
      throw new Error(`Identity-Konflikt: ${type} ${clean} gehört bereits Kontakt ${x.rows[0].contact_id}`);
    }
  }

  const same=await pool.query(
    `SELECT id FROM contact_identifiers
     WHERE contact_id=$1 AND identifier_type=$2 AND normalized_value=$3
     LIMIT 1`,
    [contactId,type,norm]
  );

  if(same.rows[0]){
    await pool.query(
      `UPDATE contact_identifiers
       SET identifier_value=$2,
           source_platform=COALESCE($3,source_platform),
           is_primary=is_primary OR $4,
           updated_at=NOW()
       WHERE id=$1`,
      [same.rows[0].id,clean,sourcePlatform,isPrimary]
    );
  }else{
    await pool.query(
      `INSERT INTO contact_identifiers(
         contact_id,
         identifier_type,
         identifier_value,
         normalized_value,
         source_platform,
         is_primary,
         human_verified
       )
       VALUES($1,$2,$3,$4,$5,$6,TRUE)`,
      [contactId,type,clean,norm,sourcePlatform,isPrimary]
    );
  }
}

async function findContactByIdentifier(type,value){
  const norm=normalizeIdentityValue(value);
  if(!norm)return null;

  const r=await pool.query(
    `SELECT c.*
     FROM contact_identifiers i
     JOIN contacts c ON c.id=i.contact_id
     WHERE i.identifier_type=$1
       AND i.normalized_value=$2
     ORDER BY i.is_primary DESC,i.id ASC
     LIMIT 1`,
    [type,norm]
  );

  return r.rows[0]||null;
}

async function getContactByIdentityKey(key){
  const r=await pool.query(
    `SELECT *
     FROM contacts
     WHERE memory_identity_key=$1
     LIMIT 1`,
    [key]
  );

  return r.rows[0]||null;
}

async function ensureWomanProfile(w){
  let c=await getContactByIdentityKey(w.identityKey);
  const phone=w.phoneNumber?String(w.phoneNumber).replace(/\D/g,""):null;

  if(!c&&phone){
    c=await findContactByIdentifier("phone",phone);
  }

  if(!c){
    const r=await pool.query(
      `INSERT INTO contacts(
        whatsapp_jid,
        display_name,
        canonical_name,
        memory_identity_key,
        identity_locked,
        phone_number,
        country,
        city,
        primary_language,
        source_platform,
        current_platform,
        platform_status,
        whatsapp_display_name,
        contact_status,
        relationship_stage,
        auto_reply_enabled,
        date_lock_enabled,
        first_contact_at,
        updated_at
      )
      VALUES(
        $1,$2,$2,$3,TRUE,$4,$5,$6,$7,$8,$8,$9,$10,
        'active','new',TRUE,FALSE,NOW(),NOW()
      )
      RETURNING *`,
      [
        createProfileJid(w.identityKey),
        w.canonicalName,
        w.identityKey,
        phone,
        w.country||null,
        w.city||null,
        w.language||null,
        w.sourcePlatform||null,
        w.platformStatus||null,
        w.whatsappDisplayName||null
      ]
    );

    c=r.rows[0];
  }else{
    const r=await pool.query(
      `UPDATE contacts
       SET canonical_name=COALESCE($2,canonical_name),
           display_name=COALESCE(display_name,$2),
           phone_number=COALESCE($3,phone_number),
           country=COALESCE($4,country),
           city=COALESCE($5,city),
           primary_language=COALESCE($6,primary_language),
           source_platform=COALESCE(source_platform,$7),
           current_platform=COALESCE($7,current_platform),
           platform_status=COALESCE($8,platform_status),
           whatsapp_display_name=COALESCE($9,whatsapp_display_name),
           memory_identity_key=COALESCE(memory_identity_key,$10),
           identity_locked=TRUE,
           updated_at=NOW()
       WHERE id=$1
       RETURNING *`,
      [
        c.id,
        w.canonicalName,
        phone,
        w.country||null,
        w.city||null,
        w.language||null,
        w.sourcePlatform||null,
        w.platformStatus||null,
        w.whatsappDisplayName||null,
        w.identityKey
      ]
    );

    c=r.rows[0];
  }

  await pool.query(
    `INSERT INTO contact_memory_profiles(contact_id)
     VALUES($1)
     ON CONFLICT(contact_id) DO NOTHING`,
    [c.id]
  );

  await addContactIdentifier({
    contactId:c.id,
    type:"identity_key",
    value:w.identityKey,
    isPrimary:true
  });

  await addContactIdentifier({
    contactId:c.id,
    type:"canonical_name",
    value:w.canonicalName,
    isPrimary:true
  });

  for(const a of w.aliases||[]){
    await addContactIdentifier({
      contactId:c.id,
      type:"alias",
      value:a
    });
  }

  if(phone){
    await addContactIdentifier({
      contactId:c.id,
      type:"phone",
      value:phone,
      sourcePlatform:"whatsapp",
      isPrimary:true
    });
  }

  if(w.whatsappDisplayName){
    await addContactIdentifier({
      contactId:c.id,
      type:"whatsapp_display_name",
      value:w.whatsappDisplayName,
      sourcePlatform:"whatsapp"
    });
  }

  return c;
}

async function upsertVerifiedSeedMemory({
  contactId,
  category,
  memoryKey,
  memoryValue,
  importance=3
}){
  const r=await pool.query(
    `SELECT *
     FROM memory_items
     WHERE contact_id=$1
       AND category=$2
       AND memory_key=$3
       AND status='active'
     ORDER BY id DESC
     LIMIT 1`,
    [contactId,category,memoryKey]
  );

  if(r.rows[0]){
    await pool.query(
      `UPDATE memory_items
       SET memory_value=$2::jsonb,
           memory_type='explicit_fact',
           confidence=1.0,
           human_review_status='confirmed',
           human_note='Manuell gepflegtes Frauen-Memory UPDATE3.',
           human_reviewed_at=NOW(),
           importance=$3,
           use_in_reply=TRUE,
           updated_at=NOW()
       WHERE id=$1`,
      [
        r.rows[0].id,
        JSON.stringify(memoryValue),
        clampImportance(importance)
      ]
    );
  }else{
    await pool.query(
      `INSERT INTO memory_items(
         contact_id,
         category,
         memory_key,
         memory_value,
         memory_type,
         confidence,
         status,
         human_review_status,
         human_note,
         human_reviewed_at,
         importance,
         use_in_reply
       )
       VALUES(
         $1,$2,$3,$4::jsonb,
         'explicit_fact',
         1.0,
         'active',
         'confirmed',
         'Manuell gepflegtes Frauen-Memory UPDATE3.',
         NOW(),
         $5,
         TRUE
       )`,
      [
        contactId,
        category,
        memoryKey,
        JSON.stringify(memoryValue),
        clampImportance(importance)
      ]
    );
  }
}

async function applyProfileSnapshot(
  contactId,
  snapshot,
  {humanSeed=false}={}
){
  const current=await getContactMemoryProfile(contactId);

  const vals=PROFILE_COLUMNS.map(c=>{
    const incoming=
      snapshot?.[c]
      &&
      typeof snapshot[c]==="object"
      &&
      !Array.isArray(snapshot[c])
        ? snapshot[c]
        : {};

    if(
      !humanSeed
      &&
      current?.[c]
      &&
      typeof current[c]==="object"
      &&
      Object.keys(current[c]).length>0
      &&
      Object.keys(incoming).length===0
    ){
      return JSON.stringify(current[c]);
    }

    return JSON.stringify(incoming);
  });

  const sets=PROFILE_COLUMNS.map(
    (c,i)=>`${c}=$${i+1}::jsonb`
  );

  vals.push(contactId);

  await pool.query(
    `UPDATE contact_memory_profiles
     SET ${sets.join(",")},
         profile_version=profile_version+1,
         last_memory_update_at=NOW(),
         updated_at=NOW()
     WHERE contact_id=$${PROFILE_COLUMNS.length+1}`,
    vals
  );
}

async function seedWomenMemory(){
  for(const w of WOMEN_SEED){
    const c=await ensureWomanProfile(w);

    const snapshot=Object.fromEntries(
      PROFILE_COLUMNS.map(
        k=>[k,w.profile?.[k]||{}]
      )
    );

    await applyProfileSnapshot(
      c.id,
      snapshot,
      {humanSeed:true}
    );

    for(const k of PROFILE_COLUMNS){
      const v=snapshot[k];

      if(
        v
        &&
        typeof v==="object"
        &&
        !Array.isArray(v)
        &&
        Object.keys(v).length
      ){
        await upsertVerifiedSeedMemory({
          contactId:c.id,
          category:k,
          memoryKey:`seed_${k}`,
          memoryValue:v,
          importance:[
            "current_context",
            "open_threads",
            "relationship",
            "children",
            "marcel_knowledge_map"
          ].includes(k)
            ?5
            :3
        });
      }
    }
  }

  console.log(`Frauen-Memory geladen: ${WOMEN_SEED.length} getrennte Profile.`);
}

async function ensureContact(jid){
  const phone=
    isTestJid(jid)||isProfileJid(jid)
      ?null
      :jid?.split("@")?.[0]?.replace(/\D/g,"")||null;

  let c=phone
    ?await findContactByIdentifier("phone",phone)
    :null;

  if(!c){
    c=await findContactByIdentifier(
      "whatsapp_jid",
      jid
    );
  }

  if(!c){
    const r=await pool.query(
      `SELECT *
       FROM contacts
       WHERE whatsapp_jid=$1
       LIMIT 1`,
      [jid]
    );

    c=r.rows[0]||null;
  }

  if(c){
    if(phone&&c.whatsapp_jid!==jid){
      const conflict=await pool.query(
        `SELECT id
         FROM contacts
         WHERE whatsapp_jid=$1
           AND id<>$2
         LIMIT 1`,
        [jid,c.id]
      );

      if(conflict.rows[0]){
        throw new Error(
          `WhatsApp-JID ${jid} ist bereits einem anderen Kontakt zugeordnet.`
        );
      }

      await pool.query(
        `UPDATE messages
         SET whatsapp_jid=$2
         WHERE whatsapp_jid=$1`,
        [c.whatsapp_jid,jid]
      );

      const r=await pool.query(
        `UPDATE contacts
         SET whatsapp_jid=$2,
             phone_number=COALESCE($3,phone_number),
             current_platform='whatsapp',
             platform_status='WHATSAPP_ACTIVE',
             last_message_at=NOW(),
             updated_at=NOW()
         WHERE id=$1
         RETURNING *`,
        [c.id,jid,phone]
      );

      c=r.rows[0];
    }else{
      const r=await pool.query(
        `UPDATE contacts
         SET phone_number=COALESCE(phone_number,$2),
             last_message_at=NOW(),
             updated_at=NOW()
         WHERE id=$1
         RETURNING *`,
        [c.id,phone]
      );

      c=r.rows[0];
    }

    await addContactIdentifier({
      contactId:c.id,
      type:"whatsapp_jid",
      value:jid,
      sourcePlatform:"whatsapp",
      isPrimary:true
    });

    if(phone){
      await addContactIdentifier({
        contactId:c.id,
        type:"phone",
        value:phone,
        sourcePlatform:"whatsapp",
        isPrimary:true
      });
    }

    await pool.query(
      `INSERT INTO contact_memory_profiles(contact_id)
       VALUES($1)
       ON CONFLICT(contact_id) DO NOTHING`,
      [c.id]
    );

    return c;
  }

  const r=await pool.query(
    `INSERT INTO contacts(
      whatsapp_jid,
      phone_number,
      current_platform,
      platform_status,
      first_contact_at,
      last_message_at,
      updated_at
    )
    VALUES(
      $1,
      $2,
      CASE
        WHEN $2 IS NULL THEN NULL
        ELSE 'whatsapp'
      END,
      CASE
        WHEN $2 IS NULL THEN NULL
        ELSE 'WHATSAPP_ACTIVE'
      END,
      NOW(),
      NOW(),
      NOW()
    )
    ON CONFLICT(whatsapp_jid)
    DO UPDATE SET
      phone_number=COALESCE(
        contacts.phone_number,
        EXCLUDED.phone_number
      ),
      last_message_at=NOW(),
      updated_at=NOW()
    RETURNING *`,
    [jid,phone]
  );

  c=r.rows[0];

  await pool.query(
    `INSERT INTO contact_memory_profiles(contact_id)
     VALUES($1)
     ON CONFLICT(contact_id) DO NOTHING`,
    [c.id]
  );

  await addContactIdentifier({
    contactId:c.id,
    type:"whatsapp_jid",
    value:jid,
    sourcePlatform:"whatsapp",
    isPrimary:true
  });

  if(phone){
    await addContactIdentifier({
      contactId:c.id,
      type:"phone",
      value:phone,
      sourcePlatform:"whatsapp",
      isPrimary:true
    });
  }

  return c;
}

async function getContactByJid(jid){
  const r=await pool.query(
    `SELECT *
     FROM contacts
     WHERE whatsapp_jid=$1
     LIMIT 1`,
    [jid]
  );

  return r.rows[0]||null;
}

async function createTestContact({
  name,
  country=null,
  city=null,
  language=null
}){
  const n=normalizeText(name);

  if(!n){
    throw new Error(
      "Testkontakt braucht einen Namen."
    );
  }

  const jid=
    `test-${createTestSlug(n)}@persona.test`;

  const r=await pool.query(
    `INSERT INTO contacts(
      whatsapp_jid,
      display_name,
      country,
      city,
      primary_language,
      source_platform,
      current_platform,
      source_profile_name,
      contact_status,
      relationship_stage,
      auto_reply_enabled,
      date_lock_enabled,
      first_contact_at,
      last_message_at,
      updated_at
    )
    VALUES(
      $1,$2,$3,$4,$5,
      'persona_test',
      'persona_test',
      $2,
      'active',
      'new',
      TRUE,
      FALSE,
      NOW(),
      NOW(),
      NOW()
    )
    RETURNING *`,
    [
      jid,
      n,
      normalizeText(country)||null,
      normalizeText(city)||null,
      normalizeText(language)||null
    ]
  );

  await pool.query(
    `INSERT INTO contact_memory_profiles(contact_id)
     VALUES($1)
     ON CONFLICT(contact_id) DO NOTHING`,
    [r.rows[0].id]
  );

  return r.rows[0];
}

async function getTestContacts(){
  const r=await pool.query(
    `SELECT
       id,
       whatsapp_jid,
       display_name,
       country,
       city,
       primary_language,
       relationship_stage,
       created_at,
       updated_at
     FROM contacts
     WHERE whatsapp_jid LIKE '%@persona.test'
     ORDER BY updated_at DESC,display_name ASC`
  );

  return r.rows;
}

async function saveMessage(
  jid,
  direction,
  text,
  whatsappMessageId=null,
  options={}
){
  const c=await ensureContact(jid);

  const r=await pool.query(
    `INSERT INTO messages(
      whatsapp_jid,
      direction,
      message_text,
      whatsapp_message_id,
      processing_status,
      duplicate_of_message_id
    )
    VALUES($1,$2,$3,$4,$5,$6)
    RETURNING *`,
    [
      jid,
      direction,
      text||null,
      whatsappMessageId,
      options.processingStatus||"processed",
      options.duplicateOfMessageId||null
    ]
  );

  await pool.query(
    `UPDATE contacts
     SET last_message_at=NOW(),
         updated_at=NOW()
     WHERE id=$1`,
    [c.id]
  );

  return r.rows[0];
}

async function getLastIncomingMessage(jid){
  const r=await pool.query(
    `SELECT *
     FROM messages
     WHERE whatsapp_jid=$1
       AND direction='incoming'
       AND message_text IS NOT NULL
     ORDER BY id DESC
     LIMIT 1`,
    [jid]
  );

  return r.rows[0]||null;
}

async function detectImmediateDuplicate(
  jid,
  text
){
  const l=await getLastIncomingMessage(jid);

  if(!l){
    return null;
  }

  if(
    normalizeForDuplicate(l.message_text)
    !==
    normalizeForDuplicate(text)
  ){
    return null;
  }

  const age=
    (
      Date.now()
      -
      new Date(l.created_at).getTime()
    )
    /
    60000;

  return Number.isFinite(age)
    &&
    age<=DUPLICATE_WINDOW_MINUTES
      ?l
      :null;
}

function duplicateReplyForContact(c){
  const l=
    normalizeText(c?.primary_language)
      .toLowerCase();

  if(
    l.includes("span")
    ||
    l==="es"
  ){
    return "Esa me llegó dos veces 😄 ¿Fue sin querer o querías asegurarte de que la viera?";
  }

  if(
    l.includes("german")
    ||
    l.includes("deutsch")
    ||
    l==="de"
  ){
    return "Die kam gerade zweimal 😄 War das aus Versehen oder wolltest du sichergehen, dass ich sie sehe?";
  }

  return "That one just came through twice 😄 Accident, or were you making sure I saw it?";
}

async function updateEditedIncomingMessage({
  jid,
  whatsappMessageId,
  newText
}){
  if(
    !jid
    ||
    !whatsappMessageId
    ||
    !normalizeText(newText)
  ){
    return null;
  }

  const r=await pool.query(
    `UPDATE messages
     SET original_message_text=COALESCE(
           original_message_text,
           message_text
         ),
         message_text=$3,
         is_edited=TRUE,
         edited_at=NOW()
     WHERE whatsapp_jid=$1
       AND whatsapp_message_id=$2
       AND direction='incoming'
     RETURNING *`,
    [
      jid,
      whatsappMessageId,
      normalizeText(newText)
    ]
  );

  return r.rows[0]||null;
}

async function getConversationHistory(
  jid,
  beforeMessageId=null
){
  const q=beforeMessageId
    ?[
        `SELECT
           id,
           direction,
           message_text,
           is_edited,
           created_at
         FROM messages
         WHERE whatsapp_jid=$1
           AND message_text IS NOT NULL
           AND id<$2
         ORDER BY id DESC
         LIMIT 30`,
        [jid,beforeMessageId]
      ]
    :[
        `SELECT
           id,
           direction,
           message_text,
           is_edited,
           created_at
         FROM messages
         WHERE whatsapp_jid=$1
           AND message_text IS NOT NULL
         ORDER BY id DESC
         LIMIT 30`,
        [jid]
      ];

  const r=await pool.query(
    q[0],
    q[1]
  );

  return r.rows.reverse();
}

async function getContactMemoryProfile(id){
  const r=await pool.query(
    `SELECT *
     FROM contact_memory_profiles
     WHERE contact_id=$1
     LIMIT 1`,
    [id]
  );

  return r.rows[0]||null;
}

async function getRelevantMemoryItems(
  id,
  limit=60
){
  const r=await pool.query(
    `SELECT *
     FROM memory_items
     WHERE contact_id=$1
       AND status='active'
       AND use_in_reply=TRUE
       AND(
         valid_until IS NULL
         OR valid_until>NOW()
       )
       AND human_review_status<>'rejected'
     ORDER BY
       CASE
         WHEN human_review_status IN(
           'confirmed',
           'corrected'
         )
         THEN 0
         ELSE 1
       END,
       importance DESC,
       updated_at DESC
     LIMIT $2`,
    [id,limit]
  );

  return r.rows;
}

async function getHistoricalMemoryItems(
  id,
  limit=200
){
  const r=await pool.query(
    `SELECT *
     FROM memory_items
     WHERE contact_id=$1
       AND status<>'active'
     ORDER BY created_at DESC
     LIMIT $2`,
    [id,limit]
  );

  return r.rows;
}

async function getRelevantMemoryEvents(
  id,
  limit=30
){
  const r=await pool.query(
    `SELECT *
     FROM memory_events
     WHERE contact_id=$1
       AND(
         event_status IN(
           'active',
           'open'
         )
         OR(
           requires_follow_up=TRUE
           AND follow_up_status NOT IN(
             'completed',
             'cancelled'
           )
         )
       )
     ORDER BY
       importance DESC,
       started_at DESC
     LIMIT $2`,
    [id,limit]
  );

  return r.rows;
}

async function getAllMemoryEvents(
  id,
  limit=200
){
  const r=await pool.query(
    `SELECT *
     FROM memory_events
     WHERE contact_id=$1
     ORDER BY created_at DESC
     LIMIT $2`,
    [id,limit]
  );

  return r.rows;
}

async function getMarcelMemory(limit=60){
  const r=await pool.query(
    `SELECT
       category,
       memory_key,
       memory_value,
       importance,
       usage_notes
     FROM marcel_memory
     WHERE status='active'
       AND allowed_for_bot=TRUE
       AND(
         valid_until IS NULL
         OR valid_until>NOW()
       )
     ORDER BY
       importance DESC,
       updated_at DESC
     LIMIT $1`,
    [limit]
  );

  return r.rows;
}

async function getMarcelLiveState(){
  const r=await pool.query(
    `SELECT *
     FROM marcel_live_state
     WHERE id=1
     LIMIT 1`
  );

  return r.rows[0]||{};
}

function buildMemoryContext({
  contact,
  profile,
  memoryItems,
  memoryEvents,
  marcelMemory,
  liveState
}){
  const pd=profile
    ?Object.fromEntries(
        PROFILE_COLUMNS.map(
          c=>[c,profile[c]||{}]
        )
      )
    :{};

  const items=memoryItems.length
    ?memoryItems.map(i=>{
        const v=
          i.human_review_status==="corrected"
          &&
          i.human_corrected_value
            ?i.human_corrected_value
            :i.memory_value;

        return `#${i.id}|${i.category}.${i.memory_key}|${i.memory_type}|review=${i.human_review_status}|importance=${i.importance}|${renderJson(v)}`;
      }).join("\n")
    :"[keine]";

  const events=memoryEvents.length
    ?memoryEvents.map(
        e=>
          `#${e.id}|${e.event_type}/${e.event_subtype||"-"}|${renderJson(e.event_data)}`
      ).join("\n")
    :"[keine]";

  const mm=marcelMemory.length
    ?marcelMemory.map(
        m=>
          `${m.category}.${m.memory_key}|${renderJson(m.memory_value)}|${m.usage_notes||""}`
      ).join("\n")
    :"[keine]";

  return `
LANGZEIT-GEDÄCHTNIS V1.7

KONTAKT:
${renderJson({
  id:contact?.id,
  memory_identity_key:contact?.memory_identity_key,
  canonical_name:contact?.canonical_name,
  display_name:contact?.display_name,
  whatsapp_display_name:contact?.whatsapp_display_name,
  country:contact?.country,
  city:contact?.city,
  primary_language:contact?.primary_language,
  source_platform:contact?.source_platform,
  current_platform:contact?.current_platform,
  platform_status:contact?.platform_status,
  relationship_stage:contact?.relationship_stage
})}

MARCEL LIVE STATE:
${renderJson(liveState)}

AKTUELLES FRAUENPROFIL:
${renderJson(pd)}

AKTIVE MEMORIES:
${items}

EVENTS:
${events}

MARCEL MEMORY:
${mm}

REGELN:
- Nur ACTIVE gilt aktuell.
- Human confirmed/corrected hat Vorrang.
- Frau und Marcel nie vermischen.
- Gleichnamige Frauen nie nur anhand Namen zusammenführen.
- Dani != Daniela Messe != Dángela.
- Kate Castillo != alte Kathe.
- Paola Maza != ältere Paola.
- Karla Tinder != Karla Instagram.
- marcel_knowledge_map = nur was diese Frau über Marcel weiß.
- Bestehende Fragen nicht erneut stellen.
- Nach Plattformwechsel Verlauf fortsetzen.
`;
}

async function generateAIReply(
  jid,
  incomingText,
  incomingMessageDbId=null,
  extraInstructions=""
){
  let conversation="";
  let memoryContext="";

  if(jid){
    const c=
      (
        await getContactByJid(jid)
      )
      ||
      (
        await ensureContact(jid)
      );

    const [
      h,
      p,
      mi,
      me,
      mm,
      ls
    ]=await Promise.all([
      getConversationHistory(
        jid,
        incomingMessageDbId
      ),
      getContactMemoryProfile(c.id),
      getRelevantMemoryItems(c.id),
      getRelevantMemoryEvents(c.id),
      getMarcelMemory(),
      getMarcelLiveState()
    ]);

    conversation=h.map(
      x=>
        `${x.direction==="incoming"?"Andere Person":"Marcel"}: ${x.message_text}`
    ).join("\n");

    memoryContext=buildMemoryContext({
      contact:c,
      profile:p,
      memoryItems:mi,
      memoryEvents:me,
      marcelMemory:mm,
      liveState:ls
    });
  }

  const r=await openai.responses.create({
    model:MODEL,

    instructions:`
${MARCEL_PERSONA_V1_7}

${memoryContext}

Nutze Verlauf als Kurzzeitgedächtnis und aktive Memories als Langzeitwissen.

Widersprich bekannten Fakten nicht.
Frage nichts erneut.

Keine KI-Füllsätze,
keine Eigenschaftslisten,
keine künstlichen Kosenamen.

${extraInstructions}

Gib ausschließlich Marcels Nachricht aus.
`,

    input:`
BISHERIGER VERLAUF:

${conversation||"[keiner]"}

NEUE NACHRICHT:

${incomingText}

Schreibe Marcels Antwort.
`
  });

  return r.output_text?.trim()||"";
}

async function findSimilarActiveMemory(
  id,
  cat,
  key
){
  const r=await pool.query(
    `SELECT *
     FROM memory_items
     WHERE contact_id=$1
       AND category=$2
       AND memory_key=$3
       AND status='active'
     ORDER BY updated_at DESC
     LIMIT 1`,
    [id,cat,key]
  );

  return r.rows[0]||null;
}

async function retireMemoryItems(
  id,
  ids
){
  const s=cleanIntegerArray(ids);

  if(!s.length){
    return;
  }

  await pool.query(
    `UPDATE memory_items
     SET status='superseded',
         valid_until=COALESCE(
           valid_until,
           NOW()
         ),
         updated_at=NOW()
     WHERE contact_id=$1
       AND id=ANY($2::bigint[])
       AND status='active'
       AND human_review_status NOT IN(
         'confirmed',
         'corrected'
       )`,
    [id,s]
  );
}

function childSignalFromMemory(
  cat,
  key,
  val
){
  if(
    normalizeText(cat)
      .toLowerCase()
    !==
    "children"
  ){
    return null;
  }

  const k=
    normalizeText(key)
      .toLowerCase();

  const v=
    val
    &&
    typeof val==="object"
      ?val
      :{};

  if(
    k.includes("has_no_children")
    ||
    (
      k.includes("has_children")
      &&
      (
        v.has_children===false
        ||
        v.value===false
      )
    )
    ||
    v.child_count===0
    ||
    v.count===0
  ){
    return "none";
  }

  if(
    k.includes("has_son")
    ||
    v.has_son===true
    ||
    v.son===true
  ){
    return "son";
  }

  if(
    k.includes("has_daughter")
    ||
    v.has_daughter===true
    ||
    v.daughter===true
  ){
    return "daughter";
  }

  if(
    k.includes("has_children")
    ||
    v.has_children===true
    ||
    Number(v.child_count)>0
    ||
    Number(v.count)>0
  ){
    return "children";
  }

  return null;
}

async function detectDeterministicContradiction(
  id,
  item
){
  const ns=
    childSignalFromMemory(
      item?.category,
      item?.memory_key,
      item?.memory_value
    );

  if(!ns){
    return null;
  }

  const a=
    (
      await getRelevantMemoryItems(
        id,
        200
      )
    )
    .filter(
      x=>
        normalizeText(x.category)
          .toLowerCase()
        ===
        "children"
    );

  for(const e of a){
    const v=
      e.human_review_status==="corrected"
      &&
      e.human_corrected_value
        ?e.human_corrected_value
        :e.memory_value;

    const os=
      childSignalFromMemory(
        e.category,
        e.memory_key,
        v
      );

    if(
      (
        ns==="none"
        &&
        [
          "son",
          "daughter",
          "children"
        ].includes(os)
      )
      ||
      (
        os==="none"
        &&
        [
          "son",
          "daughter",
          "children"
        ].includes(ns)
      )
    ){
      return e;
    }
  }

  return null;
}

async function createContradictionEvent({
  contactId,
  existingItem,
  proposedItem,
  incomingMessageDbId,
  incomingText
}){
  await pool.query(
    `INSERT INTO memory_events(
      contact_id,
      event_type,
      event_subtype,
      title,
      event_data,
      event_status,
      importance,
      sensitivity,
      source_message_ids,
      evidence_summary,
      marcel_review_required
    )
    VALUES(
      $1,
      'possible_contradiction',
      'deterministic_fact_conflict',
      'Möglicher Widerspruch',
      $2::jsonb,
      'active',
      4,
      'personal',
      $3::jsonb,
      $4,
      TRUE
    )`,
    [
      contactId,

      JSON.stringify({
        existing_memory_id:
          existingItem.id,

        existing_fact:{
          category:
            existingItem.category,

          memory_key:
            existingItem.memory_key,

          memory_value:
            existingItem.memory_value
        },

        proposed_fact:{
          category:
            proposedItem.category,

          memory_key:
            proposedItem.memory_key,

          memory_value:
            proposedItem.memory_value
        }
      }),

      JSON.stringify(
        incomingMessageDbId
          ?[incomingMessageDbId]
          :[]
      ),

      normalizeText(incomingText)
      ||
      "Neue Aussage kollidiert mit bestehendem Fakt."
    ]
  );
}

async function applyMemoryItems(
  id,
  items,
  sourceId,
  incomingText=""
){
  if(!Array.isArray(items)){
    return;
  }

  for(const x of items.slice(0,25)){
    const cat=
      normalizeText(
        x?.category
      );

    const key=
      normalizeText(
        x?.memory_key
      );

    if(
      !cat
      ||
      !key
    ){
      continue;
    }

    const con=
      await detectDeterministicContradiction(
        id,
        x
      );

    if(con){
      await createContradictionEvent({
        contactId:id,
        existingItem:con,
        proposedItem:x,
        incomingMessageDbId:
          sourceId,
        incomingText
      });

      continue;
    }

    const existing=
      await findSimilarActiveMemory(
        id,
        cat,
        key
      );

    if(
      existing
      &&
      [
        "confirmed",
        "corrected"
      ].includes(
        existing.human_review_status
      )
    ){
      continue;
    }

    const type=
      [
        "self_reported",
        "explicit_fact",
        "observed_pattern",
        "interpretation",
        "temporary_state"
      ].includes(
        x?.memory_type
      )
        ?x.memory_type
        :"interpretation";

    const val=
      x?.memory_value
      &&
      typeof x.memory_value==="object"
      &&
      !Array.isArray(
        x.memory_value
      )
        ?x.memory_value
        :{
            value:
              x?.memory_value
              ??
              null
          };

    const conf=
      clampConfidence(
        x?.confidence
      );

    const imp=
      clampImportance(
        x?.importance
      );

    const quote=
      normalizeText(
        x?.source_quote
      )
      ||
      null;

    if(existing){
      if(
        renderJson(
          existing.memory_value
        )
        ===
        renderJson(val)
      ){
        await pool.query(
          `UPDATE memory_items
           SET confidence=GREATEST(
                 confidence,
                 $2
               ),
               source_quote=COALESCE(
                 $3,
                 source_quote
               ),
               source_message_id=COALESCE(
                 $4,
                 source_message_id
               ),
               importance=GREATEST(
                 importance,
                 $5
               ),
               updated_at=NOW()
           WHERE id=$1`,
          [
            existing.id,
            conf,
            quote,
            sourceId||null,
            imp
          ]
        );

        continue;
      }

      await pool.query(
        `UPDATE memory_items
         SET status='superseded',
             valid_until=NOW(),
             updated_at=NOW()
         WHERE id=$1`,
        [existing.id]
      );
    }

    const hrs=
      x?.valid_until_hours==null
        ?null
        :Number(
            x.valid_until_hours
          );

    await pool.query(
      `INSERT INTO memory_items(
        contact_id,
        category,
        memory_key,
        memory_value,
        memory_type,
        confidence,
        source_message_id,
        source_quote,
        valid_from,
        valid_until,
        supersedes_memory_id,
        importance,
        use_in_reply
      )
      VALUES(
        $1,
        $2,
        $3,
        $4::jsonb,
        $5,
        $6,
        $7,
        $8,
        NOW(),
        CASE
          WHEN $9::double precision IS NULL
          THEN NULL
          ELSE
            NOW()
            +
            (
              $9::text
              ||
              ' hours'
            )::interval
        END,
        $10,
        $11,
        $12
      )`,
      [
        id,
        cat,
        key,
        JSON.stringify(val),
        type,
        conf,
        sourceId||null,
        quote,
        Number.isFinite(hrs)
          ?hrs
          :null,
        existing?.id||null,
        imp,
        x?.use_in_reply!==false
      ]
    );
  }
}

async function applyMemoryEvents(
  id,
  events,
  sourceId
){
  if(!Array.isArray(events)){
    return;
  }

  for(const e of events.slice(0,20)){
    const type=
      normalizeText(
        e?.event_type
      );

    if(!type){
      continue;
    }

    await pool.query(
      `INSERT INTO memory_events(
        contact_id,
        event_type,
        event_subtype,
        title,
        event_data,
        event_status,
        importance,
        sensitivity,
        source_message_ids,
        evidence_summary,
        requires_follow_up,
        follow_up_status,
        bot_action,
        marcel_review_required
      )
      VALUES(
        $1,
        $2,
        $3,
        $4,
        $5::jsonb,
        'active',
        $6,
        $7,
        $8::jsonb,
        $9,
        $10,
        CASE
          WHEN $10=TRUE
          THEN 'pending'
          ELSE 'none'
        END,
        $11,
        $12
      )`,
      [
        id,
        type,
        normalizeText(
          e?.event_subtype
        )
        ||
        null,
        normalizeText(
          e?.title
        )
        ||
        null,
        JSON.stringify(
          e?.event_data
          &&
          typeof e.event_data==="object"
            ?e.event_data
            :{}
        ),
        clampImportance(
          e?.importance
        ),
        [
          "normal",
          "personal",
          "intimate"
        ].includes(
          e?.sensitivity
        )
          ?e.sensitivity
          :"normal",
        JSON.stringify(
          sourceId
            ?[sourceId]
            :[]
        ),
        normalizeText(
          e?.evidence_summary
        )
        ||
        null,
        e?.requires_follow_up===true,
        normalizeText(
          e?.bot_action
        )
        ||
        null,
        e?.marcel_review_required===true
      ]
    );
  }
}

async function extractMemoryUpdates({
  jid,
  contactId,
  incomingText,
  incomingMessageDbId,
  outgoingText,
  outgoingMessageDbId
}){
  const [
    h,
    p,
    items,
    events,
    ls
  ]=await Promise.all([
    getConversationHistory(jid),
    getContactMemoryProfile(contactId),
    getRelevantMemoryItems(
      contactId,
      100
    ),
    getRelevantMemoryEvents(
      contactId,
      50
    ),
    getMarcelLiveState()
  ]);

  const mem=
    items.map(i=>
      `ID=${i.id}|${i.category}.${i.memory_key}|review=${i.human_review_status}|${renderJson(
        i.human_review_status==="corrected"
        &&
        i.human_corrected_value
          ?i.human_corrected_value
          :i.memory_value
      )}`
    ).join("\n");

  const response=
    await openai.responses.create({
      model:MODEL,

      instructions:`
Du bist Memory-Extractor.

Antworte nicht der Frau.

Neue Fakten erkennen,
alte nicht neu speichern,
temporäre Zustände sauber ersetzen,
Widersprüche nicht blind überschreiben.

Human confirmed/corrected Memory niemals überschreiben oder retiren.

Gleichnamige Frauen nie vermischen.

Dani != Daniela Messe != Dángela.
Kate Castillo != alte Kathe.
Paola Maza != ältere Paola.
Karla Tinder != Karla Instagram.

Frau/Marcel/Dritte strikt trennen.

marcel_knowledge_map nur für Wissen dieser Frau über Marcel.

Gib ausschließlich JSON:

{
  "retire_item_ids": [],
  "items": [],
  "events": [],
  "profile_snapshot": {
    ${PROFILE_COLUMNS.map(
      c=>`"${c}": {}`
    ).join(",")}
  }
}
`,

      input:`
LIVE STATE:

${renderJson(ls)}

BISHERIGES PROFIL:

${renderJson(p||{})}

AKTIVE MEMORIES:

${mem||"[keine]"}

VERLAUF:

${h.slice(-20).map(
  x=>
    `${x.direction==="incoming"?"Sie":"Marcel"}: ${x.message_text}`
).join("\n")}

NEU SIE:

${incomingText}

MARCEL ANTWORT:

${outgoingText}

Aktualisiere Memory.
`
    });

  const empty=
    Object.fromEntries(
      PROFILE_COLUMNS.map(
        c=>[c,{}]
      )
    );

  const parsed=
    safeJsonParse(
      response.output_text,
      {
        retire_item_ids:[],
        items:[],
        events:[],
        profile_snapshot:empty
      }
    );

  if(
    !parsed
    ||
    typeof parsed!=="object"
  ){
    return;
  }

  await retireMemoryItems(
    contactId,
    parsed.retire_item_ids||[]
  );

  await applyMemoryItems(
    contactId,
    parsed.items||[],
    incomingMessageDbId,
    incomingText
  );

  await applyMemoryEvents(
    contactId,
    parsed.events||[],
    incomingMessageDbId
  );

  await applyProfileSnapshot(
    contactId,
    parsed.profile_snapshot||empty
  );

  console.log(
    "Langzeit-Memory V1.7 aktualisiert."
  );
}

function scheduleMemoryUpdate(payload){
  setTimeout(
    ()=>{
      extractMemoryUpdates(
        payload
      )
      .catch(
        e=>
          console.error(
            "Memory-Update fehlgeschlagen:",
            e
          )
      );
    },
    250
  );
}

function personaPasswordCorrect(password){
  const e=
    process.env
      .PERSONA_TEST_PASSWORD;

  return !!e
    &&
    password===e;
}

async function getTestContactSnapshot(jid){
  const c=
    await getContactByJid(jid);

  if(!c){
    return null;
  }

  const [
    history,
    profile,
    activeItems,
    historicalItems,
    events,
    liveState
  ]=await Promise.all([
    getConversationHistory(jid),
    getContactMemoryProfile(c.id),
    getRelevantMemoryItems(
      c.id,
      250
    ),
    getHistoricalMemoryItems(
      c.id,
      250
    ),
    getAllMemoryEvents(
      c.id,
      200
    ),
    getMarcelLiveState()
  ]);

  return {
    contact:c,
    history,
    profile,
    activeItems,
    historicalItems,
    events,
    liveState
  };
}

app.get(
  "/",
  (req,res)=>
    res.send(
      `Marcel WhatsApp Bot V1.7 läuft. WhatsApp-Status: ${whatsappStatus}`
    )
);

app.get(
  "/db-test",
  async(req,res)=>{
    try{
      const r=
        await pool.query(
          "SELECT NOW() AS server_time"
        );

      res.json({
        ok:true,
        serverTime:
          r.rows[0]
            .server_time
      });
    }catch(e){
      res
        .status(500)
        .json({
          ok:false,
          error:
            "Datenbankverbindung fehlgeschlagen"
        });
    }
  }
);

app.get(
  "/memory-status",
  async(req,res)=>{
    try{
      const r=
        await pool.query(
          `SELECT

            (
              SELECT COUNT(*)
              FROM contacts
            )
            contacts,

            (
              SELECT COUNT(*)
              FROM messages
            )
            messages,

            (
              SELECT COUNT(*)
              FROM memory_items
            )
            memory_items,

            (
              SELECT COUNT(*)
              FROM memory_items
              WHERE status='active'
            )
            active_memory_items,

            (
              SELECT COUNT(*)
              FROM memory_events
            )
            memory_events,

            (
              SELECT COUNT(*)
              FROM contacts
              WHERE memory_identity_key IS NOT NULL
            )
            women_registry_contacts`
        );

      res.json({
        ok:true,
        ...r.rows[0]
      });
    }catch(e){
      res
        .status(500)
        .json({
          ok:false,
          error:
            "Memory-Status konnte nicht geladen werden."
        });
    }
  }
);

app.get(
  "/pairing-code",
  (req,res)=>{
    if(!WHATSAPP_ENABLED){
      return res.send(
        "WhatsApp ist deaktiviert. Kein Pairing, kein Socket, kein Reconnect."
      );
    }

    if(pairingCode){
      return res.send(
        `Pairing Code: ${pairingCode}`
      );
    }

    res.send(
      "Noch kein Pairing-Code verfügbar."
    );
  }
);

app.get(
  "/persona-test",
  (req,res)=>
    res.send(
`<!doctype html>
<html lang="de">

<head>

<meta charset="utf-8">

<meta
  name="viewport"
  content="width=device-width,initial-scale=1"
>

<title>
Memory Test V1.7
</title>

<style>

body{
  font-family:-apple-system,Arial;
  background:#111;
  color:#fff;
  max-width:850px;
  margin:auto;
  padding:20px
}

input,
button,
select,
textarea,
pre{
  width:100%;
  padding:12px;
  margin:6px 0;
  border:0;
  border-radius:10px;
  box-sizing:border-box
}

input,
select,
textarea,
pre{
  background:#222;
  color:#fff
}

button{
  font-weight:700
}

pre{
  white-space:pre-wrap
}

.msg{
  padding:10px;
  margin:6px 0;
  border-radius:10px
}

.her{
  background:#333
}

.me{
  background:#173b26
}

</style>

</head>

<body>

<h1>
Marcel Memory Test V1.7
</h1>

<p>
WhatsApp bleibt bei WHATSAPP_ENABLED=false komplett aus.
</p>

<input
  id="password"
  type="password"
  placeholder="Passwort"
>

<button onclick="load()">
Testkontakte laden
</button>

<select id="contacts"></select>

<input
  id="name"
  placeholder="Neue Testfrau"
>

<button onclick="create()">
Anlegen
</button>

<div id="chat"></div>

<textarea
  id="msg"
  placeholder="Ihre Nachricht"
></textarea>

<button onclick="send()">
Testen
</button>

<pre id="out"></pre>

<script>

const p=
  ()=>
    document
      .getElementById(
        "password"
      )
      .value;

const api=
  async(u,o)=>{
    const r=
      await fetch(
        u,
        o
      );

    const d=
      await r.json();

    if(!r.ok){
      throw Error(
        d.error
        ||
        "Fehler"
      );
    }

    return d;
  };

async function load(){
  const d=
    await api(
      "/persona-test/contacts",
      {
        method:"POST",

        headers:{
          "Content-Type":
            "application/json"
        },

        body:
          JSON.stringify({
            password:p()
          })
      }
    );

  contacts.innerHTML=
    '<option value="">-- auswählen --</option>'
    +
    d.contacts.map(
      x=>
        '<option value="'
        +
        x.whatsapp_jid
        +
        '">'
        +
        (
          x.display_name
          ||
          x.whatsapp_jid
        )
        +
        '</option>'
    ).join("");
}

async function create(){
  const d=
    await api(
      "/persona-test/create-contact",
      {
        method:"POST",

        headers:{
          "Content-Type":
            "application/json"
        },

        body:
          JSON.stringify({
            password:p(),
            name:name.value
          })
      }
    );

  await load();

  contacts.value=
    d.contact
      .whatsapp_jid;

  await snap();
}

contacts.onchange=
  snap;

async function snap(){
  if(!contacts.value){
    return;
  }

  const d=
    await api(
      "/persona-test/snapshot",
      {
        method:"POST",

        headers:{
          "Content-Type":
            "application/json"
        },

        body:
          JSON.stringify({
            password:p(),
            jid:contacts.value
          })
      }
    );

  chat.innerHTML=
    d.history.map(
      x=>
        '<div class="msg '
        +
        (
          x.direction==="incoming"
            ?"her"
            :"me"
        )
        +
        '">'
        +
        x.message_text
        +
        '</div>'
    ).join("");

  out.textContent=
    JSON.stringify(
      {
        profile:d.profile,
        active:d.activeItems,
        events:d.events
      },
      null,
      2
    );
}

async function send(){
  const d=
    await api(
      "/persona-test/message",
      {
        method:"POST",

        headers:{
          "Content-Type":
            "application/json"
        },

        body:
          JSON.stringify({
            password:p(),
            jid:contacts.value,
            message:msg.value
          })
      }
    );

  msg.value="";

  await snap();
}

</script>

</body>

</html>`
    )
);

app.post(
  "/persona-test/contacts",
  async(req,res)=>{
    try{
      if(
        !personaPasswordCorrect(
          req.body.password
        )
      ){
        return res
          .status(401)
          .json({
            error:
              "Falsches Passwort."
          });
      }

      res.json({
        ok:true,
        contacts:
          await getTestContacts()
      });
    }catch(e){
      res
        .status(500)
        .json({
          error:
            "Testkontakte konnten nicht geladen werden."
        });
    }
  }
);

app.post(
  "/persona-test/create-contact",
  async(req,res)=>{
    try{
      if(
        !personaPasswordCorrect(
          req.body.password
        )
      ){
        return res
          .status(401)
          .json({
            error:
              "Falsches Passwort."
          });
      }

      res.json({
        ok:true,
        contact:
          await createTestContact(
            req.body
          )
      });
    }catch(e){
      res
        .status(500)
        .json({
          error:e.message
        });
    }
  }
);

app.post(
  "/persona-test/snapshot",
  async(req,res)=>{
    try{
      if(
        !personaPasswordCorrect(
          req.body.password
        )
      ){
        return res
          .status(401)
          .json({
            error:
              "Falsches Passwort."
          });
      }

      if(
        !isTestJid(
          req.body.jid
        )
      ){
        return res
          .status(400)
          .json({
            error:
              "Ungültiger Testkontakt."
          });
      }

      const s=
        await getTestContactSnapshot(
          req.body.jid
        );

      if(!s){
        return res
          .status(404)
          .json({
            error:
              "Nicht gefunden."
          });
      }

      res.json(s);
    }catch(e){
      res
        .status(500)
        .json({
          error:
            "Snapshot konnte nicht geladen werden."
        });
    }
  }
);

app.post(
  "/persona-test/message",
  async(req,res)=>{
    try{
      if(
        !personaPasswordCorrect(
          req.body.password
        )
      ){
        return res
          .status(401)
          .json({
            error:
              "Falsches Passwort."
          });
      }

      const jid=
        req.body.jid;

      const text=
        normalizeText(
          req.body.message
        );

      if(
        !isTestJid(jid)
      ){
        return res
          .status(400)
          .json({
            error:
              "Ungültiger Testkontakt."
          });
      }

      if(!text){
        return res
          .status(400)
          .json({
            error:
              "Keine Nachricht eingegeben."
          });
      }

      const c=
        await getContactByJid(jid);

      if(!c){
        return res
          .status(404)
          .json({
            error:
              "Nicht gefunden."
          });
      }

      const dup=
        await detectImmediateDuplicate(
          jid,
          text
        );

      if(dup){
        await saveMessage(
          jid,
          "incoming",
          text,
          `test-in-${Date.now()}`,
          {
            processingStatus:
              "duplicate",

            duplicateOfMessageId:
              dup.id
          }
        );

        const reply=
          duplicateReplyForContact(c);

        await saveMessage(
          jid,
          "outgoing",
          reply,
          `test-out-${Date.now()}`,
          {
            processingStatus:
              "duplicate_reply"
          }
        );

        return res.json({
          ok:true,
          duplicate:true,
          reply,
          snapshot:
            await getTestContactSnapshot(
              jid
            )
        });
      }

      const incoming=
        await saveMessage(
          jid,
          "incoming",
          text,
          `test-in-${Date.now()}`
        );

      const reply=
        await generateAIReply(
          jid,
          text,
          incoming.id
        );

      if(!reply){
        return res
          .status(500)
          .json({
            error:
              "OpenAI hat keine Antwort erzeugt."
          });
      }

      const outgoing=
        await saveMessage(
          jid,
          "outgoing",
          reply,
          `test-out-${Date.now()}`
        );

      await extractMemoryUpdates({
        jid,
        contactId:c.id,
        incomingText:text,
        incomingMessageDbId:
          incoming.id,
        outgoingText:reply,
        outgoingMessageDbId:
          outgoing.id
      });

      res.json({
        ok:true,
        duplicate:false,
        reply,
        snapshot:
          await getTestContactSnapshot(
            jid
          )
      });
    }catch(e){
      console.error(e);

      res
        .status(500)
        .json({
          error:
            "Testnachricht konnte nicht verarbeitet werden."
        });
    }
  }
);

async function handleIncomingTextMessage(
  message
){
  const jid=
    message.key.remoteJid;

  if(
    !jid
    ||
    jid.endsWith("@g.us")
    ||
    message.key.fromMe
  ){
    return;
  }

  const text=
    extractTextFromMessageContent(
      message.message
    );

  if(!text){
    return;
  }

  let c=
    await ensureContact(jid);

  const dup=
    await detectImmediateDuplicate(
      jid,
      text
    );

  if(dup){
    await saveMessage(
      jid,
      "incoming",
      text,
      message.key.id||null,
      {
        processingStatus:
          "duplicate",

        duplicateOfMessageId:
          dup.id
      }
    );

    if(
      c?.auto_reply_enabled!==false
      &&
      c?.date_lock_enabled!==true
    ){
      const reply=
        duplicateReplyForContact(c);

      await sock.sendMessage(
        jid,
        {
          text:reply
        }
      );

      await saveMessage(
        jid,
        "outgoing",
        reply,
        null,
        {
          processingStatus:
            "duplicate_reply"
        }
      );
    }

    return;
  }

  const incoming=
    await saveMessage(
      jid,
      "incoming",
      text,
      message.key.id||null
    );

  c=
    await getContactByJid(jid);

  if(
    c?.auto_reply_enabled===false
    ||
    c?.date_lock_enabled===true
  ){
    return;
  }

  const reply=
    await generateAIReply(
      jid,
      text,
      incoming.id
    );

  if(!reply){
    return;
  }

  await sock.sendMessage(
    jid,
    {
      text:reply
    }
  );

  const outgoing=
    await saveMessage(
      jid,
      "outgoing",
      reply
    );

  scheduleMemoryUpdate({
    jid,
    contactId:c.id,
    incomingText:text,
    incomingMessageDbId:
      incoming.id,
    outgoingText:reply,
    outgoingMessageDbId:
      outgoing.id
  });
}

async function handleEditedMessageUpdate(
  entry
){
  try{
    const jid=
      entry
        ?.key
        ?.remoteJid;

    const id=
      entry
        ?.key
        ?.id;

    if(
      !jid
      ||
      !id
      ||
      entry?.key?.fromMe
      ||
      jid.endsWith("@g.us")
    ){
      return;
    }

    const text=
      extractEditedText(
        entry.update
      );

    if(!text){
      return;
    }

    const u=
      await updateEditedIncomingMessage({
        jid,
        whatsappMessageId:id,
        newText:text
      });

    if(u){
      console.log(
        "WhatsApp-Nachricht bearbeitet:",
        id,
        text
      );
    }
  }catch(e){
    console.error(
      "Edit-Verarbeitung fehlgeschlagen:",
      e
    );
  }
}

async function startWhatsApp(){
  if(!WHATSAPP_ENABLED){
    whatsappStatus=
      "disabled";

    console.log(
      "WhatsApp deaktiviert. Kein Socket, kein Pairing, kein Reconnect."
    );

    return;
  }

  whatsappStatus=
    "starting";

  const {
    state,
    saveCreds
  }=
    await useMultiFileAuthState(
      "/app/auth_info"
    );

  const {
    version
  }=
    await fetchLatestBaileysVersion();

  sock=
    makeWASocket({
      version,
      auth:state,
      logger,
      shouldSyncHistoryMessage:
        ()=>false
    });

  sock.ev.on(
    "creds.update",
    saveCreds
  );

  sock.ev.on(
    "messages.upsert",
    async event=>{
      if(
        event.type!=="notify"
        ||
        event.requestId
      ){
        return;
      }

      for(const m of event.messages){
        try{
          await handleIncomingTextMessage(m);
        }catch(e){
          console.error(
            "Incoming Fehler:",
            e
          );
        }
      }
    }
  );

  sock.ev.on(
    "messages.update",
    async updates=>{
      for(const e of updates){
        await handleEditedMessageUpdate(e);
      }
    }
  );

  sock.ev.on(
    "connection.update",
    async update=>{
      const {
        connection,
        lastDisconnect,
        qr
      }=
        update;

      if(
        connection==="open"
      ){
        whatsappStatus=
          "connected";

        pairingCode=
          null;
      }

      if(
        connection==="connecting"
      ){
        whatsappStatus=
          "connecting";
      }

      if(
        qr
        &&
        !state.creds.registered
        &&
        !pairingCode
      ){
        const phone=
          process.env
            .WHATSAPP_PHONE_NUMBER;

        if(phone){
          try{
            pairingCode=
              await sock.requestPairingCode(
                phone.replace(
                  /\D/g,
                  ""
                )
              );

            console.log(
              "PAIRING CODE:",
              pairingCode
            );
          }catch(e){
            console.error(
              "Pairing-Code Fehler:",
              e
            );
          }
        }
      }

      if(
        connection==="close"
      ){
        whatsappStatus=
          "disconnected";

        const statusCode=
          lastDisconnect
            ?.error
            ?.output
            ?.statusCode;

        if(
          statusCode
          !==
          DisconnectReason.loggedOut
        ){
          setTimeout(
            startWhatsApp,
            5000
          );
        }
      }
    }
  );
}

app.listen(
  port,
  async()=>{
    console.log(
      `Server läuft auf Port ${port}`
    );

    try{
      await initDatabase();
    }catch(e){
      console.error(
        "PostgreSQL Initialisierung fehlgeschlagen:",
        e
      );
    }

    startWhatsApp()
      .catch(
        console.error
      );
  }
);
