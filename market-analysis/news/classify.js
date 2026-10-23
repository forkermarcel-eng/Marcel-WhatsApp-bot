// Transparent relevance rules, never trading direction or causal attribution.
const rules = [
  ['central-bank', 'CENTRAL_BANK', /\bfomc\b|interest rate|zinsentscheid|geldpolit|monetary policy|policy decision/i],
  ['inflation', 'INFLATION', /\bcpi\b|\bpce\b|inflation|consumer prices|verbraucherpreis/i],
  ['labour', 'LABOUR', /\bnfp\b|payroll|employment|unemployment|arbeitslos|arbeitsmarkt|jolts/i],
  ['growth', 'GROWTH', /\bgdp\b|\bbip\b|gross domestic|economic growth|wirtschaftswachstum/i],
  ['pmi', 'PMI', /\bpmi\b|\bism\b|purchasing managers|einkaufsmanager/i],
  ['yields', 'YIELDS', /treasury yield|bond yield|anleiherendite|yield curve/i],
  ['energy', 'ENERGY', /oil|crude|petroleum|natural gas|ölbestand|ölpreis|erdgas|\bopec\b/i],
  ['risk', 'GEOPOLITICS', /sanction|sanktion|war\b|krieg|geopolit|conflict|konflikt/i],
  ['currencies', 'CURRENCIES', /exchange rate|wechselkurs|currency|währung/i],
];
const explicit = {US: ['USD'], EU: ['EUR'], DE: ['EUR'], JP: ['JPY'], GB: ['GBP'], CA: ['CAD'], AU: ['AUD'], CH: ['CHF']};
export const EVENT_TYPES = new Set([...rules.map(([, type]) => type), 'OTHER']);
export function classifyEvent({title, type = null, country = null, currency = null, sourceCountry = null}) {
  const matches = rules.filter(([, , pattern]) => pattern.test(title));
  const eventType = EVENT_TYPES.has(type) ? type : matches[0]?.[1] ?? 'OTHER';
  const evidence = matches.map(([id]) => 'title-rule:' + id);
  const countries = new Set(country ? [country] : []);
  if (!country) {
    if (/\becb\b|\bezb\b|euro area|eurozone/i.test(title)) countries.add('EU');
    if (/bank of japan|\bboj\b|japan/i.test(title)) countries.add('JP');
    if (/federal reserve|\bfomc\b|\bu\.?s\.?\b|united states/i.test(title)) countries.add('US');
    if (!countries.size && sourceCountry) { countries.add(sourceCountry); evidence.push('source-context:country'); }
  }
  const currencies = new Set(currency ? [currency] : []);
  for (const c of countries) for (const fx of explicit[c] ?? []) currencies.add(fx);
  if (eventType === 'ENERGY') { currencies.add('CAD'); currencies.add('NOK'); evidence.push('rule:energy-currencies'); }
  const groups = eventType === 'GEOPOLITICS' ? ['forex', 'metals', 'indices', 'energy', 'commodities']
    : eventType === 'ENERGY' ? ['energy']
    : eventType === 'OTHER' ? [] : ['forex', 'metals', 'indices'];
  return {type: eventType, topics: [...new Set([eventType, ...matches.map(([, t]) => t)])],
    countries: [...countries].sort(), currencies: [...currencies].sort(), groups,
    evidence, meaning: 'POTENTIALLY_RELEVANT', direction: null};
}
export function matchMarkets(classification, instruments = []) {
  return instruments.filter(x => x.active).flatMap(x => {
    const reasons = [];
    if (classification.currencies.includes(x.base) || classification.currencies.includes(x.quote)) reasons.push('currency-exposure');
    if (classification.groups.includes(x.group) && x.group !== 'forex') reasons.push('asset-group-relevance');
    if (classification.type === 'GEOPOLITICS' && classification.groups.includes(x.group)) reasons.push('global-risk-context');
    return reasons.length ? [{instrumentId: x.id, reasons, direction: null}] : [];
  });
}
