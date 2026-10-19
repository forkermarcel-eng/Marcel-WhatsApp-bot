const base = (process.env.BRAIN_LIVE_BASE_URL || 'https://cooperative-kindness-production.up.railway.app').replace(/\/+$/, '');
const secret = process.env.DASHBOARD_API_SECRET;
if (!secret) throw new Error('DASHBOARD_API_SECRET fehlt.');
const headers = { authorization: `Bearer ${secret}` };
const request = async (path) => {
  const response = await fetch(`${base}${path}`, { headers });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.json();
};

const [brain, news, weather, markets] = await Promise.all([
  request('/dashboard-api/marcel-brain'),
  request('/dashboard-api/marcel-brain/world?op=news&size=24&language=de'),
  request('/dashboard-api/marcel-brain/world?op=weather&lat=48.1372&lon=11.5756'),
  request('/dashboard-api/marcel-brain/world?op=markets'),
]);
const approved = (brain.items || []).filter((item) => item.humanVerified && item.allowedForBot && item.status === 'active');
const height = approved.find((item) => item.key === 'height');
const containsExpectedHeight = (value) => {
  if (value === 183 || value === '183') return true;
  if (Array.isArray(value)) return value.some(containsExpectedHeight);
  if (value && typeof value === 'object') return Object.values(value).some(containsExpectedHeight);
  return false;
};
const articles = news.items || news.articles || [];
console.log(JSON.stringify({
  ok: true,
  brain: { approvedFactCount: approved.length, verifiedHeightFact: containsExpectedHeight(height?.value) },
  news: { count: articles.length, german: articles.filter((item) => item.language === 'de').length, withImage: articles.filter((item) => Boolean(item.imageUrl)).length, withSource: articles.filter((item) => Boolean(item.source)).length },
  weather: { hasCurrent: Boolean(weather.weather?.current || weather.weather?.temperature), hourly: weather.weather?.hourly?.length || 0, daily: weather.weather?.daily?.length || 0 },
  markets: { items: markets.items?.length || markets.series?.length || 0 },
}, null, 2));
