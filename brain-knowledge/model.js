import { createHash } from 'node:crypto';

export const DOMAINS = ['MARCEL_DNA','SOCIAL_MEDIA','TRADING','BUSINESS','MEDIA_AI','MASTER_BRAIN_ARCHITECTURE','PERSONAL_KNOWLEDGE'];
export const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
export const normalize = text => String(text).normalize('NFKC').replace(/\s+/g,' ').trim();
const patterns = {
  MARCEL_DNA: /humor|humour|schreibstil|sprachstil|kommunikationsregel|persönlichkeit|personality|progressive.disclosure|ki.floskel|arbeitsweise|denkweise/i,
  SOCIAL_MEDIA: /instagram|tiktok|facebook|twitter|social.media|reels?\b|stories\b|content.dna|zielmärkte|reichweite|follower/i,
  TRADING: /trading|topstep|nasdaq|nas100|order.?block|fair.value.gap|\bfvg\b|\bsmc\b|\bict\b|liquidit|stop.loss|risikomanagement|gold|\bm5\b/i,
  BUSINESS: /luxe|boutique|barber|e.commerce|markenstrategie|produktentwicklung|shop|business|geschäftsprojekt/i,
  MEDIA_AI: /video|schnitttechnik|meme|audio|bildbearbeitung|medienproduktion|ffmpeg|ffprobe|vision|sticker/i,
  MASTER_BRAIN_ARCHITECTURE: /brain|architektur|architecture|lokale.ki|datenbank|postgres|sqlite|railway|vercel|agent|hardware|gpu|rechner|migration|schnittstelle|deployment|repository|index\.js/i,
  PERSONAL_KNOWLEDGE: /geburtstag|kinder|tochter|sohn|familie|wohnort|partnerin|religion|sexualit|gesundheit|birthday|children|daughter|son\b|family/i
};

// Credential-bearing paragraphs are never stored. Private third-party material
// is registered as excluded, not fed into a model or copied into Git.
export function secretRisk(text) {
  return /(?:postgres(?:ql)?:\/\/[^\s]+|-----BEGIN .*PRIVATE KEY|\bsk-[A-Za-z0-9_-]{16,}|\bgh[pousr]_[A-Za-z0-9]{20,}|(?:password|passwort|api[_ -]?key|secret|access[_ -]?token)\s*[:=]\s*["']?[^\s"'<>]{8,})/i.test(text);
}
export function sensitive(text) {
  return /\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b|(?:\+\d[\d ()-]{8,}\d)|sexual|intim|gesundheit|krankheit|diagnos|geburtstag|tochter|sohn|children|daughter|familie|family/i.test(text);
}
export function classify(text, source = {}) {
  const domains = source.domains ? [...source.domains] : source.domain ? [source.domain] : Object.entries(patterns).filter(([,re]) => re.test(text)).map(([key]) => key);
  if (!domains.length) domains.push('MASTER_BRAIN_ARCHITECTURE');
  const personal = domains.includes('PERSONAL_KNOWLEDGE') || sensitive(text);
  const historical = /\bhistorisch\b|\bhistorical\b|\bveraltet\b|\büberholt\b/i.test(text) || source.historical === true;
  const hypothesis = /hypothes|vermutung|möglicherweise|possibly|unbewiesen/i.test(text);
  const planned = /geplant|\bplant\b|vorgesehen|zukünftig|später|noch (?:offen|nicht)|nicht implementiert|planned|future|not implemented|\bTODO\b/i.test(text);
  const opinion = /meine meinung|ich (?:finde|denke|glaube)|persönliche meinung|my opinion/i.test(text);
  const tradingParameter = domains.includes('TRADING') && /\d/.test(text) && /punkte|pips|\bsl\b|stop|risiko|risk|%|kontrakt|contracts|versuch/i.test(text);
  const kind = historical ? 'historical' : hypothesis ? 'hypothesis' : planned ? 'plan' : opinion ? 'opinion' : source.kind || 'documented_statement';
  return { domains, kind, personal, knowledgeLayer:source.knowledgeLayer||(historical?'PROJECT_HISTORY':personal?'MARCEL_MEMORY':'KNOWLEDGE_LIBRARY'), sensitivity:personal?'private':'internal', reviewRequired:personal||tradingParameter||hypothesis, reviewReason:personal?'personal_or_sensitive':tradingParameter?'trading_parameter_requires_current_confirmation':hypothesis?'hypothesis':'', status:historical?'historical':personal||tradingParameter||hypothesis?'pending':'active' };
}

export function candidateFromBlock(source, block) {
  const text = normalize(block.text);
  if (text.length < 35 || text.length > 6000 || secretRisk(text)) return null;
  // Do not ingest executable dumps, build logs or punctuation-only UI fragments.
  if (/^(?:import .* from |const .* =|SELECT |INSERT INTO |CREATE TABLE |function |async function |\{|\})/.test(text)) return null;
  const type = classify(text+' '+(block.section||''), {...source,historical:block.historical??source.historical,knowledgeLayer:block.knowledgeLayer||source.knowledgeLayer});
  if(block.forceReview||source.reviewAll){type.reviewRequired=true;type.reviewReason='source_requires_owner_review';if(type.status!=='historical')type.status='pending';}
  const contentHash = hash(text.toLocaleLowerCase('de'));
  return { id:hash([source.project||'marcel',type.domains.slice().sort(),contentHash]), project:source.project||'marcel', text, contentHash, ...type, topics:block.topics||[], subjectKey:block.subjectKey||null, documentId:source.id, locator:block.locator, section:block.section||null, effectiveDate:block.date||source.effectiveDate||null, sourceAuthority:source.authority||'document', version:1, createdAt:new Date().toISOString(), updatedAt:new Date().toISOString() };
}
