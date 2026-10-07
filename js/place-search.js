// Smarter place search (free, OpenStreetMap data) + reading locations from Google Maps links.
// Used by checkout (customer delivery pin) and admin (shop location).

const GHANA_BBOX = '-3.3,4.5,1.3,11.3'; // minLon,minLat,maxLon,maxLat
const FILLER = /\b(near|nearby|opposite|opp|behind|beside|besides|junction|jxn|jn|around|close to|closeby|after|before|by|the|area|off|along|via|in)\b/gi;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function distanceKm(a, b) {
  const R = 6371, rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

async function nominatim(q, near) {
  const d = 0.7; // prefer (not limit to) places within ~75 km of the shop
  const box = near ? `&viewbox=${near.lng - d},${near.lat + d},${near.lng + d},${near.lat - d}&bounded=0` : '';
  const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&countrycodes=gh&limit=8${box}&q=${encodeURIComponent(q)}`);
  if (!r.ok) return [];
  return (await r.json()).map((p) => ({ name: p.display_name, lat: parseFloat(p.lat), lng: parseFloat(p.lon) }));
}

// Photon: same OpenStreetMap data, but much more forgiving with typos and half-typed names
async function photon(q, near) {
  const bias = near ? `&lat=${near.lat}&lon=${near.lng}` : '';
  const r = await fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=8&bbox=${GHANA_BBOX}${bias}`);
  if (!r.ok) return [];
  const data = await r.json();
  return (data.features || [])
    .filter((f) => !f.properties.countrycode || f.properties.countrycode === 'GH')
    .map((f) => {
      const p = f.properties;
      const parts = [p.name, p.street, p.district || p.locality, p.city || p.county, p.state].filter(Boolean);
      return { name: [...new Set(parts)].join(', '), lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0] };
    });
}

// Other ways of writing the same search: without filler words, with the city added, shorter
function variants(q, cityHint) {
  const cleaned = q.replace(FILLER, ' ').replace(/[^\p{L}\p{N}\s,'-]/gu, ' ').replace(/\s+/g, ' ').replace(/^[\s,]+|[\s,]+$/g, '');
  const words = cleaned.replace(/,/g, ' ').split(' ').filter(Boolean);
  const list = [cleaned];
  if (cityHint && !cleaned.toLowerCase().includes(cityHint.toLowerCase())) list.push(`${cleaned}, ${cityHint}`);
  if (words.length > 2) list.push(words.slice(0, 2).join(' '));
  if (words.length > 1) list.push(words[0]);
  return [...new Set(list)].filter((v) => v.length >= 2 && v.toLowerCase() !== q.toLowerCase());
}

/**
 * Search for a place in Ghana. near = { lat, lng } of the shop (results close to it come first).
 * Returns up to 8 results: { name, lat, lng, km }
 */
export async function searchPlaces(query, near, cityHint = '') {
  const q = String(query || '').trim();
  if (q.length < 2) return [];
  let found = [];

  const first = await Promise.allSettled([photon(q, near), nominatim(q, near)]);
  first.forEach((r) => { if (r.status === 'fulfilled') found.push(...r.value); });

  // Nothing yet? Try other spellings one by one (OpenStreetMap asks for about one search per second)
  if (found.length === 0) {
    for (const v of variants(q, cityHint)) {
      await sleep(1100);
      try { found.push(...(await nominatim(v, near))); } catch (e) { /* keep trying */ }
      if (found.length === 0) { try { found.push(...(await photon(v, near))); } catch (e) { /* ignore */ } }
      if (found.length) break;
    }
  }

  const seen = new Set();
  found = found.filter((p) => {
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng)) return false;
    const key = `${p.lat.toFixed(3)},${p.lng.toFixed(3)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (near) found.forEach((p) => { p.km = distanceKm(near, p); });
  if (near) found.sort((a, b) => a.km - b.km);
  return found.slice(0, 8);
}

// ---------- Google Maps links and coordinates ----------
/** Reads a location from pasted text: plain coordinates, 6°41'48"N 1°37'21"W, or a full Google Maps link. */
export function parseCoords(text) {
  let t = String(text || '');
  try { t = decodeURIComponent(t); } catch (e) { /* keep as is */ }
  const ok = (lat, lng) => Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);

  const dms = t.match(/(\d{1,2})°\s*(\d{1,2})['′]\s*([\d.]+)["″]?\s*([NS])[\s,]+(\d{1,3})°\s*(\d{1,2})['′]\s*([\d.]+)["″]?\s*([EW])/i);
  if (dms) {
    const lat = (+dms[1] + dms[2] / 60 + dms[3] / 3600) * (/s/i.test(dms[4]) ? -1 : 1);
    const lng = (+dms[5] + dms[6] / 60 + dms[7] / 3600) * (/w/i.test(dms[8]) ? -1 : 1);
    if (ok(lat, lng)) return { lat, lng };
  }
  const patterns = [
    /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/,                                       // exact place pin
    /[?&](?:q|query|ll|destination|daddr|center)=(-?\d+(?:\.\d+)?)\s*,\s*\+?(-?\d+(?:\.\d+)?)/,
    /\/(?:place|search|dir)\/(?:[^/]*\/)?(-?\d{1,2}\.\d{3,}),\s*\+?(-?\d{1,3}\.\d{3,})/,
    /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/,                                          // map view centre
    /^\s*\(?\s*(-?\d{1,2}\.\d+)\s*[, ]\s*(-?\d{1,3}\.\d+)\s*\)?\s*$/                 // "6.6966, -1.6225"
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (m) {
      const lat = parseFloat(m[1]), lng = parseFloat(m[2]);
      if (ok(lat, lng)) return { lat, lng };
    }
  }
  return null;
}

/** True for Google Maps links (short or long) that may need the server to open them */
export const looksLikeMapLink = (t) =>
  /(maps\.app\.goo\.gl|goo\.gl\/maps|g\.co\/kgs|google\.[a-z.]+\/maps|maps\.google\.)/i.test(String(t || ''));
