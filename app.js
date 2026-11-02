'use strict';

/* ============ Réglages ============ */
const SPECIES = [
  'Brochet', 'Perche commune', 'Silure glane', 'Sandre', 'Chevesne',
  'Black-bass', 'Truite fario', 'Carpe commune', 'Gardon', 'Brème',
  'Barbeau', 'Ablette'
];
const OTHER = 'Autre…';

const TILES_SAT = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const TILES_LABELS = 'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}';
const ATTR = 'Imagerie © Esri, Maxar, Earthstar Geographics';

/* ============ Petits outils ============ */
const $ = (s) => document.querySelector(s);

function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, ms);
}

function pad(n) { return String(n).padStart(2, '0'); }
function toLocalInput(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fmtDate(ts) {
  return new Date(ts).toLocaleString('fr-FR', { dateStyle: 'long', timeStyle: 'short' });
}
function num(str) {
  const v = parseFloat(String(str).trim().replace(',', '.'));
  return Number.isFinite(v) ? v : null;
}
function fmtLen(v) {
  return `${String(v).replace('.', ',')} cm`;
}

/* ============ Stockage (IndexedDB) ============ */
const DB = (() => {
  let db;
  const open = () => new Promise((res, rej) => {
    const r = indexedDB.open('fishlog', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('catches', { keyPath: 'id', autoIncrement: true });
    r.onsuccess = () => { db = r.result; res(); };
    r.onerror = () => rej(r.error);
  });
  const run = (mode, fn) => new Promise((res, rej) => {
    const t = db.transaction('catches', mode);
    const req = fn(t.objectStore('catches'));
    t.oncomplete = () => res(req ? req.result : undefined);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  });
  return {
    open,
    all: () => run('readonly', (s) => s.getAll()),
    put: (c) => run('readwrite', (s) => s.put(c)),
    del: (id) => run('readwrite', (s) => s.delete(id)),
  };
})();

/* ============ Photo : réduction + métadonnées ============ */
function loadImage(file) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); res(img); };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('image illisible')); };
    img.src = url;
  });
}

async function shrink(file, maxSide = 1600, quality = 0.82) {
  const img = await loadImage(file);
  const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.round(img.naturalWidth * scale);
  const h = Math.round(img.naturalHeight * scale);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d').drawImage(img, 0, 0, w, h);
  return new Promise((res) => c.toBlob((b) => res(b || file), 'image/jpeg', quality));
}

// "2026:10:11 14:05:09" -> "2026-10-11T14:05" (heure locale telle qu'affichée, sans conversion de fuseau)
function exifDateToInput(v) {
  if (!v) return null;
  if (v instanceof Date) return toLocalInput(v.getTime());
  const m = String(v).match(/(\d{4})[:\-](\d{2})[:\-](\d{2})[ T](\d{2}):(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}` : null;
}

async function readMeta(file) {
  const out = { lat: null, lon: null, date: null };
  try {
    const g = await exifr.gps(file);
    if (g && Number.isFinite(g.latitude) && Number.isFinite(g.longitude)) {
      out.lat = g.latitude; out.lon = g.longitude;
    }
  } catch (e) { /* pas de GPS */ }
  try {
    const p = await exifr.parse(file, { exif: true, ifd0: false, gps: false, reviveValues: false });
    out.date = exifDateToInput(p && (p.DateTimeOriginal || p.CreateDate));
  } catch (e) { /* pas de date EXIF */ }
  return out;
}

/* ============ Carte principale ============ */
let map, pinLayer, labelsLayer, userDot;
let catches = [];

function initMap() {
  map = L.map('map', { zoomControl: false, attributionControl: true, worldCopyJump: true })
    .setView([46.6, 2.5], 6);
  L.tileLayer(TILES_SAT, { maxZoom: 19, maxNativeZoom: 18, attribution: ATTR }).addTo(map);
  labelsLayer = L.tileLayer(TILES_LABELS, { maxZoom: 19, maxNativeZoom: 18 });
  L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(map);
  pinLayer = L.layerGroup().addTo(map);

  if (localStorage.getItem('fishlog.labels') === '1') {
    $('#opt-labels').checked = true;
    labelsLayer.addTo(map);
  }
}

function renderPins() {
  pinLayer.clearLayers();
  catches.forEach((c) => {
    const icon = L.divIcon({ className: '', html: '<div class="fish-pin">🐟</div>', iconSize: [36, 36], iconAnchor: [18, 18] });
    L.marker([c.lat, c.lon], { icon, title: c.species })
      .on('click', () => openDetail(c.id))
      .addTo(pinLayer);
  });
  const n = catches.length;
  $('#count').textContent = `${n} prise${n > 1 ? 's' : ''}`;
}

function fitToCatches() {
  if (!catches.length) return false;
  const b = L.latLngBounds(catches.map((c) => [c.lat, c.lon]));
  map.fitBounds(b, { padding: [60, 60], maxZoom: 15 });
  return true;
}

function locateUser(centerMap = true) {
  if (!navigator.geolocation) { toast('Localisation indisponible'); return Promise.resolve(null); }
  return new Promise((res) => {
    navigator.geolocation.getCurrentPosition(
      (p) => {
        const ll = [p.coords.latitude, p.coords.longitude];
        if (userDot) userDot.setLatLng(ll);
        else userDot = L.circleMarker(ll, { radius: 8, color: '#fff', weight: 3, fillColor: '#0a84ff', fillOpacity: 1 }).addTo(map);
        if (centerMap) map.setView(ll, Math.max(map.getZoom(), 15));
        res(ll);
      },
      () => { toast('Position refusée ou introuvable'); res(null); },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 15000 }
    );
  });
}

/* ============ Fenêtres ============ */
function show(id) { $(id).hidden = false; }
function hide(id) { $(id).hidden = true; }

/* ---- Ajout / modification ---- */
let editing = null;       // prise en cours de modification (ou null)
let photoBlob = null;     // photo courante (Blob) ou null
let photoUrl = null;
let pickMap, pickMarker;

function fillSpeciesSelect() {
  const sel = $('#f-species');
  sel.innerHTML = '';
  [...SPECIES, OTHER].forEach((s) => {
    const o = document.createElement('option');
    o.value = s; o.textContent = s;
    sel.appendChild(o);
  });
}

function setPhoto(blob) {
  photoBlob = blob;
  if (photoUrl) { URL.revokeObjectURL(photoUrl); photoUrl = null; }
  const img = $('#photo-preview');
  if (blob) {
    photoUrl = URL.createObjectURL(blob);
    img.src = photoUrl; img.hidden = false;
    $('#photo-placeholder').hidden = true;
  } else {
    img.removeAttribute('src'); img.hidden = true;
    $('#photo-placeholder').hidden = false;
  }
}

function setPos(lat, lon, { pan = true } = {}) {
  $('#f-lat').value = Number(lat).toFixed(6);
  $('#f-lon').value = Number(lon).toFixed(6);
  if (pickMap) {
    pickMarker.setLatLng([lat, lon]);
    if (pan) pickMap.setView([lat, lon], Math.max(pickMap.getZoom(), 16));
  }
}

function ensurePickMap(lat, lon) {
  if (!pickMap) {
    pickMap = L.map('pickmap', { zoomControl: false, attributionControl: false })
      .setView([lat, lon], 16);
    L.tileLayer(TILES_SAT, { maxZoom: 19, maxNativeZoom: 18 }).addTo(pickMap);
    const icon = L.divIcon({ className: '', html: '<div class="fish-pin">🐟</div>', iconSize: [36, 36], iconAnchor: [18, 18] });
    pickMarker = L.marker([lat, lon], { icon, draggable: true }).addTo(pickMap);
    pickMarker.on('dragend', () => { const p = pickMarker.getLatLng(); setPos(p.lat, p.lng, { pan: false }); });
    pickMap.on('click', (e) => setPos(e.latlng.lat, e.latlng.lng, { pan: false }));
  }
  pickMarker.setLatLng([lat, lon]);
  pickMap.setView([lat, lon], 16);
  setTimeout(() => pickMap.invalidateSize(), 60);
}

function openAdd(c = null) {
  editing = c;
  $('#add-title').textContent = c ? 'Modifier la prise' : 'Nouvelle prise';
  $('#photo-status').textContent = '';

  const center = map.getCenter();
  let lat = center.lat, lon = center.lng;

  if (c) {
    $('#f-species').value = SPECIES.includes(c.species) ? c.species : OTHER;
    $('#f-custom').value = SPECIES.includes(c.species) ? '' : c.species;
    $('#f-length').value = String(c.length).replace('.', ',');
    $('#f-date').value = toLocalInput(c.ts);
    lat = c.lat; lon = c.lon;
    setPhoto(c.photo || null);
  } else {
    $('#f-species').value = SPECIES[0];
    $('#f-custom').value = '';
    $('#f-length').value = '';
    $('#f-date').value = toLocalInput(Date.now());
    setPhoto(null);
  }
  $('#custom-wrap').hidden = $('#f-species').value !== OTHER;

  show('#sheet-add');
  $('#f-lat').value = lat.toFixed(6);
  $('#f-lon').value = lon.toFixed(6);
  ensurePickMap(lat, lon);
}

function closeAdd() {
  hide('#sheet-add');
  editing = null;
  setPhoto(null);
}

async function onPhotoChosen(file) {
  if (!file) return;
  $('#photo-status').textContent = 'Lecture de la photo…';
  try {
    setPhoto(await shrink(file));
  } catch (e) {
    $('#photo-status').textContent = 'Impossible de lire cette photo.';
    return;
  }
  const meta = await readMeta(file);

  let dateTxt = '';
  if (meta.date) { $('#f-date').value = meta.date; dateTxt = 'date et heure'; }
  else if (file.lastModified) { $('#f-date').value = toLocalInput(file.lastModified); dateTxt = 'date (approximative)'; }

  if (meta.lat !== null) {
    setPos(meta.lat, meta.lon);
    $('#photo-status').textContent = `Position et ${dateTxt || 'date'} lues dans la photo. Tu peux tout modifier.`;
  } else {
    $('#photo-status').textContent =
      `Pas de position GPS dans cette photo${dateTxt ? ` (${dateTxt} récupérée)` : ''}. ` +
      'Place le repère sur la carte. Astuce : au choix de la photo, touche « Options » et active « Position ».';
  }
}

async function saveCatch() {
  const species = $('#f-species').value === OTHER ? $('#f-custom').value.trim() : $('#f-species').value;
  const length = num($('#f-length').value);
  const lat = num($('#f-lat').value);
  const lon = num($('#f-lon').value);
  const dateStr = $('#f-date').value;
  const ts = dateStr ? new Date(dateStr).getTime() : Date.now();

  if (!species) return toast('Indique l\'espèce');
  if (length === null || length <= 0) return toast('Indique la taille en cm');
  if (lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180) return toast('Position invalide');

  const rec = { species, length, ts, lat, lon, photo: photoBlob || null };
  if (editing) rec.id = editing.id;
  try {
    await DB.put(rec);
  } catch (e) {
    return toast('Échec de l\'enregistrement');
  }
  catches = await DB.all();
  renderPins();
  closeAdd();
  map.setView([lat, lon], Math.max(map.getZoom(), 15));
  toast('Prise enregistrée');
}

/* ---- Fiche ---- */
let detailId = null, detailUrl = null;

function openDetail(id) {
  const c = catches.find((x) => x.id === id);
  if (!c) return;
  detailId = id;
  $('#det-title').textContent = c.species;
  $('#det-length').textContent = fmtLen(c.length);
  $('#det-date').textContent = fmtDate(c.ts);
  $('#det-pos').textContent = `${c.lat.toFixed(5)}, ${c.lon.toFixed(5)}`;
  const img = $('#det-photo');
  if (detailUrl) { URL.revokeObjectURL(detailUrl); detailUrl = null; }
  if (c.photo) { detailUrl = URL.createObjectURL(c.photo); img.src = detailUrl; img.hidden = false; }
  else { img.removeAttribute('src'); img.hidden = true; }
  show('#sheet-detail');
}

function closeDetail() {
  hide('#sheet-detail');
  if (detailUrl) { URL.revokeObjectURL(detailUrl); detailUrl = null; }
  detailId = null;
}

async function deleteDetail() {
  if (detailId === null) return;
  if (!confirm('Supprimer cette prise ?')) return;
  await DB.del(detailId);
  catches = await DB.all();
  renderPins();
  closeDetail();
}

/* ---- Sauvegarde / restauration ---- */
const blobToDataUrl = (b) => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(r.result); r.onerror = () => rej(r.error);
  r.readAsDataURL(b);
});
const dataUrlToBlob = async (u) => (await fetch(u)).blob();

async function exportAll() {
  $('#menu-status').textContent = 'Préparation…';
  try {
    const items = [];
    for (const c of catches) {
      items.push({ species: c.species, length: c.length, ts: c.ts, lat: c.lat, lon: c.lon,
        photo: c.photo ? await blobToDataUrl(c.photo) : null });
    }
    const json = JSON.stringify({ app: 'fishlog', version: 1, exported: Date.now(), catches: items });
    const name = `fishlog-${new Date().toISOString().slice(0, 10)}.json`;
    const file = new File([json], name, { type: 'application/json' });

    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: 'Sauvegarde FishLog' });
    } else {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(file); a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    }
    $('#menu-status').textContent = `${items.length} prise(s) sauvegardée(s).`;
  } catch (e) {
    $('#menu-status').textContent = e && e.name === 'AbortError' ? '' : 'La sauvegarde a échoué.';
  }
}

async function importAll(file) {
  if (!file) return;
  $('#menu-status').textContent = 'Restauration…';
  try {
    const data = JSON.parse(await file.text());
    if (!data || !Array.isArray(data.catches)) throw new Error('format');
    const known = new Set(catches.map((c) => `${c.ts}|${c.lat}|${c.lon}`));
    let added = 0;
    for (const c of data.catches) {
      const key = `${c.ts}|${c.lat}|${c.lon}`;
      if (known.has(key)) continue;
      await DB.put({ species: c.species, length: c.length, ts: c.ts, lat: c.lat, lon: c.lon,
        photo: c.photo ? await dataUrlToBlob(c.photo) : null });
      known.add(key); added++;
    }
    catches = await DB.all();
    renderPins();
    $('#menu-status').textContent = `${added} prise(s) ajoutée(s).`;
  } catch (e) {
    $('#menu-status').textContent = 'Fichier de sauvegarde non reconnu.';
  }
}

/* ============ Démarrage ============ */
async function main() {
  initMap();
  fillSpeciesSelect();

  try { await DB.open(); catches = await DB.all(); }
  catch (e) { toast('Stockage local indisponible'); }
  renderPins();
  if (!fitToCatches()) locateUser(true);

  // Demande un stockage durable (évite que le système efface les données)
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

  // Boutons principaux
  $('#fab').addEventListener('click', () => openAdd());
  $('#btn-locate').addEventListener('click', () => locateUser(true));
  $('#btn-menu').addEventListener('click', () => { $('#menu-status').textContent = ''; show('#sheet-menu'); });

  // Ajout
  $('#add-cancel').addEventListener('click', closeAdd);
  $('#add-save').addEventListener('click', saveCatch);
  $('#photo-input').addEventListener('change', (e) => { onPhotoChosen(e.target.files[0]); e.target.value = ''; });
  $('#f-species').addEventListener('change', (e) => { $('#custom-wrap').hidden = e.target.value !== OTHER; });
  const syncFromInputs = () => {
    const lat = num($('#f-lat').value), lon = num($('#f-lon').value);
    if (lat !== null && lon !== null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
      pickMarker.setLatLng([lat, lon]); pickMap.setView([lat, lon], pickMap.getZoom());
    }
  };
  $('#f-lat').addEventListener('change', syncFromInputs);
  $('#f-lon').addEventListener('change', syncFromInputs);
  $('#btn-here').addEventListener('click', async () => {
    const ll = await locateUser(false);
    if (ll) setPos(ll[0], ll[1]);
  });

  // Fiche
  $('#det-close').addEventListener('click', closeDetail);
  $('#det-delete').addEventListener('click', deleteDetail);
  $('#det-edit').addEventListener('click', () => {
    const c = catches.find((x) => x.id === detailId);
    closeDetail();
    if (c) openAdd(c);
  });

  // Menu
  $('#menu-close').addEventListener('click', () => hide('#sheet-menu'));
  $('#opt-labels').addEventListener('change', (e) => {
    if (e.target.checked) labelsLayer.addTo(map); else map.removeLayer(labelsLayer);
    try { localStorage.setItem('fishlog.labels', e.target.checked ? '1' : '0'); } catch (_) {}
  });
  $('#btn-export').addEventListener('click', exportAll);
  $('#btn-import').addEventListener('click', () => $('#import-input').click());
  $('#import-input').addEventListener('change', (e) => { importAll(e.target.files[0]); e.target.value = ''; });

  // Toucher le fond sombre ferme la fiche et le menu (pas le formulaire, pour ne rien perdre)
  $('#sheet-menu').addEventListener('click', (e) => { if (e.target === $('#sheet-menu')) hide('#sheet-menu'); });
  $('#sheet-detail').addEventListener('click', (e) => { if (e.target === $('#sheet-detail')) closeDetail(); });

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}

main();
