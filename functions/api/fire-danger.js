// Backup for the race-day fire danger panel (weather.js).
// Browsers normally get fire danger ratings straight from the SA CFS. If the CFS ever
// stops allowing that, the site asks this instead: Cloudflare Pages runs it for free
// at /api/fire-danger, fetches the same CFS data and keeps a copy for 15 minutes.
// Nothing to set up: Cloudflare Pages picks up the functions folder by itself.

const FIELDS = ['firebandistrict'];
for (let i = 0; i <= 4; i++) FIELDS.push('ratingdate_' + i, 'firedangerrating_' + i, 'tfb' + i);

export async function onRequestGet() {
  const url = 'https://cfs.geohub.sa.gov.au/server/rest/services/CFS_Custodial_Read/South_Australia_Fire_Danger_Ratings_Read/MapServer/1/query?' +
    new URLSearchParams({ where: '1=1', outFields: FIELDS.join(','), returnGeometry: 'false', f: 'json' });
  try {
    const res = await fetch(url, { cf: { cacheTtl: 900, cacheEverything: true } });
    if (!res.ok) throw new Error(res.status);
    return new Response(await res.text(), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=900' }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: 'CFS feed unavailable' }), { status: 502, headers: { 'Content-Type': 'application/json' } });
  }
}
