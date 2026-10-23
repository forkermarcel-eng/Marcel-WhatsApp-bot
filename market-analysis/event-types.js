// Explicit macro families, not a claim that headlines establish causal events.
const definitions=[
  ['PCE',/\bpce\b|personal consumption expenditures/i],
  ['CPI',/\bcpi\b|consumer price|verbraucherpreis/i],
  ['NFP',/\bnfp\b|non.?farm payroll/i],
  ['FED_RATE',/\bfomc\b|(?:federal reserve|\bfed\b).*(?:rate|zins|policy|entscheidung)/i],
  ['ECB_RATE',/(?:\becb\b|\bezb\b|european central bank).*(?:rate|zins|policy|entscheidung)/i],
  ['BOJ_RATE',/(?:\bboj\b|bank of japan).*(?:rate|zins|policy|entscheidung)/i],
  ['ISM',/\bism\b/i],['PMI',/\bpmi\b|purchasing managers|einkaufsmanager/i],
  ['GDP',/\bgdp\b|\bbip\b|gross domestic product|bruttoinlandsprodukt/i],
  ['OIL_INVENTORIES',/(?:oil|crude|petroleum|öl).*(?:inventor|stock|bestand|beständ)|(?:eia).*(?:inventor|stock)/i],
];
export const EVENT_FAMILIES=Object.freeze(definitions.map(([name])=>name));
export function eventFamily(event) {
  const text=(event.title ?? '')+' '+(event.seriesId ?? '');
  return definitions.find(([,pattern])=>pattern.test(text))?.[0] ?? null;
}
