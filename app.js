'use strict';

// ---------------------------------------------------------------------------
// Konfiguration
// ---------------------------------------------------------------------------
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
const OVERPASS_TIMEOUT_MS = 20000;
const OSRM = 'https://router.project-osrm.org';

const SEARCH_RADII = [1500, 4000, 10000];  // m, wird schrittweise vergrößert
const CANDIDATES = 8;                       // so viele Parkplätze werden per Fahrzeit verglichen
const BBOX_MIN_ZOOM = 14;                   // ab diesem Zoom werden Parkplätze im Ausschnitt geladen
const OFF_ROUTE_M = 50;                     // Abweichung, ab der neu berechnet wird
const ARRIVE_M = 25;

// Zugangswerte, die einen Parkplatz für die Öffentlichkeit ausschließen
const NON_PUBLIC = new Set(['private', 'no', 'customers', 'permit', 'residents',
  'delivery', 'employees', 'agricultural', 'forestry', 'military', 'emergency']);

// ---------------------------------------------------------------------------
// Karte und Basemaps
// ---------------------------------------------------------------------------
const map = L.map('map', { zoomControl: false }).setView([51.16, 10.45], 6);
L.control.zoom({ position: 'bottomright' }).addTo(map);
L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(map);

const basemaps = {
  topo: L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
    maxNativeZoom: 17, maxZoom: 20, subdomains: 'abc',
    attribution: 'Karte: © <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA), ' +
      'Daten: © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>-Mitwirkende',
  }),
  sat: L.layerGroup([
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      maxNativeZoom: 18, maxZoom: 20,
      attribution: 'Bilder: © Esri, Maxar, Earthstar Geographics | Parkplätze: © ' +
        '<a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>-Mitwirkende',
    }),
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}',
      { maxNativeZoom: 18, maxZoom: 20, opacity: 0.8 }),
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
      { maxNativeZoom: 18, maxZoom: 20 }),
  ]),
};
let currentBase = localStore('basemap') === 'sat' ? 'sat' : 'topo';
basemaps[currentBase].addTo(map);

document.querySelectorAll('#basemap-switch button').forEach(btn => {
  btn.classList.toggle('active', btn.dataset.layer === currentBase);
  btn.addEventListener('click', () => setBasemap(btn.dataset.layer));
});

function setBasemap(name) {
  if (name === currentBase) return;
  map.removeLayer(basemaps[currentBase]);
  basemaps[name].addTo(map);
  currentBase = name;
  localStore('basemap', name);
  document.querySelectorAll('#basemap-switch button')
    .forEach(b => b.classList.toggle('active', b.dataset.layer === name));
}

// ---------------------------------------------------------------------------
// Hilfsfunktionen
// ---------------------------------------------------------------------------
function localStore(key, value) {
  try {
    if (value === undefined) return localStorage.getItem('parkingnavi.' + key);
    localStorage.setItem('parkingnavi.' + key, value);
  } catch (e) { return null; }
}

let toastTimer;
function toast(msg, ms = 3500) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(() => el.classList.add('hidden'), ms);
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function haversine(a, b) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function fmtDist(m) {
  if (m < 50) return 'jetzt';
  if (m < 1000) return `${Math.round(m / 10) * 10} m`;
  return `${(m / 1000).toFixed(m < 10000 ? 1 : 0).replace('.', ',')} km`;
}

function fmtDur(s) {
  const min = Math.max(1, Math.round(s / 60));
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`;
}

// ---------------------------------------------------------------------------
// Parkplätze (OpenStreetMap via Overpass)
// ---------------------------------------------------------------------------
const parkingLayer = L.layerGroup().addTo(map);
const parkings = new Map();   // osm-id -> { id, latlng, tags, marker }

const loadedAreas = [];          // bereits abgefragte Bboxen
let overpassQueue = Promise.resolve();

// Parkplätze für einen Bereich laden – überspringt bereits geladene Bereiche und
// stellt Abfragen hintereinander an (Overpass erlaubt nur wenige gleichzeitige pro Nutzer).
function loadParkings(bounds) {
  const job = overpassQueue.then(async () => {
    if (loadedAreas.some(a => a.contains(bounds))) return;
    addParkings(await overpass(parkingQuery(bounds)));
    loadedAreas.push(bounds);
  });
  overpassQueue = job.catch(() => {});
  return job;
}

async function overpass(query) {
  let lastErr;
  for (const url of OVERPASS_ENDPOINTS) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        body: 'data=' + encodeURIComponent(query),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        signal: AbortSignal.timeout(OVERPASS_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`Overpass ${res.status}`);
      return (await res.json()).elements;
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

function isPublic(tags) {
  const access = (tags.access || '').toLowerCase();
  return !NON_PUBLIC.has(access) && tags['parking'] !== 'garage_boxes' && tags['parking'] !== 'carports';
}

function addParkings(elements) {
  const added = [];
  for (const el of elements) {
    const id = `${el.type}/${el.id}`;
    const tags = el.tags || {};
    if (!isPublic(tags)) continue;
    let p = parkings.get(id);
    if (!p) {
      const lat = el.lat ?? el.center?.lat, lon = el.lon ?? el.center?.lon;
      if (lat == null) continue;
      p = { id, latlng: L.latLng(lat, lon), tags };
      p.marker = L.marker(p.latlng, { icon: parkingIcon(p) })
        .bindPopup(() => popupHtml(p), { maxWidth: 260 })
        .addTo(parkingLayer);
      parkings.set(id, p);
    }
    added.push(p);
  }
  return added;
}

function feeClass(tags) {
  if (tags.fee === 'no') return 'free';
  if (tags.fee && tags.fee !== 'unknown') return 'fee';
  return 'unknown';
}

function parkingIcon(p, target = false) {
  return L.divIcon({
    className: '',
    html: `<div class="p-icon ${feeClass(p.tags)}${target ? ' target' : ''}">P</div>`,
    iconSize: [26, 26], iconAnchor: [13, 13], popupAnchor: [0, -12],
  });
}

const TYPE_NAMES = {
  surface: 'Parkplatz (ebenerdig)', 'multi-storey': 'Parkhaus', underground: 'Tiefgarage',
  street_side: 'Parkstreifen', lane: 'Parken am Fahrbahnrand', rooftop: 'Parkdeck (Dach)',
};

function parkingTitle(p) {
  return p.tags.name || TYPE_NAMES[p.tags.parking] || 'Parkplatz';
}

function popupHtml(p) {
  const t = p.tags, rows = [];
  if (t.parking) rows.push(['Art', TYPE_NAMES[t.parking] || t.parking]);
  if (t.capacity) rows.push(['Stellplätze', t.capacity]);
  if (t['capacity:disabled'] && t['capacity:disabled'] !== 'no')
    rows.push(['Behindertenpl.', t['capacity:disabled'] === 'yes' ? 'ja' : t['capacity:disabled']]);
  rows.push(['Gebühr', t.fee === 'no' ? 'kostenlos' : t.fee === 'yes' ? 'ja' : t.fee || 'unbekannt']);
  if (t.charge) rows.push(['Preis', t.charge]);
  if (t.maxstay) rows.push(['Höchstdauer', t.maxstay]);
  if (t.opening_hours) rows.push(['Geöffnet', t.opening_hours]);
  if (t.access) rows.push(['Zugang', t.access]);
  if (t.operator) rows.push(['Betreiber', t.operator]);
  const [lat, lon] = [p.latlng.lat.toFixed(6), p.latlng.lng.toFixed(6)];
  return `<h4>${esc(parkingTitle(p))}</h4>
    <table>${rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</table>
    <div class="popup-actions">
      <button class="primary" onclick="navigateTo('${p.id}')">➜ Hierhin navigieren</button>
      <a href="https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}&travelmode=driving"
         target="_blank" rel="noopener">In Google Maps öffnen</a>
      <a href="https://www.openstreetmap.org/${p.id}" target="_blank" rel="noopener">Auf OSM ansehen</a>
    </div>`;
}

function parkingQuery(bounds) {
  const bbox = [bounds.getSouth(), bounds.getWest(), bounds.getNorth(), bounds.getEast()]
    .map(v => v.toFixed(5)).join(',');
  return `[out:json][timeout:20];nwr["amenity"="parking"](${bbox});out center tags;`;
}

// Parkplätze im aktuellen Kartenausschnitt nachladen
let bboxTimer;
map.on('moveend', () => {
  clearTimeout(bboxTimer);
  bboxTimer = setTimeout(loadVisibleParkings, 600);
});

async function loadVisibleParkings() {
  if (map.getZoom() < BBOX_MIN_ZOOM) return;
  const b = map.getBounds();
  if (loadedAreas.some(a => a.contains(b))) return;
  try {
    await loadParkings(b.pad(0.3));
  } catch (e) {
    console.warn('Parkplätze konnten nicht geladen werden', e);
  }
}

// ---------------------------------------------------------------------------
// GPS
// ---------------------------------------------------------------------------
let myPos = null, myAccuracy = null, myHeading = null;
let meMarker = null, accCircle = null;
let follow = true, firstFix = true, watchId = null;

const meIcon = () => L.divIcon({
  className: '',
  html: `<div class="me-icon">${myHeading != null
    ? `<div class="me-heading" style="transform:rotate(${myHeading}deg)"></div>` : ''}
    <div class="me-dot"></div></div>`,
  iconSize: [22, 22], iconAnchor: [11, 11],
});

function startGps() {
  if (!('geolocation' in navigator)) {
    toast('Dieses Gerät/Browser unterstützt kein GPS.');
    return;
  }
  if (watchId != null) return;
  watchId = navigator.geolocation.watchPosition(onPosition, onPositionError,
    { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 });
}

function onPosition(pos) {
  const c = pos.coords;
  myPos = L.latLng(c.latitude, c.longitude);
  myAccuracy = c.accuracy;
  if (c.heading != null && !isNaN(c.heading) && (c.speed ?? 0) > 1) myHeading = c.heading;

  if (!meMarker) {
    accCircle = L.circle(myPos, { radius: myAccuracy, weight: 1, color: '#1e88e5', fillOpacity: 0.1, interactive: false }).addTo(map);
    meMarker = L.marker(myPos, { icon: meIcon(), zIndexOffset: 1000, interactive: false }).addTo(map);
  } else {
    meMarker.setLatLng(myPos).setIcon(meIcon());
    accCircle.setLatLng(myPos).setRadius(myAccuracy);
  }

  if (firstFix) {
    firstFix = false;
    map.setView(myPos, 16);
  } else if (follow) {
    map.panTo(myPos, { animate: true });
  }

  if (nav) updateNavigation();
}

function onPositionError(err) {
  const msgs = {
    1: 'Standortzugriff verweigert. Bitte in den Browser-Einstellungen erlauben.',
    2: 'Standort nicht verfügbar.',
    3: 'Standortbestimmung dauert zu lange …',
  };
  toast(msgs[err.code] || 'GPS-Fehler: ' + err.message, 6000);
  if (err.code === 1) { navigator.geolocation.clearWatch(watchId); watchId = null; }
}

// Wer die Karte selbst verschiebt, schaltet das Mitführen ab
map.on('dragstart', () => { follow = false; });

document.getElementById('btn-locate').addEventListener('click', () => {
  follow = true;
  startGps();
  if (myPos) map.setView(myPos, Math.max(map.getZoom(), 16));
  else toast('Suche Standort …');
});

// ---------------------------------------------------------------------------
// Nächsten Parkplatz finden
// ---------------------------------------------------------------------------
const btnNearest = document.getElementById('btn-nearest');
let lastCandidates = [];

btnNearest.addEventListener('click', findNearest);

function waitForPosition(ms = 15000) {
  if (myPos) return Promise.resolve(myPos);
  startGps();
  return new Promise(resolve => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (myPos || Date.now() - t0 > ms || watchId == null) { clearInterval(iv); resolve(myPos); }
    }, 250);
  });
}

async function findNearest() {
  btnNearest.disabled = true;
  try {
    toast('Bestimme Standort …', 0);
    let origin = await waitForPosition();
    if (!origin) {
      origin = map.getCenter();
      toast('Kein GPS – suche ab Kartenmitte.', 4000);
    }

    // Bbox-Abfragen sind für Overpass deutlich günstiger als around:, daher Bbox + Abstandsfilter
    let found = [];
    for (const r of SEARCH_RADII) {
      toast(`Suche Parkplätze im Umkreis von ${fmtDist(r)} …`, 0);
      let failed = false;
      try {
        await loadParkings(origin.toBounds(2 * r));
      } catch (e) {
        console.warn('Overpass nicht erreichbar, nutze bereits geladene Parkplätze', e);
        failed = true;
      }
      found = [...parkings.values()].filter(p => haversine(origin, p.latlng) <= r);
      if (failed) {
        if (!found.length) {
          toast('Parkplatz-Server gerade überlastet – bitte in einer Minute erneut versuchen.', 6000);
          return;
        }
        break;
      }
      if (found.length >= 3) break;
    }
    if (!found.length) { toast('Keine öffentlichen Parkplätze in der Nähe gefunden.'); return; }

    // Luftlinie vorsortieren, dann echte Fahrzeit vergleichen
    found.sort((a, b) => haversine(origin, a.latlng) - haversine(origin, b.latlng));
    let cands = found.slice(0, CANDIDATES).map(p => ({ p, air: haversine(origin, p.latlng) }));

    toast('Vergleiche Fahrzeiten …', 0);
    try {
      const coords = [origin, ...cands.map(c => c.p.latlng)].map(l => `${l.lng},${l.lat}`).join(';');
      const res = await fetch(`${OSRM}/table/v1/driving/${coords}?sources=0&annotations=duration,distance`);
      const data = await res.json();
      if (data.code !== 'Ok') throw new Error(data.code);
      cands.forEach((c, i) => {
        c.duration = data.durations[0][i + 1];
        c.distance = data.distances[0][i + 1];
      });
      cands = cands.filter(c => c.duration != null)
        .sort((a, b) => a.duration - b.duration);
    } catch (e) {
      console.warn('Fahrzeitvergleich fehlgeschlagen, nutze Luftlinie', e);
    }
    if (!cands.length) { toast('Kein Parkplatz per Auto erreichbar.'); return; }

    lastCandidates = cands;
    document.getElementById('toast').classList.add('hidden');
    await navigateTo(cands[0].p.id);
  } catch (e) {
    console.error(e);
    toast('Fehler bei der Suche: ' + e.message, 6000);
  } finally {
    btnNearest.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Routing und Navigation (OSRM)
// ---------------------------------------------------------------------------
let nav = null;        // aktiver Navigationszustand
let routeLine = null;
let voiceOn = localStore('voice') !== 'off';
let wakeLock = null;

const MODIFIERS = {
  uturn: ['wenden', '⤸'],
  'sharp right': ['scharf rechts abbiegen', '↱'],
  right: ['rechts abbiegen', '→'],
  'slight right': ['leicht rechts halten', '↗'],
  straight: ['geradeaus fahren', '↑'],
  'slight left': ['leicht links halten', '↖'],
  left: ['links abbiegen', '←'],
  'sharp left': ['scharf links abbiegen', '↰'],
};

function instruction(step) {
  const m = step.maneuver;
  const road = step.name ? ` auf ${step.name}` : (step.ref ? ` auf ${step.ref}` : '');
  const [verb, arrow] = MODIFIERS[m.modifier] || ['weiterfahren', '↑'];
  const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
  switch (m.type) {
    case 'depart': return ['Losfahren' + road, '↑'];
    case 'arrive': return ['Parkplatz erreicht', '🅿'];
    case 'roundabout':
    case 'rotary':
      return [m.exit ? `Im Kreisverkehr die ${m.exit}. Ausfahrt nehmen${road}` : `In den Kreisverkehr${road}`, '⟳'];
    case 'exit roundabout':
    case 'exit rotary': return ['Kreisverkehr verlassen' + road, arrow];
    case 'merge': return ['Einfädeln' + road, arrow];
    case 'on ramp': return ['Auffahrt nehmen' + road, arrow];
    case 'off ramp': return ['Ausfahrt nehmen' + road, arrow];
    case 'fork': return [`An der Gabelung ${m.modifier?.includes('left') ? 'links' : 'rechts'} halten${road}`, arrow];
    case 'end of road': return [`Am Straßenende ${verb}${road}`, arrow];
    case 'new name':
      if (!m.modifier || m.modifier === 'straight') return [step.name ? `Weiter auf ${step.name}` : 'Weiter geradeaus', '↑'];
      return [cap(verb) + road, arrow];
    case 'continue': return [(m.modifier === 'straight' ? 'Weiter geradeaus' : cap(verb)) + road, arrow];
    default: return [cap(verb) + road, arrow];
  }
}

async function fetchRoute(from, to) {
  const url = `${OSRM}/route/v1/driving/${from.lng},${from.lat};${to.lng},${to.lat}` +
    '?overview=full&geometries=geojson&steps=true';
  const data = await (await fetch(url)).json();
  if (data.code !== 'Ok' || !data.routes.length) throw new Error('Keine Route gefunden');
  return data.routes[0];
}

// Route in Meter-Koordinaten aufbereiten, damit die Position auf der Route schnell bestimmt werden kann
function prepareRoute(route) {
  const pts = route.geometry.coordinates.map(([lng, lat]) => L.latLng(lat, lng));
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + haversine(pts[i - 1], pts[i]));
  let acc = 0;
  const steps = route.legs[0].steps.map(s => {
    const start = acc;
    acc += s.distance;
    return { ...s, start };
  });
  // Steps-Summen und Geometrie-Länge leicht angleichen
  const scale = cum[cum.length - 1] / (acc || 1);
  steps.forEach(s => { s.start *= scale; });
  return { pts, cum, steps, length: cum[cum.length - 1], duration: route.duration };
}

// Projektion der Position auf die Route: liefert Abstand zur Route und gefahrene Strecke
function locateOnRoute(r, pos) {
  const kx = Math.cos(pos.lat * Math.PI / 180) * 111320, ky = 110540;
  let best = { d: Infinity, along: 0 };
  for (let i = 0; i < r.pts.length - 1; i++) {
    const a = r.pts[i], b = r.pts[i + 1];
    const ax = (a.lng - pos.lng) * kx, ay = (a.lat - pos.lat) * ky;
    const bx = (b.lng - pos.lng) * kx, by = (b.lat - pos.lat) * ky;
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
    const px = ax + t * dx, py = ay + t * dy, d = Math.hypot(px, py);
    if (d < best.d) best = { d, along: r.cum[i] + t * (r.cum[i + 1] - r.cum[i]) };
  }
  return best;
}

async function navigateTo(id) {
  const p = parkings.get(id);
  if (!p) return;
  map.closePopup();
  const origin = myPos || await waitForPosition(8000) || map.getCenter();
  if (!myPos) toast('Kein GPS – Route ab Kartenmitte.', 4000);
  try {
    const route = await fetchRoute(origin, p.latlng);
    startNavigation(p, route);
  } catch (e) {
    toast(e.message, 5000);
  }
}
window.navigateTo = navigateTo;   // für die Popup-Buttons

function startNavigation(target, route) {
  if (nav?.target && nav.target !== target) nav.target.marker.setIcon(parkingIcon(nav.target));
  target.marker.setIcon(parkingIcon(target, true));

  nav = { target, route: prepareRoute(route), lastStep: -1, announcedNear: -1, lastReroute: Date.now() };
  drawRoute();
  map.fitBounds(routeLine.getBounds(), { padding: [60, 140], maxZoom: 17 });
  follow = false;
  setTimeout(() => { follow = true; }, 4000);   // nach dem Überblick wieder mitführen

  document.getElementById('nav-banner').classList.remove('hidden');
  document.getElementById('btn-stop').classList.remove('hidden');
  document.getElementById('btn-voice').classList.remove('hidden');
  document.getElementById('btn-nearest').classList.add('hidden');
  updateVoiceButton();
  requestWakeLock();
  renderPanel();
  updateNavigation();
}

function drawRoute() {
  if (routeLine) map.removeLayer(routeLine);
  routeLine = L.featureGroup([
    L.polyline(nav.route.pts, { color: '#0d47a1', weight: 9, opacity: 0.6 }),
    L.polyline(nav.route.pts, { color: '#42a5f5', weight: 5 }),
  ]).addTo(map);
}

function stopNavigation() {
  if (nav?.target) nav.target.marker.setIcon(parkingIcon(nav.target));
  nav = null;
  if (routeLine) { map.removeLayer(routeLine); routeLine = null; }
  document.getElementById('nav-banner').classList.add('hidden');
  document.getElementById('btn-stop').classList.add('hidden');
  document.getElementById('btn-voice').classList.add('hidden');
  document.getElementById('btn-nearest').classList.remove('hidden');
  document.getElementById('panel-info').classList.add('hidden');
  window.speechSynthesis?.cancel();
  wakeLock?.release().catch(() => {});
  wakeLock = null;
}
document.getElementById('btn-stop').addEventListener('click', stopNavigation);

function renderPanel(remaining) {
  const r = nav.route, t = nav.target;
  const left = remaining ?? r.length;
  const eta = new Date(Date.now() + r.duration * (left / r.length) * 1000);
  const info = document.getElementById('panel-info');
  const fee = { free: 'kostenlos', fee: 'gebührenpflichtig', unknown: 'Gebühr unbekannt' }[feeClass(t.tags)];
  let html = `<h3>🅿 ${esc(parkingTitle(t))}</h3>
    <div class="meta">${fmtDist(left).replace('jetzt', '< 50 m')} · ${fmtDur(r.duration * left / r.length)} ·
      Ankunft ${eta.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}<br>
      ${fee}${t.tags.capacity ? ` · ${esc(t.tags.capacity)} Plätze` : ''}</div>`;
  if (lastCandidates.length > 1 && lastCandidates.some(c => c.p === t)) {
    html += '<div class="alts">' + lastCandidates.slice(0, 5).map(c =>
      `<div class="alt${c.p === t ? ' current' : ''}" data-id="${c.p.id}">
        <span>${esc(parkingTitle(c.p))}</span>
        <span>${c.duration != null ? fmtDur(c.duration) + ' · ' + fmtDist(c.distance) : fmtDist(c.air) + ' Luftlinie'}</span>
      </div>`).join('') + '</div>';
  }
  info.innerHTML = html;
  info.classList.remove('hidden');
  info.querySelectorAll('.alt').forEach(el =>
    el.addEventListener('click', () => navigateTo(el.dataset.id)));
}

async function updateNavigation() {
  if (!nav) return;
  const r = nav.route;
  if (!myPos) {
    const [text, arrow] = instruction(r.steps[Math.min(1, r.steps.length - 1)]);
    setBanner(arrow, fmtDist(r.steps[1]?.start ?? 0), text);
    return;
  }
  const { d, along } = locateOnRoute(r, myPos);

  // Von der Route abgekommen -> neu berechnen
  if (d > Math.max(OFF_ROUTE_M, myAccuracy || 0) && Date.now() - nav.lastReroute > 10000) {
    nav.lastReroute = Date.now();
    toast('Route wird neu berechnet …');
    try {
      const route = await fetchRoute(myPos, nav.target.latlng);
      if (!nav) return;
      Object.assign(nav, { route: prepareRoute(route), lastStep: -1, announcedNear: -1 });
      drawRoute();
      speak('Route wird neu berechnet');
      return updateNavigation();
    } catch (e) { console.warn(e); }
    return;
  }

  const remaining = r.length - along;
  if (remaining < ARRIVE_M) {
    setBanner('🅿', 'Ziel erreicht', parkingTitle(nav.target));
    speak('Sie haben Ihr Ziel erreicht');
    toast('Parkplatz erreicht 🎉', 5000);
    stopNavigation();
    return;
  }

  // nächstes Manöver vor der aktuellen Position
  let idx = r.steps.findIndex(s => s.start > along + 5);
  if (idx < 0) idx = r.steps.length - 1;
  const step = r.steps[idx];
  const dist = Math.max(0, step.start - along);
  const [text, arrow] = instruction(step);
  setBanner(arrow, fmtDist(dist), text);

  if (idx !== nav.lastStep) {
    nav.lastStep = idx;
    if (dist > 250) speak(`In ${fmtDist(dist).replace(',', ' Komma ')} ${text}`);
  }
  if (dist <= 120 && nav.announcedNear !== idx) {
    nav.announcedNear = idx;
    speak(dist < 50 ? text : `In ${fmtDist(dist)} ${text}`);
  }
  renderPanel(remaining);
}

function setBanner(arrow, dist, text) {
  document.getElementById('nav-arrow').textContent = arrow;
  document.getElementById('nav-dist').textContent = dist;
  document.getElementById('nav-text').textContent = text;
}

// ---------------------------------------------------------------------------
// Sprachansagen und Bildschirm-wach-halten
// ---------------------------------------------------------------------------
function speak(text) {
  if (!voiceOn || !('speechSynthesis' in window)) return;
  const u = new SpeechSynthesisUtterance(text.replace(/ m\b/g, ' Meter').replace(/ km\b/g, ' Kilometer'));
  u.lang = 'de-DE';
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
}

function updateVoiceButton() {
  document.getElementById('btn-voice').textContent = voiceOn ? '🔊' : '🔇';
}
document.getElementById('btn-voice').addEventListener('click', () => {
  voiceOn = !voiceOn;
  localStore('voice', voiceOn ? 'on' : 'off');
  if (!voiceOn) window.speechSynthesis?.cancel();
  updateVoiceButton();
});

async function requestWakeLock() {
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch (e) { /* nicht unterstützt */ }
}
document.addEventListener('visibilitychange', () => {
  if (nav && document.visibilityState === 'visible') requestWakeLock();
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
startGps();
