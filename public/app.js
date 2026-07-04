/* RF Coverage Mapper — client-side propagation over open terrain data.
 *
 * Terrain: AWS Terrain Tiles (terrarium encoding), free/open, fetched on demand.
 * Model:   FSPL + 4/3-effective-earth curvature + single knife-edge diffraction
 *          (ITU-R P.526 J(v)), dominant edge picked by max elevation angle from TX.
 * Antenna: gaussian-rolloff azimuth pattern clamped at the front-to-back ratio.
 */

"use strict";

const APP_VERSION = 24;            // bump with the ?v= stamps in index.html

// Served by our Worker, which proxies + edge-caches AWS Terrain Tiles.
const TERRAIN_URL = (z, x, y) => `/terrain/${z}/${x}/${y}.png`;

const N_AZ = 720;                 // azimuth rays (0.5° resolution)
const MAX_STEPS = 900;            // samples per ray
const CANVAS_SIZE = 1024;
const R_EFF = 8494667;            // 4/3 * 6371 km effective earth radius, meters
const D2R = Math.PI / 180;

// Sequential blue ramp, light (weak) -> dark (strong), steps 100..700.
const RAMP = ["#cde2fb", "#b7d3f6", "#9ec5f4", "#86b6ef", "#6da7ec", "#5598e7",
              "#3987e5", "#2a78d6", "#256abf", "#1c5cab", "#184f95", "#104281",
              "#0d366b"];
const OVERLAY_ALPHA = 150;        // 0-255

// ---------------------------------------------------------------- map setup

const map = L.map("map").setView([31.2, -99.2], 6);   // Texas

const streetLayer = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' +
               ' | Terrain: <a href="https://registry.opendata.aws/terrain-tiles/">AWS Terrain Tiles</a>',
}).addTo(map);

const satelliteLayer = L.layerGroup([
  L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
    maxZoom: 19,
    attribution: "Imagery &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics" +
                 ' | Terrain: <a href="https://registry.opendata.aws/terrain-tiles/">AWS Terrain Tiles</a>',
  }),
  L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}", {
    maxZoom: 19,
  }),
]);

// Explanatory overlays: terrain shading, propagation mechanism, repeater scores
const hillshadeLayer = L.tileLayer(
  "https://server.arcgisonline.com/ArcGIS/rest/services/Elevation/World_Hillshade/MapServer/tile/{z}/{y}/{x}",
  { maxZoom: 16, opacity: 0.55, attribution: "Hillshade &copy; Esri" });
const mechLayer = L.layerGroup();       // why: LOS / grazing / diffraction
const repScoreLayer = L.layerGroup();   // full maximin score grid of last search

L.control.layers(
  { "Street": streetLayer, "Satellite": satelliteLayer },
  {
    "Hillshade (terrain)": hillshadeLayer,
    "Path mechanism (why)": mechLayer,
    "Repeater search scores": repScoreLayer,
  },
  { position: "topright" }
).addTo(map);

map.on("overlayadd", e => {
  if (e.layer === mechLayer) $("mechLegend").hidden = false;
});
map.on("overlayremove", e => {
  if (e.layer === mechLayer) $("mechLegend").hidden = true;
});

if (navigator.geolocation) {
  navigator.geolocation.getCurrentPosition(
    p => map.setView([p.coords.latitude, p.coords.longitude], 11),
    () => {});
}

let txLatLng = null;
let txMarker = null;
let beamLayer = L.layerGroup().addTo(map);
let overlay = null;
let lastResult = null;            // polar RSSI grid from the last compute
let computing = false;

const $ = id => document.getElementById(id);
const statusEl = $("status");

// Surface any uncaught error in the UI — a silently dead page that ignores
// every click is far worse than an ugly error message.
window.addEventListener("error", e => {
  if (statusEl) {
    statusEl.textContent = "Script error: " + e.message +
      " — try a hard refresh (Cmd+Shift+R).";
    statusEl.classList.add("error");
  }
});

// --------------------------------------------------------------- parameters

function readParams() {
  return {
    freq: +$("freq").value,
    txPower: +$("txPower").value,
    txGain: +$("txGain").value,
    txHeight: +$("txHeight").value,
    omni: $("omni").checked,
    bearing: +$("bearing").value,
    beamwidth: +$("beamwidth").value,
    f2b: +$("f2b").value,
    rxSens: +$("rxSens").value,
    rxGain: +$("rxGain").value,
    rxHeight: +$("rxHeight").value,
    margin: +$("margin").value,
    envDb: $("env").value === "auto" ? 12 : +$("env").value,
    envAuto: $("env").value === "auto",
    model: $("pathModel").value,
    radiusM: +$("radius").value * 1000,
  };
}

/* Environment clutter loss for one antenna end: full value in the weeds,
 * fading linearly to zero as the antenna rises above the ~20 m clutter
 * layer (ITU-R P.2108-flavored). In "Auto" mode the base value comes from
 * NLCD land cover at that end's actual location (US only); the manual
 * environment setting is the fallback everywhere else. */
const LC_Z = 12;                      // ~38 m/px — matches NLCD's 30 m data
const lcCache = new Map();            // "x/y" -> Uint8Array(65536) clutter dB (255 = unknown)

const NLCD_CLUTTER = [                // [r, g, b, clutter dB]
  [170, 0, 0, 20],      // developed, high intensity
  [237, 0, 0, 16],      // developed, medium
  [216, 147, 130, 12],  // developed, low
  [221, 201, 201, 8],   // developed, open space
  [28, 99, 48, 15],     // evergreen forest
  [104, 171, 95, 15],   // deciduous forest
  [181, 197, 143, 15],  // mixed forest
  [186, 216, 234, 12],  // woody wetlands
  [204, 186, 124, 6],   // shrub/scrub
  [219, 216, 61, 3],    // pasture/hay
  [171, 108, 40, 3],    // cultivated crops
  [223, 223, 194, 3],   // grassland
  [108, 159, 184, 2],   // herbaceous wetlands
  [178, 173, 163, 0],   // barren
  [71, 107, 161, 0],    // open water
  [249, 249, 249, 0],   // perennial ice/snow
];

function decodeLcBitmap(bmp) {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  const d = ctx.getImageData(0, 0, 256, 256).data;
  const out = new Uint8Array(256 * 256).fill(255);
  for (let i = 0; i < 256 * 256; i++) {
    const r = d[i * 4], g = d[i * 4 + 1], b = d[i * 4 + 2];
    let best = 255, bestDist = 900;   // must be reasonably close to a class color
    for (const [cr, cg, cb, db] of NLCD_CLUTTER) {
      const dist = (r - cr) ** 2 + (g - cg) ** 2 + (b - cb) ** 2;
      if (dist < bestDist) { bestDist = dist; best = db; }
    }
    out[i] = best;
  }
  return out;
}

function loadLcTile(x, y) {
  const key = `${x}/${y}`;
  if (lcCache.has(key)) {
    const v = lcCache.get(key);
    return v instanceof Promise ? v : Promise.resolve(v);
  }
  const promise = (async () => {
    try {
      const r = await fetch(`/landcover/${LC_Z}/${x}/${y}.png`);
      if (!r.ok) throw new Error();
      const t = decodeLcBitmap(await createImageBitmap(await r.blob()));
      lcCache.set(key, t);
      return t;
    } catch {
      const t = new Uint8Array(256 * 256).fill(255);   // unknown -> fallback env
      lcCache.set(key, t);
      return t;
    }
  })();
  lcCache.set(key, promise);
  return promise;
}

async function prefetchLandcover(lat, lon, radiusM) {
  const size = 256 * 2 ** LC_Z;
  const dLat = radiusM / 111320;
  const dLon = radiusM / (111320 * Math.cos(lat * D2R));
  const toTile = (la, lo) => {
    const sn = Math.sin(la * D2R);
    return [Math.floor(((lo + 180) / 360) * size / 256),
            Math.floor((0.5 - Math.log((1 + sn) / (1 - sn)) / (4 * Math.PI)) * size / 256)];
  };
  const [x0, y0] = toTile(lat + dLat, lon - dLon);
  const [x1, y1] = toTile(lat - dLat, lon + dLon);
  const jobs = [];
  for (let x = x0; x <= x1 + 1; x++)
    for (let y = y0; y <= y1 + 1; y++) jobs.push(loadLcTile(x, y));
  await Promise.all(jobs);
}

function clutterDbAt(lat, lon) {
  const size = 256 * 2 ** LC_Z;
  const sn = Math.sin(lat * D2R);
  const px = Math.round(((lon + 180) / 360) * size - 0.5);
  const py = Math.round((0.5 - Math.log((1 + sn) / (1 - sn)) / (4 * Math.PI)) * size - 0.5);
  const t = lcCache.get(`${px >> 8}/${py >> 8}`);
  if (!(t instanceof Uint8Array)) return null;
  const v = t[(py & 255) * 256 + (px & 255)];
  return v === 255 ? null : v;
}

function clutterEndAt(p, heightAgl, lat, lon) {
  let base = p.envDb;
  if (p.envAuto && lat !== undefined) {
    const db = clutterDbAt(lat, lon);
    if (db !== null) base = db;
  }
  return base * Math.max(0, 1 - heightAgl / 20);
}
function clutterPair(p, aH, bH, aLat, aLon, bLat, bLon) {
  return clutterEndAt(p, aH, aLat, aLon) + clutterEndAt(p, bH, bLat, bLon);
}

function txGainToward(azDeg, p) {
  if (p.omni) return p.txGain;
  const off = Math.abs(((azDeg - p.bearing) % 360 + 540) % 360 - 180);
  return p.txGain - Math.min(12 * (off / p.beamwidth) ** 2, p.f2b);
}

function updateBudget() {
  const p = readParams();
  const eirp = p.txPower + p.txGain;
  const eirpW = Math.pow(10, (eirp - 30) / 10);
  // FSPL-only range (no terrain): the absolute best case.
  const maxLoss = eirp + p.rxGain - p.margin
              - clutterEndAt(p, p.txHeight) - clutterEndAt(p, p.rxHeight) - p.rxSens;
  const fsKm = Math.pow(10, (maxLoss - 32.44 - 20 * Math.log10(p.freq)) / 20);
  $("budget").innerHTML =
    `EIRP: <b>${eirp.toFixed(1)} dBm</b> (${eirpW.toFixed(1)} W) on boresight<br>` +
    `Allowed path loss: <b>${maxLoss.toFixed(0)} dB</b><br>` +
    `Free-space limit: <b>${fsKm > 999 ? ">999" : fsKm.toFixed(0)} km</b> (terrain will reduce this)`;
  $("txWatts").textContent = "= " + Math.pow(10, (p.txPower - 30) / 10).toFixed(2) + " W";
}

// ------------------------------------------------------------- terrain tiles

const tileCache = new Map();      // "z/x/y" -> Float32Array(256*256) | Promise
let failedTileKeys = [];          // fetch failures this run (retried next run)

function decodeTileBitmap(bmp) {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  const d = ctx.getImageData(0, 0, 256, 256).data;
  const e = new Float32Array(256 * 256);
  for (let i = 0; i < 256 * 256; i++) {
    e[i] = d[i * 4] * 256 + d[i * 4 + 1] + d[i * 4 + 2] / 256 - 32768;
  }
  return e;
}

function loadTile(z, x, y) {
  const key = `${z}/${x}/${y}`;
  if (tileCache.has(key)) {
    const v = tileCache.get(key);
    return v instanceof Promise ? v : Promise.resolve(v);
  }
  const promise = (async () => {
    let noData = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await fetch(TERRAIN_URL(z, x, y));
        if (r.status === 404) { noData = true; break; }   // open ocean etc.
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const e = decodeTileBitmap(await createImageBitmap(await r.blob()));
        tileCache.set(key, e);
        return e;
      } catch {
        await new Promise(s => setTimeout(s, 250 * (attempt + 1)));
      }
    }
    // Sea level as a last resort — but a genuine failure is flagged so the
    // user is warned and the tile is retried on the next compute, instead of
    // silently flattening hills for the whole session.
    const zeros = new Float32Array(256 * 256);
    tileCache.set(key, zeros);
    if (!noData) failedTileKeys.push(key);
    return zeros;
  })();
  tileCache.set(key, promise);
  return promise;
}

// Pick a zoom that keeps resolution high but the tile count sane.
// z13 gives ~15 m terrain in the US (3DEP) for small radii.
function pickZoom(lat, radiusM) {
  for (let z = 13; z >= 7; z--) {
    const mpp = 156543.034 * Math.cos(lat * D2R) / 2 ** z;
    const n = Math.ceil((2 * radiusM) / (mpp * 256)) + 2;
    if (n * n <= 180) return z;
  }
  return 7;
}

// Elevation sampler bound to one zoom level; bilinear across cached tiles.
function makeSampler(z) {
  const size = 256 * 2 ** z;
  function pixel(x, y) {
    x = Math.min(Math.max(x, 0), size - 1);
    y = Math.min(Math.max(y, 0), size - 1);
    const t = tileCache.get(`${z}/${x >> 8}/${y >> 8}`);
    return (t instanceof Float32Array) ? t[(y & 255) * 256 + (x & 255)] : 0;
  }
  return function elevAt(lat, lon) {
    const s = Math.sin(lat * D2R);
    const px = ((lon + 180) / 360) * size - 0.5;
    const py = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * size - 0.5;
    const x0 = Math.floor(px), y0 = Math.floor(py);
    const fx = px - x0, fy = py - y0;
    const a = pixel(x0, y0), b = pixel(x0 + 1, y0);
    const c = pixel(x0, y0 + 1), d = pixel(x0 + 1, y0 + 1);
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
  };
}

async function prefetchTiles(lat, lon, radiusM, z, onProgress) {
  const size = 256 * 2 ** z;
  const dLat = radiusM / 111320;
  const dLon = radiusM / (111320 * Math.cos(lat * D2R));
  const toTile = (la, lo) => {
    const s = Math.sin(la * D2R);
    return [
      Math.floor(((lo + 180) / 360) * size / 256),
      Math.floor((0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * size / 256),
    ];
  };
  const [x0, y0] = toTile(lat + dLat, lon - dLon);
  const [x1, y1] = toTile(lat - dLat, lon + dLon);
  const jobs = [];
  for (let x = x0 - 1; x <= x1 + 1; x++)
    for (let y = y0 - 1; y <= y1 + 1; y++)
      jobs.push(loadTile(z, x, y));
  let done = 0;
  await Promise.all(jobs.map(j => j.then(() => onProgress(++done, jobs.length))));
}

// ------------------------------------------------------- propagation engine

function knifeEdgeLoss(v) {
  if (v <= -0.78) return 0;
  return 6.9 + 20 * Math.log10(Math.sqrt((v - 0.1) ** 2 + 1) + v - 0.1);
}

/* Walk one ray outward from the TX. Returns RSSI (dBm) per step.
 * Curvature is handled by dropping terrain relative to the TX tangent plane
 * (g' = g - d²/2Re), then treating geometry as flat.
 *
 * Diffraction is two-edge Deygout: the dominant edge (max elevation angle
 * from TX) plus the strongest secondary edge on the far side of it, judged
 * from the dominant edge's summit. One knife edge alone badly underestimates
 * loss over successive ridgelines. */
function traceRay(azDeg, p, ctx, out, mechOut) {
  const { lat0, lon0, cosLat0, stepLen, nStep, elevAt, lambda, hTx } = ctx;
  const sinA = Math.sin(azDeg * D2R), cosA = Math.cos(azDeg * D2R);
  const gTx = txGainToward(azDeg, p);
  const rxClutFixed = p.envAuto ? 0 : clutterEndAt(p, p.rxHeight);
  const fixed = p.txPower + gTx + p.rxGain - p.margin
              - clutterEndAt(p, p.txHeight, lat0, lon0) - rxClutFixed
              - 32.44 - 20 * Math.log10(p.freq);
  let a1 = -Infinity, d1 = 0, e1 = 0;    // main edge: angle from TX, dist, height
  let a2 = -Infinity, d2 = 0;            // secondary edge beyond it, from e1's top

  for (let i = 1; i <= nStep; i++) {
    const d = i * stepLen;
    const lat = lat0 + (d * cosA) / 111320;
    const lon = lon0 + (d * sinA) / (111320 * cosLat0);
    const gEff = Math.max(elevAt(lat, lon), 0) - (d * d) / (2 * R_EFF);
    const rxTop = gEff + p.rxHeight;
    const beta = (rxTop - hTx) / d;

    let ld = 0, ld2 = 0;
    if (d1 > 0 && d - d1 > 1) {
      const h1 = (a1 - beta) * d1;
      const v1 = h1 * Math.sqrt((2 * d) / (lambda * d1 * (d - d1)));
      ld = knifeEdgeLoss(v1);
      if (ld > 0 && d2 > d1 && d - d2 > 1) {
        const D2 = d - d1;                             // sub-path edge1 -> RX
        const beta2 = (rxTop - e1) / D2;
        const h2 = (a2 - beta2) * (d2 - d1);
        const v2 = h2 * Math.sqrt((2 * D2) / (lambda * (d2 - d1) * (d - d2)));
        ld2 = knifeEdgeLoss(v2);
        ld += ld2;
      }
      ld = Math.min(ld, 60);
    }
    const fspl = 20 * Math.log10(Math.max(d / 1000, 0.005));
    const rxClut = p.envAuto ? clutterEndAt(p, p.rxHeight, lat, lon) : 0;
    out[i - 1] = fixed - fspl - ld - rxClut;
    if (mechOut) {
      // 0 = clear LOS, 1 = Fresnel graze (<6 dB), 2 = one edge, 3 = two edges
      mechOut[i - 1] = ld === 0 ? 0 : (ld2 > 0 ? 3 : (ld < 6 ? 1 : 2));
    }

    const alpha = (gEff - hTx) / d;                    // terrain top, no RX mast
    if (alpha > a1) {
      a1 = alpha; d1 = d; e1 = gEff;
      a2 = -Infinity; d2 = 0;            // secondary edge resets with a new main
    } else if (d1 > 0 && d - d1 > 1) {
      const alpha2 = (gEff - e1) / (d - d1);
      if (alpha2 > a2) { a2 = alpha2; d2 = d; }
    }
  }
}

async function computeCoverage() {
  if (!txLatLng) return;
  await runCoverage(txLatLng.lat, txLatLng.lng, readParams(), "");
}

/* Full radial coverage from any origin — the main TX, a site, or a repeater
 * candidate. `label` is empty for the main TX, else e.g. "R3" or "Site 2". */
async function runCoverage(lat0, lon0, p, label) {
  if (computing) return;
  computing = true;
  $("updateBtn").disabled = true;
  statusEl.classList.remove("error");

  try {
    const z = pickZoom(lat0, p.radiusM);
    const mpp = 156543.034 * Math.cos(lat0 * D2R) / 2 ** z;

    statusEl.textContent = "Fetching terrain…";
    failedTileKeys = [];
    const lcJob = p.envAuto ? prefetchLandcover(lat0, lon0, p.radiusM) : null;
    await prefetchTiles(lat0, lon0, p.radiusM, z,
      (d, n) => { statusEl.textContent = `Fetching terrain… ${d}/${n} tiles`; });
    if (lcJob) await lcJob;

    const elevAt = makeSampler(z);
    const stepLen = Math.max(mpp, p.radiusM / MAX_STEPS);
    const nStep = Math.round(p.radiusM / stepLen);
    const ctx = {
      lat0, lon0, cosLat0: Math.cos(lat0 * D2R), stepLen, nStep, elevAt,
      lambda: 299.792458 / p.freq,               // meters (freq in MHz)
      hTx: Math.max(elevAt(lat0, lon0), 0) + p.txHeight,
    };

    const grid = new Float32Array(N_AZ * nStep);
    const mechGrid = new Uint8Array(N_AZ * nStep);
    for (let a = 0; a < N_AZ; a++) {
      traceRay(a * 360 / N_AZ, p, ctx, grid.subarray(a * nStep, (a + 1) * nStep),
               mechGrid.subarray(a * nStep, (a + 1) * nStep));
      if (a % 60 === 59) {
        statusEl.textContent = `Computing… ${Math.round(a / N_AZ * 100)}%`;
        await new Promise(r => setTimeout(r));
      }
    }

    lastResult = { grid, mechGrid, nStep, stepLen, lat0, lon0,
                   cosLat0: ctx.cosLat0, params: p, zoom: z, elevAt, ctx };
    if (!label) {
      $("placeHint").textContent =
        `TX at ${lat0.toFixed(5)}, ${lon0.toFixed(5)} — ` +
        `${(ctx.hTx - p.txHeight).toFixed(0)} m ASL ground + ${p.txHeight} m mast`;
    }
    renderOverlay(lastResult);
    renderMechOverlay(lastResult);
    drawBeam(p);
    buildLegend(p.rxSens);
    if (failedTileKeys.length) {
      for (const k of failedTileKeys) tileCache.delete(k);   // retry next run
      statusEl.textContent = `⚠ ${failedTileKeys.length} terrain tiles failed to ` +
        `load — those areas were treated as flat. Recompute to retry.`;
      statusEl.classList.add("error");
    } else {
      statusEl.textContent = `Done — ${(stepLen).toFixed(0)} m terrain resolution` +
        (label ? ` — showing coverage from ${label}.` : ".");
    }
  } catch (err) {
    statusEl.textContent = "Error: " + err.message;
    statusEl.classList.add("error");
  } finally {
    computing = false;
    $("updateBtn").disabled = !txLatLng;
  }
}

// ----------------------------------------------------------------- rendering

function colorBands(rxSens) {
  const levels = [];
  for (let l = -60; l > rxSens; l -= 10) levels.push(l);
  levels.push(rxSens);
  // levels[i] .. levels[i+1] is band i; band 0 additionally covers >= -60.
  const n = levels.length - 1;
  const colors = [];
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 1 : 1 - i / (n - 1);          // strongest -> darkest
    colors.push(RAMP[Math.round(t * (RAMP.length - 1))]);
  }
  return { levels, colors };
}

function hexToRgb(h) {
  return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16),
          parseInt(h.slice(5, 7), 16)];
}

function renderOverlay(res) {
  const { grid, nStep, stepLen, lat0, lon0, cosLat0, params: p } = res;
  const radiusM = p.radiusM;
  const { levels, colors } = colorBands(p.rxSens);
  const rgb = colors.map(hexToRgb);

  const dLat = radiusM / 111320;
  const dLon = radiusM / (111320 * cosLat0);
  const north = lat0 + dLat, south = lat0 - dLat;
  const west = lon0 - dLon, east = lon0 + dLon;

  const W = CANVAS_SIZE, H = CANVAS_SIZE;
  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const img = canvas.getContext("2d").createImageData(W, H);
  const px = img.data;

  // Leaflet stretches an ImageOverlay linearly in mercator Y, so rows must
  // be spaced in mercator, not latitude.
  const mercY = lat => Math.log(Math.tan(Math.PI / 4 + lat * D2R / 2));
  const myN = mercY(north), myS = mercY(south);

  for (let j = 0; j < H; j++) {
    const lat = (2 * Math.atan(Math.exp(myN + (myS - myN) * j / (H - 1)))
                 - Math.PI / 2) / D2R;
    const dy = (lat - lat0) * 111320;
    for (let i = 0; i < W; i++) {
      const lon = west + (east - west) * i / (W - 1);
      const dx = (lon - lon0) * 111320 * cosLat0;
      const dist = Math.hypot(dx, dy);
      if (dist > radiusM) continue;

      // bilinear sample of the polar grid (azimuth wraps)
      const az = (Math.atan2(dx, dy) / D2R + 360) % 360;
      const fa = az / 360 * N_AZ;
      const a0 = Math.floor(fa) % N_AZ, a1 = (a0 + 1) % N_AZ, wa = fa - Math.floor(fa);
      const fd = Math.max(dist / stepLen - 1, 0);
      const s0 = Math.min(Math.floor(fd), nStep - 1);
      const s1 = Math.min(s0 + 1, nStep - 1);
      const wd = fd - Math.floor(fd);
      const rssi =
        (grid[a0 * nStep + s0] * (1 - wd) + grid[a0 * nStep + s1] * wd) * (1 - wa) +
        (grid[a1 * nStep + s0] * (1 - wd) + grid[a1 * nStep + s1] * wd) * wa;

      if (rssi < p.rxSens) continue;
      let band = levels.length - 2;
      for (let b = 0; b < levels.length - 1; b++) {
        if (rssi >= levels[b + 1]) { band = b; break; }
      }
      const k = (j * W + i) * 4;
      px[k] = rgb[band][0]; px[k + 1] = rgb[band][1]; px[k + 2] = rgb[band][2];
      px[k + 3] = OVERLAY_ALPHA;
    }
  }
  canvas.getContext("2d").putImageData(img, 0, 0);

  const bounds = [[south, west], [north, east]];
  if (overlay) map.removeLayer(overlay);
  overlay = L.imageOverlay(canvas.toDataURL(), bounds, { interactive: false })
             .addTo(map);
  $("legendBlock").hidden = false;
  map.fitBounds(bounds, { padding: [20, 20] });
}

/* "Why" layer: recolor the computed area by propagation mechanism, so the
 * shape of the coverage is explainable at a glance. */
const MECH_COLORS = ["#1baf7a", "#eda100", "#eb6834", "#4a3aa7"];

function renderMechOverlay(res) {
  mechLayer.clearLayers();
  if (!res.mechGrid) return;
  const { mechGrid, nStep, stepLen, lat0, lon0, cosLat0, params: p } = res;
  const radiusM = p.radiusM;
  const rgb = MECH_COLORS.map(hexToRgb);
  const dLat = radiusM / 111320;
  const dLon = radiusM / (111320 * cosLat0);
  const north = lat0 + dLat, south = lat0 - dLat;
  const west = lon0 - dLon, east = lon0 + dLon;
  const W = 768, H = 768;
  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const img = canvas.getContext("2d").createImageData(W, H);
  const px = img.data;
  const mercY = lat => Math.log(Math.tan(Math.PI / 4 + lat * D2R / 2));
  const myN = mercY(north), myS = mercY(south);
  for (let j = 0; j < H; j++) {
    const lat = (2 * Math.atan(Math.exp(myN + (myS - myN) * j / (H - 1)))
                 - Math.PI / 2) / D2R;
    const dy = (lat - lat0) * 111320;
    for (let i = 0; i < W; i++) {
      const lon = west + (east - west) * i / (W - 1);
      const dx = (lon - lon0) * 111320 * cosLat0;
      const dist = Math.hypot(dx, dy);
      if (dist > radiusM) continue;
      const az = (Math.atan2(dx, dy) / D2R + 360) % 360;
      const a0 = Math.round(az / 360 * N_AZ) % N_AZ;
      const s0 = Math.min(Math.max(Math.round(dist / stepLen) - 1, 0), nStep - 1);
      const m = mechGrid[a0 * nStep + s0];
      const k = (j * W + i) * 4;
      px[k] = rgb[m][0]; px[k + 1] = rgb[m][1]; px[k + 2] = rgb[m][2];
      px[k + 3] = 120;
    }
  }
  canvas.getContext("2d").putImageData(img, 0, 0);
  L.imageOverlay(canvas.toDataURL(), [[south, west], [north, east]],
                 { interactive: false }).addTo(mechLayer);
}

function buildLegend(rxSens) {
  const { levels, colors } = colorBands(rxSens);
  const el = $("legend");
  el.innerHTML = "";
  for (let i = 0; i < colors.length; i++) {
    const row = document.createElement("div");
    row.className = "legend-row";
    const label = i === 0
      ? `≥ ${levels[0]}`
      : `${levels[i]} to ${levels[i + 1]}`;
    row.innerHTML = `<span class="legend-swatch" style="background:${colors[i]}"></span>${label}`;
    el.appendChild(row);
  }
}

function drawBeam(p) {
  beamLayer.clearLayers();
  if (!txLatLng || p.omni) return;
  const len = p.radiusM * 0.5;
  const mk = brg => {
    const lat = txLatLng.lat + (len * Math.cos(brg * D2R)) / 111320;
    const lon = txLatLng.lng + (len * Math.sin(brg * D2R)) /
                (111320 * Math.cos(txLatLng.lat * D2R));
    return [lat, lon];
  };
  const style = { color: "#0d366b", weight: 2, opacity: 0.8, dashArray: "6 4" };
  L.polyline([txLatLng, mk(p.bearing)], { ...style, dashArray: null, weight: 3 })
    .addTo(beamLayer);
  L.polyline([txLatLng, mk(p.bearing - p.beamwidth / 2)], style).addTo(beamLayer);
  L.polyline([txLatLng, mk(p.bearing + p.beamwidth / 2)], style).addTo(beamLayer);
}

// ----------------------------------------------------- point-to-point paths

/* Trace one path A -> B (antenna heights AGL) with the same physics as
 * traceRay: 4/3-earth drop relative to A's tangent plane, two-edge Deygout
 * diffraction. Returns total propagation loss plus profile geometry.
 * Gains are the caller's business: rssi = txPower + gA + gB - margin - loss. */
function tracePath(aLat, aLon, aH, bLat, bLon, bH, env, wantSamples) {
  const { elevAt, stepLen, lambda } = env;
  const cosLat = Math.cos(aLat * D2R);
  const dy = (bLat - aLat) * 111320;
  const dx = (bLon - aLon) * 111320 * cosLat;
  const distM = Math.max(Math.hypot(dx, dy), 1);
  const n = Math.max(Math.floor(distM / stepLen), 8);
  const step = distM / n;

  const gA = Math.max(elevAt(aLat, aLon), 0);
  const gB = Math.max(elevAt(bLat, bLon), 0);
  const hTx = gA + aH;
  const gEffB = gB - (distM * distM) / (2 * R_EFF);
  const rxTop = gEffB + bH;
  const beta = (rxTop - hTx) / distM;

  const samples = wantSamples ? [{ d: 0, g: gA, gEff: gA }] : null;
  let a1 = -Infinity, d1 = 0, e1 = 0, rawE1 = 0;
  let a2 = -Infinity, d2 = 0;

  for (let i = 1; i < n; i++) {
    const d = i * step, f = d / distM;
    const lat = aLat + (bLat - aLat) * f;
    const lon = aLon + (bLon - aLon) * f;
    const g = Math.max(elevAt(lat, lon), 0);
    const gEff = g - (d * d) / (2 * R_EFF);
    if (samples) samples.push({ d, g, gEff });
    const alpha = (gEff - hTx) / d;
    if (alpha > a1) {
      a1 = alpha; d1 = d; e1 = gEff; rawE1 = g;
      a2 = -Infinity; d2 = 0;
    } else if (d1 > 0 && d - d1 > 1) {
      const alpha2 = (gEff - e1) / (d - d1);
      if (alpha2 > a2) { a2 = alpha2; d2 = d; }
    }
  }
  if (samples) samples.push({ d: distM, g: gB, gEff: gEffB });

  let diff = 0, edgeH = -Infinity;
  if (d1 > 0 && distM - d1 > 1) {
    edgeH = (a1 - beta) * d1;
    const v1 = edgeH * Math.sqrt((2 * distM) / (lambda * d1 * (distM - d1)));
    diff = knifeEdgeLoss(v1);
    if (diff > 0 && d2 > d1 && distM - d2 > 1) {
      const D2 = distM - d1;
      const beta2 = (rxTop - e1) / D2;
      const h2 = (a2 - beta2) * (d2 - d1);
      const v2 = h2 * Math.sqrt((2 * D2) / (lambda * (d2 - d1) * (distM - d2)));
      diff += knifeEdgeLoss(v2);
    }
    diff = Math.min(diff, 60);
  }
  const fspl = 32.44 + 20 * Math.log10(Math.max(distM / 1000, 0.005))
             + 20 * Math.log10(env.freq);
  const res = { distM, fspl, diff, loss: fspl + diff, samples, lambda,
                gA, gB, hTx, rxTop, gEffB,
                edgeD: d1, edgeElev: rawE1, edgeH, pmodel: "Deygout two-edge" };

  // Profile-based models need the sampled profile; fall back to Deygout on error
  if (samples && samples.length >= 9) {
    const pfl = [samples.length - 1, step];
    for (const q of samples) pfl.push(q.g);
    if (env.model === "itm" && typeof itmPointToPoint === "function") {
      try {
        const r = itmPointToPoint(Math.max(aH, 0.5), Math.max(bH, 0.5), pfl,
                                  { fMhz: env.freq });
        res.loss = r.A_db;
        res.fspl = r.Afs;
        res.diff = Math.max(r.A_db - r.Afs, 0);
        res.pmodel = `ITM Longley-Rice (${r.mode})`;
      } catch { /* keep Deygout numbers */ }
    } else if (env.model === "p1812" && typeof deltaBullingtonLoss === "function") {
      try {
        const excess = deltaBullingtonLoss(Math.max(aH, 0.5), Math.max(bH, 0.5),
                                           pfl, env.freq);
        res.diff = excess;
        res.loss = res.fspl + excess;
        res.pmodel = "Delta-Bullington (P.1812-style)";
      } catch { /* keep Deygout numbers */ }
    }
  }
  return res;
}

// ------------------------------------------------------------------ inspect

function losText(res) {
  return res.edgeH > 0
    ? `Terrain blocks LOS ${(res.edgeD / 1000).toFixed(1)} km out ` +
      `(${res.edgeElev.toFixed(0)} m ridge, +${res.edgeH.toFixed(0)} m over the ray)`
    : `Terrain line-of-sight: clear`;
}

function verdictHtml(margin) {
  return margin >= 0
    ? `<span class="popup-good">✓ Usable — ${margin.toFixed(0)} dB margin</span>`
    : `<span class="popup-bad">✗ Below sensitivity by ${(-margin).toFixed(0)} dB</span>`;
}

function inspectPoint(latlng) {
  const last = lastResult;
  if (!last) return;
  const p = last.params;
  const dy = (latlng.lat - last.lat0) * 111320;
  const dx = (latlng.lng - last.lon0) * 111320 * last.cosLat0;
  const dist = Math.hypot(dx, dy);
  if (dist > p.radiusM || dist < last.stepLen) return;
  const az = (Math.atan2(dx, dy) / D2R + 360) % 360;

  const env = { elevAt: last.ctx.elevAt, stepLen: last.stepLen,
                lambda: last.ctx.lambda, freq: p.freq, model: p.model };
  const res = tracePath(last.lat0, last.lon0, p.txHeight,
                        latlng.lat, latlng.lng, p.rxHeight, env, true);
  const gTx = txGainToward(az, p);
  const rssi = p.txPower + gTx + p.rxGain - p.margin
             - clutterPair(p, p.txHeight, p.rxHeight,
                           last.lat0, last.lon0, latlng.lat, latlng.lng) - res.loss;
  const margin = rssi - p.rxSens;

  L.popup().setLatLng(latlng).setContent(
    `<b>${(dist / 1000).toFixed(2)} km</b> at ${az.toFixed(0)}°<br>` +
    `Ground: ${res.gA.toFixed(0)} m → ${res.gB.toFixed(0)} m ASL<br>` +
    `${losText(res)}<br>` +
    `TX gain this bearing: ${gTx.toFixed(1)} dBi<br>` +
    `Free-space loss: ${res.fspl.toFixed(1)} dB<br>` +
    `Terrain/path excess: ${res.diff.toFixed(1)} dB (${res.pmodel})<br>` +
    `Predicted RX: <b>${rssi.toFixed(1)} dBm</b><br>${verdictHtml(margin)}`
  ).openOn(map);
  showProfile(res,
    `Elevation profile — ${(dist / 1000).toFixed(2)} km at ${az.toFixed(0)}° ` +
    `(4/3-earth curvature applied)`, "TX", "RX");
}

// -------------------------------------------------- elevation profile chart

let profState = null;             // scales + samples for hover lookup/redraw

function niceStep(raw) {
  const pow = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 5, 10]) if (m * pow >= raw) return m * pow;
  return 10 * pow;
}

function showProfile(res, title, labelA, labelB) {
  if ($("profile").hidden) {
    $("profile").hidden = false;
    map.invalidateSize();
  }
  $("profileTitle").textContent = title;

  const distM = res.distM, lambda = res.lambda;
  const svg = $("profileSvg");
  const rect = svg.getBoundingClientRect();
  const W = Math.max(rect.width, 320), H = Math.max(rect.height, 120);
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  const padL = 50, padR = 14, padT = 10, padB = 20;

  const losA = res.hTx;                          // A antenna, m ASL
  const losB = res.rxTop;                        // B antenna, curvature frame
  const losAt = d => losA + (losB - losA) * d / distM;
  const s = res.samples;

  let yMin = Infinity, yMax = -Infinity;
  for (const q of s) { yMin = Math.min(yMin, q.gEff); yMax = Math.max(yMax, q.gEff); }
  yMax = Math.max(yMax, losA, losB) + Math.sqrt(lambda * distM) / 2;
  const span = Math.max(yMax - yMin, 20);
  yMin -= span * 0.06; yMax += span * 0.04;
  const X = d => padL + (W - padL - padR) * (d / distM);
  const Y = e => padT + (H - padT - padB) * (1 - (e - yMin) / (yMax - yMin));

  let el = "";

  // gridlines + axis labels
  const yStep = niceStep((yMax - yMin) / 4);
  for (let e = Math.ceil(yMin / yStep) * yStep; e < yMax; e += yStep) {
    el += `<line class="prof-grid" x1="${padL}" y1="${Y(e).toFixed(1)}" x2="${W - padR}" y2="${Y(e).toFixed(1)}"/>` +
          `<text class="prof-label" x="${padL - 5}" y="${(Y(e) + 3).toFixed(1)}" text-anchor="end">${e} m</text>`;
  }
  const xStepM = niceStep(distM / 6);
  for (let d = xStepM; d < distM; d += xStepM) {
    el += `<text class="prof-label" x="${X(d).toFixed(1)}" y="${H - 6}" text-anchor="middle">${(d / 1000)} km</text>`;
  }

  // terrain (curvature-adjusted)
  let terr = `M${X(0).toFixed(1)},${Y(s[0].gEff).toFixed(1)}`;
  for (const q of s) terr += ` L${X(q.d).toFixed(1)},${Y(q.gEff).toFixed(1)}`;
  terr += ` L${(W - padR).toFixed(1)},${H - padB} L${padL},${H - padB} Z`;
  el += `<path class="prof-terrain" d="${terr}"/>`;

  // first Fresnel zone around the LOS ray
  const up = [], dn = [];
  for (const q of s) {
    const r = Math.sqrt(Math.max(lambda * q.d * (distM - q.d) / distM, 0));
    up.push(`${X(q.d).toFixed(1)},${Y(losAt(q.d) + r).toFixed(1)}`);
    dn.push(`${X(q.d).toFixed(1)},${Y(losAt(q.d) - r).toFixed(1)}`);
  }
  el += `<path class="prof-fresnel" d="M${up.join(" L")} L${dn.reverse().join(" L")} Z"/>`;

  // LOS ray + masts
  el += `<line class="prof-los" x1="${X(0)}" y1="${Y(losA).toFixed(1)}" x2="${X(distM).toFixed(1)}" y2="${Y(losB).toFixed(1)}"/>`;
  el += `<line class="prof-mast" x1="${X(0)}" y1="${Y(s[0].gEff).toFixed(1)}" x2="${X(0)}" y2="${Y(losA).toFixed(1)}"/>`;
  el += `<line class="prof-mast" x1="${X(distM).toFixed(1)}" y1="${Y(res.gEffB).toFixed(1)}" x2="${X(distM).toFixed(1)}" y2="${Y(losB).toFixed(1)}"/>`;
  el += `<text class="prof-label" x="${padL + 3}" y="${(Y(losA) - 5).toFixed(1)}">${labelA}</text>`;
  el += `<text class="prof-label" x="${(X(distM) - 3).toFixed(1)}" y="${(Y(losB) - 5).toFixed(1)}" text-anchor="end">${labelB}</text>`;

  // dominant obstruction marker
  if (res.edgeH > 0 && res.edgeD > 0) {
    const eY = Y(res.edgeElev - (res.edgeD ** 2) / (2 * R_EFF));
    el += `<circle class="prof-edge" cx="${X(res.edgeD).toFixed(1)}" cy="${eY.toFixed(1)}" r="4"/>`;
  }

  el += `<line id="profCursor" class="prof-cursor" y1="${padT}" y2="${H - padB}" x1="-10" x2="-10"/>`;
  svg.innerHTML = el;
  profState = { res, title, labelA, labelB, samples: s, losAt, X, padL, padR, W, distM };
}

$("profileClose").addEventListener("click", () => {
  $("profile").hidden = true;
  profState = null;
  map.invalidateSize();
});

$("profileSvg").addEventListener("mousemove", ev => {
  if (!profState) return;
  const { samples, losAt, X, padL, padR, W, distM } = profState;
  const box = $("profileSvg").getBoundingClientRect();
  const mx = (ev.clientX - box.left) * (W / box.width);
  const d = Math.min(Math.max((mx - padL) / (W - padL - padR), 0), 1) * distM;
  let q = samples[0];
  for (const c of samples) if (Math.abs(c.d - d) < Math.abs(q.d - d)) q = c;
  const clr = losAt(q.d) - q.gEff;
  const cursor = document.getElementById("profCursor");
  if (cursor) { cursor.setAttribute("x1", X(q.d)); cursor.setAttribute("x2", X(q.d)); }
  const tip = $("profileTip");
  tip.hidden = false;
  tip.textContent = `${(q.d / 1000).toFixed(2)} km · ground ${q.g.toFixed(0)} m ASL · ` +
    (clr >= 0 ? `${clr.toFixed(0)} m below LOS ray` : `${(-clr).toFixed(0)} m ABOVE LOS ray`);
  tip.style.left = Math.min(ev.clientX - box.left + 14, box.width - 230) + "px";
  tip.style.top = "34px";
});

$("profileSvg").addEventListener("mouseleave", () => {
  $("profileTip").hidden = true;
  const cursor = document.getElementById("profCursor");
  if (cursor) { cursor.setAttribute("x1", -10); cursor.setAttribute("x2", -10); }
});

window.addEventListener("resize", () => {
  if (profState && !$("profile").hidden) {
    showProfile(profState.res, profState.title, profState.labelA, profState.labelB);
  }
});

// ---------------------------------------------------------------- UI wiring

function setTx(latlng) {
  txLatLng = latlng;
  if (!txMarker) {
    txMarker = L.marker(latlng, { draggable: true }).addTo(map)
      .bindTooltip("Transmitter", { permanent: false });
    txMarker.on("dragend", () => { txLatLng = txMarker.getLatLng(); scheduleCompute(); });
  } else {
    txMarker.setLatLng(latlng);
  }
  $("placeHint").textContent =
    `TX at ${latlng.lat.toFixed(5)}, ${latlng.lng.toFixed(5)} (drag marker to move)`;
  $("updateBtn").disabled = false;
  scheduleCompute();
}

map.on("click", e => {
  if (Date.now() - lastLinkClick < 300) return;    // click landed on a link line
  if (proposing) { beginPotentialForm(e.latlng); return; }
  if (mode === "community") return;                // pins only in community tab
  if (mode === "network") { addSite(e.latlng); return; }
  if (!txLatLng) setTx(e.latlng);
  else if (lastResult) inspectPoint(e.latlng);
  else setTx(e.latlng);
});

// ------------------------------------------------- multi-site P2P + repeaters

let mode = "coverage";
let sites = [];                   // {id, latlng, height, gain, marker}
let siteSeq = 0;
let lastLinkClick = 0;
let networkEnv = null;            // {elevAt, stepLen, lambda, freq, zoom}
const linkLayer = L.layerGroup().addTo(map);
const repeaterLayer = L.layerGroup().addTo(map);

const TABS = ["coverage", "network", "community", "settings"];
function setTab(name) {
  for (const t of TABS) {
    $("tab-" + t).hidden = t !== name;
    $("tabBtn-" + t).classList.toggle("active", t === name);
  }
  mode = name === "network" ? "network"
       : name === "community" ? "community" : "coverage";
  if (name === "network" && sites.length >= 2) scheduleLinks();
  if (name === "community" && !potentialSites.length) {
    loadPotentialSites().then(n => {
      if (n) statusEl.textContent = `${n} community potential sites loaded.`;
    }).catch(() => {});
  }
}
TABS.forEach(t => $("tabBtn-" + t).addEventListener("click", () => setTab(t)));

function siteIcon(n) {
  return L.divIcon({ className: "site-icon", html: String(n),
                     iconSize: [24, 24], iconAnchor: [12, 12] });
}

function addSite(latlng, height, gain) {
  if (sites.length >= 12) { statusEl.textContent = "Max 12 sites."; return; }
  const site = { id: ++siteSeq, latlng, height: height ?? 10, gain: gain ?? 2.2 };
  site.marker = L.marker(latlng, { draggable: true, icon: siteIcon(sites.length + 1) })
    .addTo(map);
  site.marker.on("dragend", () => {
    site.latlng = site.marker.getLatLng();
    renderSiteList();
    scheduleLinks();
  });
  site.marker.bindPopup(() => {
    const n = sites.indexOf(site) + 1;
    return `<b>Site ${n}</b> — ${site.height} m mast, ${site.gain} dBi<br>` +
      `${site.latlng.lat.toFixed(5)}, ${site.latlng.lng.toFixed(5)}<br>` +
      `<button onclick="window.__siteCov(${site.id})">Show coverage</button>`;
  });
  sites.push(site);
  renderSiteList();
  scheduleLinks();
}

function removeSite(id) {
  const i = sites.findIndex(s => s.id === id);
  if (i < 0) return;
  map.removeLayer(sites[i].marker);
  sites.splice(i, 1);
  sites.forEach((s, j) => s.marker.setIcon(siteIcon(j + 1)));
  renderSiteList();
  scheduleLinks();
}

function renderSiteList() {
  const el = $("siteList");
  el.innerHTML = "";
  if (!sites.length) return;
  const head = document.createElement("div");
  head.className = "site-head";
  head.innerHTML = "<span></span><span>location</span><span>h (m)</span><span>dBi</span><span></span>";
  el.appendChild(head);
  sites.forEach((s, i) => {
    const row = document.createElement("div");
    row.className = "site-row";
    row.innerHTML =
      `<span class="site-num">${i + 1}</span>` +
      `<span>${s.latlng.lat.toFixed(4)}, ${s.latlng.lng.toFixed(4)}</span>` +
      `<input type="number" value="${s.height}" min="1" max="500" step="1" data-f="height">` +
      `<input type="number" value="${s.gain}" min="-5" max="30" step="0.1" data-f="gain">` +
      `<button class="site-del" title="Remove">×</button>`;
    row.querySelectorAll("input").forEach(inp => {
      inp.addEventListener("input", () => {
        s[inp.dataset.f] = +inp.value;
        scheduleLinks();
      });
    });
    row.querySelector(".site-del").addEventListener("click", () => removeSite(s.id));
    el.appendChild(row);
  });
}

let linkTimer = null;
function scheduleLinks() {
  clearTimeout(linkTimer);
  linkTimer = setTimeout(evaluateLinks, 500);
}

function networkBounds(padFrac) {
  let latMin = Infinity, latMax = -Infinity, lonMin = Infinity, lonMax = -Infinity;
  for (const s of sites) {
    latMin = Math.min(latMin, s.latlng.lat); latMax = Math.max(latMax, s.latlng.lat);
    lonMin = Math.min(lonMin, s.latlng.lng); lonMax = Math.max(lonMax, s.latlng.lng);
  }
  const padLat = Math.max((latMax - latMin) * padFrac, 0.02);
  const padLon = Math.max((lonMax - lonMin) * padFrac, 0.02);
  return { latMin: latMin - padLat, latMax: latMax + padLat,
           lonMin: lonMin - padLon, lonMax: lonMax + padLon };
}

async function ensureNetworkEnv() {
  const p = readParams();
  const b = networkBounds(0.3);
  const cLat = (b.latMin + b.latMax) / 2, cLon = (b.lonMin + b.lonMax) / 2;
  const halfDiag = Math.hypot(
    (b.latMax - cLat) * 111320,
    (b.lonMax - cLon) * 111320 * Math.cos(cLat * D2R)) * 1.05;
  const z = pickZoom(cLat, halfDiag);
  statusEl.textContent = "Fetching terrain…";
  failedTileKeys = [];
  const lcJob = p.envAuto ? prefetchLandcover(cLat, cLon, halfDiag) : null;
  await prefetchTiles(cLat, cLon, halfDiag, z,
    (d, n) => { statusEl.textContent = `Fetching terrain… ${d}/${n} tiles`; });
  if (lcJob) await lcJob;
  const mpp = 156543.034 * Math.cos(cLat * D2R) / 2 ** z;
  let maxDist = 1000;
  for (let i = 0; i < sites.length; i++)
    for (let j = i + 1; j < sites.length; j++)
      maxDist = Math.max(maxDist, siteDist(sites[i], sites[j]));
  networkEnv = { elevAt: makeSampler(z), stepLen: Math.max(mpp, maxDist / 900),
                 lambda: 299.792458 / p.freq, freq: p.freq, model: p.model,
                 zoom: z, bounds: b };
  return networkEnv;
}

function siteDist(a, b) {
  const cos = Math.cos(a.latlng.lat * D2R);
  return Math.hypot((b.latlng.lat - a.latlng.lat) * 111320,
                    (b.latlng.lng - a.latlng.lng) * 111320 * cos);
}

function linkColor(margin) {
  return margin >= 10 ? "#0ca30c" : margin >= 0 ? "#fab219" : "#d03b3b";
}

async function evaluateLinks() {
  linkLayer.clearLayers();
  if (mode !== "network" || sites.length < 2) {
    if (mode === "network") statusEl.textContent =
      sites.length ? "Add a second site to evaluate links." : "";
    return;
  }
  try {
    const p = readParams();
    const env = await ensureNetworkEnv();
    let good = 0, total = 0;
    for (let i = 0; i < sites.length; i++) {
      for (let j = i + 1; j < sites.length; j++) {
        const A = sites[i], B = sites[j];
        const res = tracePath(A.latlng.lat, A.latlng.lng, A.height,
                              B.latlng.lat, B.latlng.lng, B.height, env,
                              env.model !== "deygout");
        const rssi = p.txPower + A.gain + B.gain - p.margin
                     - clutterPair(p, A.height, B.height, A.latlng.lat, A.latlng.lng,
                                   B.latlng.lat, B.latlng.lng) - res.loss;
        const margin = rssi - p.rxSens;
        total++; if (margin >= 0) good++;
        const line = L.polyline([A.latlng, B.latlng], {
          color: linkColor(margin), weight: 4, opacity: 0.85,
        }).addTo(linkLayer);
        line.on("click", ev => {
          lastLinkClick = Date.now();
          L.DomEvent.stopPropagation(ev);
          openLinkDetails(A, B, i + 1, j + 1, env, p, ev.latlng);
        });
      }
    }
    statusEl.classList.remove("error");
    statusEl.textContent =
      `${total} links evaluated — ${good} usable, ${total - good} failing. ` +
      `Click a link for its profile.`;
  } catch (err) {
    statusEl.textContent = "Error: " + err.message;
    statusEl.classList.add("error");
  }
}

function openLinkDetails(A, B, nA, nB, env, p, at) {
  const res = tracePath(A.latlng.lat, A.latlng.lng, A.height,
                        B.latlng.lat, B.latlng.lng, B.height, env, true);
  const rssi = p.txPower + A.gain + B.gain - p.margin
                     - clutterPair(p, A.height, B.height, A.latlng.lat, A.latlng.lng,
                                   B.latlng.lat, B.latlng.lng) - res.loss;
  const margin = rssi - p.rxSens;
  L.popup().setLatLng(at).setContent(
    `<b>Site ${nA} ↔ Site ${nB}</b> — ${(res.distM / 1000).toFixed(2)} km<br>` +
    `Ground: ${res.gA.toFixed(0)} m → ${res.gB.toFixed(0)} m ASL<br>` +
    `${losText(res)}<br>` +
    `Free-space loss: ${res.fspl.toFixed(1)} dB · ` +
    `Path excess: ${res.diff.toFixed(1)} dB (${res.pmodel})<br>` +
    `Predicted RX: <b>${rssi.toFixed(1)} dBm</b><br>${verdictHtml(margin)}`
  ).openOn(map);
  showProfile(res,
    `Site ${nA} ↔ Site ${nB} — ${(res.distM / 1000).toFixed(2)} km ` +
    `(4/3-earth curvature applied)`, `S${nA}`, `S${nB}`);
}

// ---- repeater placement: grid-search the terrain for the spot whose WORST
// ---- link to any site is best (maximin), then refine the top candidates.

function repeaterScore(lat, lon, h, g, env, p) {
  let worst = Infinity;
  for (const s of sites) {
    const res = tracePath(lat, lon, h, s.latlng.lat, s.latlng.lng, s.height,
                          env, env.model !== "deygout");
    const margin = p.txPower + g + s.gain - p.margin
                   - clutterPair(p, h, s.height, lat, lon,
                                 s.latlng.lat, s.latlng.lng) - res.loss - p.rxSens;
    worst = Math.min(worst, margin);
    if (worst < -60) break;                        // hopeless — stop early
  }
  return worst;
}

async function suggestRepeaters() {
  if (sites.length < 2) {
    statusEl.textContent = "Add at least 2 sites first.";
    return;
  }
  repeaterLayer.clearLayers();
  const p = readParams();
  const h = +$("repHeight").value, g = +$("repGain").value;
  const env = await ensureNetworkEnv();
  const b = env.bounds;
  const N = 42;                                    // 42x42 candidate grid
  const coarse = { ...env, stepLen: env.stepLen * 2.5, model: "deygout" };
  const cands = [];

  for (let iy = 0; iy < N; iy++) {
    const lat = b.latMin + (b.latMax - b.latMin) * (iy + 0.5) / N;
    for (let ix = 0; ix < N; ix++) {
      const lon = b.lonMin + (b.lonMax - b.lonMin) * (ix + 0.5) / N;
      const tooClose = sites.some(s => siteDist(s,
        { latlng: { lat, lng: lon } }) < 300);
      if (tooClose) continue;
      cands.push({ lat, lon });
    }
    if (iy % 6 === 5) {
      statusEl.textContent = `Searching repeater sites… ${Math.round(iy / N * 50)}%`;
      await new Promise(r => setTimeout(r));
    }
  }
  for (let k = 0; k < cands.length; k++) {
    cands[k].score = repeaterScore(cands[k].lat, cands[k].lon, h, g, coarse, p);
    if (k % 150 === 149) {
      statusEl.textContent =
        `Searching repeater sites… ${50 + Math.round(k / cands.length * 40)}%`;
      await new Promise(r => setTimeout(r));
    }
  }
  renderRepScoreLayer(cands, b);
  cands.sort((a, c) => c.score - a.score);

  // pick top 15 with decent separation, refined at full resolution
  const minSep = Math.max(500,
    Math.hypot((b.latMax - b.latMin) * 111320,
               (b.lonMax - b.lonMin) * 111320 * Math.cos(b.latMin * D2R)) / 30);
  const picks = [];
  for (const c of cands) {
    if (picks.length >= 15) break;
    if (picks.some(q => Math.hypot((q.lat - c.lat) * 111320,
        (q.lon - c.lon) * 111320 * Math.cos(c.lat * D2R)) < minSep)) continue;
    c.score = repeaterScore(c.lat, c.lon, h, g, env, p);
    picks.push(c);
  }
  picks.sort((a, c) => c.score - a.score);

  picks.forEach((c, i) => {
    const perSite = sites.map((s, j) => {
      const res = tracePath(c.lat, c.lon, h, s.latlng.lat, s.latlng.lng,
                            s.height, env, env.model !== "deygout");
      const m = p.txPower + g + s.gain - p.margin
                - clutterPair(p, h, s.height, c.lat, c.lon,
                              s.latlng.lat, s.latlng.lng) - res.loss - p.rxSens;
      return `Site ${j + 1}: ${m >= 0 ? "+" : ""}${m.toFixed(0)} dB`;
    }).join("<br>");
    const elev = Math.max(env.elevAt(c.lat, c.lon), 0);
    L.marker([c.lat, c.lon], {
      icon: L.divIcon({ className: "rep-icon", html: `R${i + 1}`,
                        iconSize: [24, 24], iconAnchor: [12, 12] }),
    }).addTo(repeaterLayer).bindPopup(
      `<b>Repeater candidate R${i + 1}</b> — ${elev.toFixed(0)} m ASL<br>` +
      `Worst-link margin: <b>${c.score >= 0 ? "+" : ""}${c.score.toFixed(0)} dB</b><br>` +
      `${perSite}<br>` +
      `<button onclick="window.__showCov(${c.lat},${c.lon},${h},${g},'R${i + 1}')">` +
      `Show coverage</button>` +
      `<button onclick="window.__addRep(${c.lat},${c.lon},${h},${g})">` +
      `Add as site</button>`);
  });

  const best = picks[0];
  statusEl.textContent = best
    ? (best.score >= 0
        ? `Best repeater spot reaches every site with ${best.score.toFixed(0)} dB to spare (R1).`
        : `No single spot reaches all sites — best candidate (R1) is ` +
          `${(-best.score).toFixed(0)} dB short on its worst link. Try more height.`)
    : "No candidates found.";
}

window.__addRep = (lat, lon, h, g) => {
  map.closePopup();
  repeaterLayer.clearLayers();
  addSite(L.latLng(lat, lon), h, g);
};

// "Show coverage" from any node: same engine as the main TX, omni pattern,
// that node's height and antenna gain, panel radius/receiver settings.
window.__showCov = (lat, lon, h, g, label) => {
  map.closePopup();
  const p = { ...readParams(), txHeight: h, txGain: g, omni: true };
  runCoverage(lat, lon, p, label).catch(err => {
    statusEl.textContent = "Error: " + err.message;
    statusEl.classList.add("error");
  });
};

window.__siteCov = id => {
  const i = sites.findIndex(s => s.id === id);
  if (i < 0) return;
  const s = sites[i];
  window.__showCov(s.latlng.lat, s.latlng.lng, s.height, s.gain, `Site ${i + 1}`);
};

/* Metrics layer for the repeater search: the full scored grid, so the
 * chosen R sites are explainable — dark blue = strong worst-link margin,
 * light blue = weak but viable, faded red = no single-repeater solution. */
function renderRepScoreLayer(cands, b) {
  repScoreLayer.clearLayers();
  if (!cands.length) return;
  let maxScore = -Infinity;
  for (const c of cands) maxScore = Math.max(maxScore, c.score);
  const N = 42;
  const cell = 12, W = N * cell, H = N * cell;
  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const cx = canvas.getContext("2d");
  for (const c of cands) {
    const ix = Math.round((c.lon - (b.lonMin + (b.lonMax - b.lonMin) * 0.5 / N))
               / ((b.lonMax - b.lonMin) / N));
    const iy = Math.round((c.lat - (b.latMin + (b.latMax - b.latMin) * 0.5 / N))
               / ((b.latMax - b.latMin) / N));
    if (ix < 0 || ix >= N || iy < 0 || iy >= N) continue;
    if (c.score >= 0 && maxScore > 0) {
      const t = Math.min(c.score / maxScore, 1);
      cx.fillStyle = RAMP[Math.round(t * (RAMP.length - 1))];
      cx.globalAlpha = 0.55;
    } else {
      cx.fillStyle = "#e34948";
      cx.globalAlpha = Math.min(0.35, Math.max(0.08, 0.35 + c.score / 200));
    }
    // canvas y grows downward; grid iy grows northward
    cx.fillRect(ix * cell, (N - 1 - iy) * cell, cell, cell);
  }
  cx.globalAlpha = 1;
  L.imageOverlay(canvas.toDataURL(),
    [[b.latMin, b.lonMin], [b.latMax, b.lonMax]],
    { interactive: false }).addTo(repScoreLayer);
  if (!map.hasLayer(repScoreLayer)) repScoreLayer.addTo(map);
}

$("repeaterBtn").addEventListener("click", () => {
  suggestRepeaters().catch(err => {
    statusEl.textContent = "Error: " + err.message;
    statusEl.classList.add("error");
  });
});

$("clearSitesBtn").addEventListener("click", () => {
  for (const s of sites) map.removeLayer(s.marker);
  sites = [];
  linkLayer.clearLayers();
  repeaterLayer.clearLayers();
  renderSiteList();
});

// ------------------------------------------------- existing mesh (live data)

let meshNodes = [];
const meshLayer = L.layerGroup();

const escapeHtml = s => String(s).replace(/[&<>"']/g,
  c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Freshness filter: node heard within the selected window (0 = all time).
function nodeFresh(n) {
  const days = +$("meshAge").value;
  if (!days) return true;
  const t = Date.parse(n.last_seen || n.last_heard || 0);
  return isFinite(t) && (Date.now() - t) <= days * 86400e3;
}

function renderMeshLayer() {
  meshLayer.clearLayers();
  let shown = 0, reps = 0;
  meshNodes.forEach((n, i) => {
    if (!nodeFresh(n)) return;
    shown++;
    if (n.role === "repeater") reps++;
    const color = n.role === "repeater" ? "#2a78d6"
                : n.role === "room" ? "#4a3aa7" : "#898781";
    L.circleMarker([n.lat, n.lon], {
      radius: 5, color: "#fff", weight: 1.5,
      fillColor: color, fillOpacity: n.relay_active ? 0.95 : 0.4,
    }).bindPopup(() =>
      `<b>${escapeHtml(n.name)}</b> (${n.role})<br>` +
      `${n.lat.toFixed(5)}, ${n.lon.toFixed(5)}<br>` +
      `last seen ${String(n.last_seen).slice(0, 10)} · ` +
      `relay ${n.relay_active ? "active" : "idle"}<br>` +
      `<button onclick="window.__meshCov(${i})">Show coverage</button>` +
      `<button onclick="window.__meshAdd(${i})">Add as site</button>`
    ).addTo(meshLayer);
  });
  return { shown, reps };
}

async function loadMeshNodes() {
  statusEl.textContent = "Loading mesh nodes…";
  const r = await fetch("/api/mesh-nodes");
  if (!r.ok) throw new Error("mesh source unavailable");
  const js = await r.json();
  meshNodes = js.nodes.filter(n => n.lat && n.lon);
  const { shown, reps } = renderMeshLayer();
  meshLayer.addTo(map);
  statusEl.textContent =
    `${shown} of ${meshNodes.length} mesh nodes shown (${reps} repeaters, ` +
    `seen within the selected window). Heights come from the repeater height input.`;
}

$("meshAge").addEventListener("change", () => {
  if (!meshNodes.length) return;
  const { shown, reps } = renderMeshLayer();
  statusEl.textContent =
    `${shown} of ${meshNodes.length} mesh nodes shown (${reps} repeaters).`;
});

window.__meshCov = i => {
  const n = meshNodes[i];
  if (!n) return;
  window.__showCov(n.lat, n.lon, +$("repHeight").value, +$("repGain").value, n.name);
};
window.__meshAdd = i => {
  const n = meshNodes[i];
  if (!n) return;
  map.closePopup();
  addSite(L.latLng(n.lat, n.lon), +$("repHeight").value, +$("repGain").value);
};

$("loadMeshBtn").addEventListener("click", () => {
  if (map.hasLayer(meshLayer) && meshNodes.length) {
    map.removeLayer(meshLayer);
    $("loadMeshBtn").textContent = "Load nodes";
    return;
  }
  loadMeshNodes()
    .then(() => { $("loadMeshBtn").textContent = "Hide nodes"; })
    .catch(err => {
      statusEl.textContent = "Error: " + err.message;
      statusEl.classList.add("error");
    });
});

/* Combined footprint of the mesh repeaters currently in view: per-pixel MAX
 * of every node's predicted signal. Transparent = no node reaches it. */
async function meshCoverageInView() {
  if (!meshNodes.length) await loadMeshNodes();
  const view = map.getBounds();
  let nodes = meshNodes.filter(n => n.role === "repeater" &&
    nodeFresh(n) && view.contains([n.lat, n.lon]));
  if (!nodes.length) {
    statusEl.textContent = "No mesh repeaters in the current view within the " +
      "freshness window — zoom/pan or widen the filter.";
    return;
  }
  nodes.sort((a, c) => (c.relay_active - a.relay_active) ||
    (new Date(c.last_seen) - new Date(a.last_seen)));
  const dropped = Math.max(nodes.length - 25, 0);
  nodes = nodes.slice(0, 25);

  const p = readParams();
  const h = +$("repHeight").value, g = +$("repGain").value;
  const radius = p.radiusM;

  // shared terrain env over all nodes + radius
  let latMin = Infinity, latMax = -Infinity, lonMin = Infinity, lonMax = -Infinity;
  for (const n of nodes) {
    latMin = Math.min(latMin, n.lat); latMax = Math.max(latMax, n.lat);
    lonMin = Math.min(lonMin, n.lon); lonMax = Math.max(lonMax, n.lon);
  }
  const cLat = (latMin + latMax) / 2, cLon = (lonMin + lonMax) / 2;
  const cosC = Math.cos(cLat * D2R);
  const dLat = radius / 111320, dLon = radius / (111320 * cosC);
  latMin -= dLat; latMax += dLat; lonMin -= dLon; lonMax += dLon;
  const halfDiag = Math.hypot((latMax - cLat) * 111320,
                              (lonMax - cLon) * 111320 * cosC);
  const z = pickZoom(cLat, halfDiag);
  statusEl.textContent = "Fetching terrain…";
  failedTileKeys = [];
  const lcJob = p.envAuto ? prefetchLandcover(cLat, cLon, halfDiag) : null;
  await prefetchTiles(cLat, cLon, halfDiag, z,
    (d, n) => { statusEl.textContent = `Fetching terrain… ${d}/${n} tiles`; });
  if (lcJob) await lcJob;
  const elevAt = makeSampler(z);
  const mpp = 156543.034 * cosC / 2 ** z;
  const stepLen = Math.max(mpp, radius / MAX_STEPS);
  const nStep = Math.round(radius / stepLen);
  const lambda = 299.792458 / p.freq;

  // shared canvas buffer, mercator-correct rows
  const W = 1200, H = 1200;
  const buf = new Float32Array(W * H).fill(-999);
  const mercY = lat => Math.log(Math.tan(Math.PI / 4 + lat * D2R / 2));
  const myN = mercY(latMax), myS = mercY(latMin);
  const rowLat = new Float32Array(H);
  for (let j = 0; j < H; j++) {
    rowLat[j] = (2 * Math.atan(Math.exp(myN + (myS - myN) * j / (H - 1)))
                 - Math.PI / 2) / D2R;
  }
  const colLon = i => lonMin + (lonMax - lonMin) * i / (W - 1);
  const lonToCol = lon => (lon - lonMin) / (lonMax - lonMin) * (W - 1);
  // mercator is monotonic, binary-search rows for a latitude
  const latToRow = lat => {
    const my = mercY(lat);
    return (my - myN) / (myS - myN) * (H - 1);
  };

  const pn = { ...p, omni: true, txGain: g, txHeight: h };
  const grid = new Float32Array(N_AZ * nStep);
  for (let k = 0; k < nodes.length; k++) {
    const n = nodes[k];
    statusEl.textContent = `Computing mesh coverage… node ${k + 1}/${nodes.length}`;
    await new Promise(r => setTimeout(r));
    const cosN = Math.cos(n.lat * D2R);
    const ctxN = { lat0: n.lat, lon0: n.lon, cosLat0: cosN, stepLen, nStep,
                   elevAt, lambda,
                   hTx: Math.max(elevAt(n.lat, n.lon), 0) + h };
    for (let a = 0; a < N_AZ; a++) {
      traceRay(a * 360 / N_AZ, pn, ctxN, grid.subarray(a * nStep, (a + 1) * nStep));
    }
    // splat this node's polar grid into the shared buffer (max blend)
    const j0 = Math.max(Math.floor(latToRow(n.lat + radius / 111320)), 0);
    const j1 = Math.min(Math.ceil(latToRow(n.lat - radius / 111320)), H - 1);
    const i0 = Math.max(Math.floor(lonToCol(n.lon - radius / (111320 * cosN))), 0);
    const i1 = Math.min(Math.ceil(lonToCol(n.lon + radius / (111320 * cosN))), W - 1);
    for (let j = j0; j <= j1; j++) {
      const dy = (rowLat[j] - n.lat) * 111320;
      for (let i = i0; i <= i1; i++) {
        const dx = (colLon(i) - n.lon) * 111320 * cosN;
        const dist = Math.hypot(dx, dy);
        if (dist > radius) continue;
        const az = (Math.atan2(dx, dy) / D2R + 360) % 360;
        const fa = az / 360 * N_AZ;
        const a0 = Math.floor(fa) % N_AZ, a1 = (a0 + 1) % N_AZ, wa = fa - Math.floor(fa);
        const fd = Math.max(dist / stepLen - 1, 0);
        const s0 = Math.min(Math.floor(fd), nStep - 1);
        const s1 = Math.min(s0 + 1, nStep - 1);
        const wd = fd - Math.floor(fd);
        const rssi =
          (grid[a0 * nStep + s0] * (1 - wd) + grid[a0 * nStep + s1] * wd) * (1 - wa) +
          (grid[a1 * nStep + s0] * (1 - wd) + grid[a1 * nStep + s1] * wd) * wa;
        const idx = j * W + i;
        if (rssi > buf[idx]) buf[idx] = rssi;
      }
    }
  }

  // colorize
  const { levels, colors } = colorBands(p.rxSens);
  const rgb = colors.map(hexToRgb);
  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const img = canvas.getContext("2d").createImageData(W, H);
  const px = img.data;
  for (let idx = 0; idx < W * H; idx++) {
    const rssi = buf[idx];
    if (rssi < p.rxSens) continue;
    let band = levels.length - 2;
    for (let b = 0; b < levels.length - 1; b++) {
      if (rssi >= levels[b + 1]) { band = b; break; }
    }
    px[idx * 4] = rgb[band][0]; px[idx * 4 + 1] = rgb[band][1];
    px[idx * 4 + 2] = rgb[band][2]; px[idx * 4 + 3] = OVERLAY_ALPHA;
  }
  canvas.getContext("2d").putImageData(img, 0, 0);
  if (overlay) map.removeLayer(overlay);
  overlay = L.imageOverlay(canvas.toDataURL(),
    [[latMin, lonMin], [latMax, lonMax]], { interactive: false }).addTo(map);
  $("legendBlock").hidden = false;
  buildLegend(p.rxSens);
  statusEl.textContent =
    `Combined coverage of ${nodes.length} repeaters` +
    (dropped ? ` (${dropped} more in view, capped at 25)` : "") +
    ` at ${h} m / ${g} dBi assumed. Transparent holes = placement gaps.`;
}

$("meshCovBtn").addEventListener("click", () => {
  meshCoverageInView().catch(err => {
    statusEl.textContent = "Error: " + err.message;
    statusEl.classList.add("error");
  });
});

// ------------------------------------ community potential sites (D1-backed)

let potentialSites = [];
let proposing = false;
let pendingPot = null;            // {latlng, marker} while the form is open
let editingSiteId = null;         // set when the form is editing an existing site
const potentialLayer = L.layerGroup();
const potLinkLayer = L.layerGroup().addTo(map);

const potIcon = (status = "idea") => L.divIcon({
  className: `pot-icon pot-${status}`, html: "P",
  iconSize: [24, 24], iconAnchor: [12, 12] });

async function loadPotentialSites() {
  const r = await fetch("/api/potential-sites");
  if (!r.ok) throw new Error("could not load potential sites");
  potentialSites = (await r.json()).sites;
  potentialLayer.clearLayers();
  potentialSites.forEach((ps, i) => {
    L.marker([ps.lat, ps.lon], { icon: potIcon(ps.status), title: ps.name })
      .on("click", () => { setTab("community"); openPotDetail(i); })
      .addTo(potentialLayer);
  });
  if (!map.hasLayer(potentialLayer)) potentialLayer.addTo(map);
  return potentialSites.length;
}

function openModal(which) {
  $("modalBack").hidden = false;
  $("potForm").hidden = which !== "form";
  $("potDetail").hidden = which !== "detail";
}
function closeModal() { $("modalBack").hidden = true; }
$("modalBack").addEventListener("click", e => {
  if (e.target === $("modalBack")) closeModal();
});
document.addEventListener("keydown", e => {
  if (e.key === "Escape" && !$("modalBack").hidden) closeModal();
});
$("potFormClose").addEventListener("click", closeModal);

function potMsg(text, isError) {
  const el = $("potMsg");
  el.textContent = text;
  el.style.color = isError ? "var(--bad)" : "";
}

$("potShowBtn").addEventListener("click", () => {
  loadPotentialSites().then(n => {
    statusEl.textContent = `${n} community potential sites loaded.`;
  }).catch(err => {
    statusEl.textContent = "Error: " + err.message;
    statusEl.classList.add("error");
  });
});

// ---- propose flow: click the map OR geocode a street address

$("potProposeBtn").addEventListener("click", () => {
  editingSiteId = null;
  $("potFormTitle").textContent = "New potential site";
  $("potSaveBtn").textContent = "Save potential site";
  potMsg("Set the location: type an address and press Find, or pick the spot on the map.");
  openModal("form");
});

$("potPickBtn").addEventListener("click", () => {
  if (editingSiteId !== null) { potMsg("Location is fixed while editing.", true); return; }
  proposing = true;
  closeModal();
  statusEl.classList.remove("error");
  statusEl.textContent = "Click the map where the site is — the editor will reopen.";
});

$("potAddress").addEventListener("keydown", e => {
  if (e.key === "Enter") { e.preventDefault(); $("potAddrFind").click(); }
});

async function reverseGeocode(lat, lon) {
  try {
    const r = await fetch("https://nominatim.openstreetmap.org/reverse?format=json" +
                          `&lat=${lat}&lon=${lon}`);
    const js = await r.json();
    return js.display_name || "";
  } catch { return ""; }
}

function beginPotentialForm(latlng) {
  if (pendingPot && pendingPot.marker) map.removeLayer(pendingPot.marker);
  pendingPot = { latlng,
    marker: L.marker(latlng, { icon: potIcon(), opacity: 0.6 }).addTo(map) };
  proposing = false;
  $("potLoc").textContent = `${latlng.lat.toFixed(5)}, ${latlng.lng.toFixed(5)}`;
  openModal("form");
  potMsg("Location set. Fill in what you know — only the name is required.");
  if (!$("potAddress").value.trim()) {
    reverseGeocode(latlng.lat, latlng.lng).then(addr => {
      if (addr && !$("potAddress").value.trim()) $("potAddress").value = addr;
    });
  }
}

$("potAddrFind").addEventListener("click", async () => {
  const q = $("potAddress").value.trim();
  if (!q) { potMsg("Type an address first.", true); return; }
  if (editingSiteId !== null) { potMsg("Location is fixed while editing.", true); return; }
  try {
    potMsg("Looking up address…");
    const hit = await geocode(q);
    const ll = L.latLng(+hit.lat, +hit.lon);
    map.setView(ll, Math.max(map.getZoom(), 16));
    beginPotentialForm(ll);
    potMsg(`Pin dropped at: ${hit.display_name.slice(0, 90)}`);
  } catch (err) {
    potMsg(err.message + " — or use Pick on map.", true);
  }
});

function cancelPotentialForm() {
  if (pendingPot && pendingPot.marker) map.removeLayer(pendingPot.marker);
  pendingPot = null;
  proposing = false;
  editingSiteId = null;
  $("potLoc").textContent = "not set";
  $("potSaveBtn").textContent = "Save potential site";
  closeModal();
}
$("potCancelBtn").addEventListener("click", cancelPotentialForm);

$("potSaveBtn").addEventListener("click", async () => {
  if (!pendingPot) {
    potMsg("Set the location first — Find an address or Pick on map.", true);
    return;
  }
  const name = $("potName").value.trim();
  if (!name) { potMsg("Give the site a name.", true); return; }
  try {
    const fields = {
      name,
      company: $("potCompany").value.trim(),
      address: $("potAddress").value.trim(),
      contact: $("potContact").value.trim(),
      notes: $("potNotes").value.trim(),
      height_m: +$("potHeight").value,
      power: $("potPower").value,
      access: $("potAccess").value,
    };
    let r;
    if (editingSiteId !== null) {
      r = await fetch(`/api/potential-sites/${editingSiteId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...fields, author: $("potBy").value.trim() }),
      });
    } else {
      r = await fetch("/api/potential-sites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...fields,
          lat: pendingPot.latlng.lat,
          lon: pendingPot.latlng.lng,
          status: $("potStatus").value,
          submitted_by: $("potBy").value.trim(),
        }),
      });
    }
    if (!r.ok) throw new Error((await r.json()).error || `HTTP ${r.status}`);
    const wasEdit = editingSiteId !== null, editedId = editingSiteId;
    cancelPotentialForm();
    for (const id of ["potName", "potCompany", "potAddress", "potContact", "potNotes"]) $(id).value = "";
    await loadPotentialSites();
    if (wasEdit) {
      openPotDetail(potentialSites.findIndex(x => x.id === editedId));
      statusEl.textContent = "Details updated.";
    } else {
      statusEl.textContent = `Saved — ${potentialSites.length} potential sites now shared.`;
    }
  } catch (err) {
    potMsg("Error: " + err.message, true);
  }
});

function editPotentialSite(ps) {
  editingSiteId = ps.id;
  proposing = false;
  $("potFormTitle").textContent = `Edit: ${ps.name}`;
  $("potSaveBtn").textContent = "Save changes";
  $("potLoc").textContent = `${ps.lat.toFixed(5)}, ${ps.lon.toFixed(5)} (fixed)`;
  potMsg("Editing — an audit note will be added to the thread.");
  openModal("form");
  $("potName").value = ps.name;
  $("potCompany").value = ps.company || "";
  $("potAddress").value = ps.address || "";
  $("potContact").value = ps.contact || "";
  $("potNotes").value = ps.notes || "";
  $("potHeight").value = ps.height_m;
  $("potPower").value = ps.power || "unknown";
  $("potAccess").value = ps.access || "unknown";
  $("potStatus").value = ps.status;
  pendingPot = { latlng: L.latLng(ps.lat, ps.lon), marker: null };
}

// ---- detail panel: everything about one site, plus mesh-link analysis

async function openPotDetail(i) {
  const ps = potentialSites[i];
  if (!ps) return;
  potLinkLayer.clearLayers();
  const el = $("potDetail");
  openModal("detail");
  el.innerHTML =
    `<div class="pd-head"><b>${escapeHtml(ps.name)}</b>` +
    `<span class="chip chip-${escapeHtml(ps.status)}">${escapeHtml(ps.status)}</span>` +
    `<button class="site-del" id="pdClose" title="Close">×</button></div>` +
    (ps.company ? `<div class="pd-row">Owner/business: <b>${escapeHtml(ps.company)}</b></div>` : "") +
    (ps.contact ? `<div class="pd-row">Contact: ${escapeHtml(ps.contact)}</div>` : "") +
    (ps.address ? `<div class="pd-row">${escapeHtml(ps.address)}</div>` : "") +
    `<div class="pd-row">${ps.lat.toFixed(5)}, ${ps.lon.toFixed(5)} · roof/mast ${ps.height_m} m AGL</div>` +
    ((ps.access !== "unknown" || ps.power !== "unknown")
      ? `<div class="pd-row">${ps.access !== "unknown" ? "Mount: " + escapeHtml(ps.access) : ""}` +
        `${ps.access !== "unknown" && ps.power !== "unknown" ? " · " : ""}` +
        `${ps.power === "grid" ? "grid power" : ps.power === "solar-needed" ? "no power — solar" : ""}</div>`
      : "") +
    (ps.notes ? `<div class="pd-row">${escapeHtml(ps.notes)}</div>` : "") +
    `<div class="pd-row sub2">added ${String(ps.created_at).slice(0, 10)}` +
    (ps.submitted_by ? ` by ${escapeHtml(ps.submitted_by)}` : "") + `</div>` +
    `<div class="pd-actions">` +
    `<button id="pdLinks" type="button">Mesh links</button>` +
    `<button id="pdCov" type="button">Coverage</button>` +
    `<button id="pdAdd" type="button">Plan with it</button>` +
    `<button id="pdEdit" type="button">Edit</button>` +
    `</div>` +
    `<div id="pdLinkResults"></div>` +
    `<h2>Updates</h2>` +
    `<div id="pdNotes"><span class="sub2">loading…</span></div>` +
    `<textarea id="pdNote" rows="2" maxlength="500" ` +
    `placeholder="Add an update — e.g. talked to the manager 7/4, wants a one-pager"></textarea>` +
    `<div class="grid2">` +
    `<input type="text" id="pdAuthor" maxlength="40" placeholder="your name (optional)">` +
    `<select id="pdStatus"><option value="">keep status</option>` +
    `<option value="idea">idea</option><option value="scouted">scouted</option>` +
    `<option value="contacted">contacted</option><option value="approved">approved</option>` +
    `<option value="declined">declined</option></select></div>` +
    `<button id="pdSave" type="button">Save update</button>`;

  $("pdClose").onclick = () => { closeModal(); potLinkLayer.clearLayers(); };
  $("pdCov").onclick = () => {
    closeModal();
    window.__showCov(ps.lat, ps.lon, ps.height_m, +$("repGain").value, ps.name);
  };
  $("pdAdd").onclick = () => {
    closeModal();
    addSite(L.latLng(ps.lat, ps.lon), ps.height_m, +$("repGain").value);
    setTab("network");
    statusEl.textContent = `"${ps.name}" added to the planning network.`;
  };
  $("pdEdit").onclick = () => editPotentialSite(ps);
  $("pdLinks").onclick = () => checkPotMeshLinks(ps).catch(err => {
    statusEl.textContent = "Error: " + err.message;
    statusEl.classList.add("error");
  });
  $("pdSave").onclick = () => savePotUpdate(ps).catch(err => {
    statusEl.textContent = "Error: " + err.message;
    statusEl.classList.add("error");
  });

  try {
    const r = await fetch(`/api/potential-sites/${ps.id}/notes`);
    const notes = (await r.json()).notes || [];
    $("pdNotes").innerHTML = notes.length
      ? notes.map(n =>
          `<div class="pd-note"><span class="sub2">${String(n.created_at).slice(0, 10)}` +
          (n.author ? ` · ${escapeHtml(n.author)}` : "") + `</span><br>` +
          `${escapeHtml(n.note)}</div>`).join("")
      : `<span class="sub2">No updates yet — be the first to scout it.</span>`;
  } catch { $("pdNotes").innerHTML = ""; }
}

async function savePotUpdate(ps) {
  const note = $("pdNote").value.trim();
  if (!note) { statusEl.textContent = "Write the update first."; return; }
  const r = await fetch(`/api/potential-sites/${ps.id}/notes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ note, author: $("pdAuthor").value.trim(),
                           status: $("pdStatus").value }),
  });
  if (!r.ok) throw new Error((await r.json()).error || `HTTP ${r.status}`);
  await loadPotentialSites();
  openPotDetail(potentialSites.findIndex(x => x.id === ps.id));
  statusEl.textContent = `Update saved on "${ps.name}".`;
}

/* From this rooftop, can we reach the existing mesh? Full path-model links
 * to the nearest active repeaters, drawn on the map and listed with margins. */
async function checkPotMeshLinks(ps) {
  statusEl.textContent = "Checking links to mesh repeaters…";
  if (!meshNodes.length) await loadMeshNodes();
  const p = readParams();
  const cands = meshNodes
    .filter(n => n.role === "repeater" && nodeFresh(n) && n.lat && n.lon)
    .map(n => ({ n, dist: Math.hypot((n.lat - ps.lat) * 111320,
        (n.lon - ps.lon) * 111320 * Math.cos(ps.lat * D2R)) }))
    .filter(c => c.dist > 100 && c.dist < 40000)
    .sort((a, c) => a.dist - c.dist)
    .slice(0, 10);
  if (!cands.length) {
    $("pdLinkResults").innerHTML =
      `<div class="pd-row sub2">No active mesh repeaters within 40 km.</div>`;
    return;
  }
  const reach = cands[cands.length - 1].dist + 2000;
  const z = pickZoom(ps.lat, reach);
  failedTileKeys = [];
  const lcJob = p.envAuto ? prefetchLandcover(ps.lat, ps.lon, reach) : null;
  await prefetchTiles(ps.lat, ps.lon, reach, z,
    (d, n) => { statusEl.textContent = `Fetching terrain… ${d}/${n}`; });
  if (lcJob) await lcJob;
  const mpp = 156543.034 * Math.cos(ps.lat * D2R) / 2 ** z;
  const env = { elevAt: makeSampler(z), stepLen: Math.max(mpp, reach / 900),
                lambda: 299.792458 / p.freq, freq: p.freq, model: p.model };
  const g = +$("repGain").value, hNode = +$("repHeight").value;
  potLinkLayer.clearLayers();
  const rows = [];
  for (const { n, dist } of cands) {
    const res = tracePath(ps.lat, ps.lon, ps.height_m, n.lat, n.lon, hNode,
                          env, env.model !== "deygout");
    const margin = p.txPower + g + g - p.margin
                 - clutterPair(p, ps.height_m, hNode, ps.lat, ps.lon, n.lat, n.lon)
                 - res.loss - p.rxSens;
    rows.push({ n, dist, margin });
    L.polyline([[ps.lat, ps.lon], [n.lat, n.lon]],
      { color: linkColor(margin), weight: 3, opacity: 0.8 }).addTo(potLinkLayer);
    await new Promise(r2 => setTimeout(r2));
  }
  rows.sort((a, c) => c.margin - a.margin);
  const ok = rows.filter(r => r.margin >= 0).length;
  $("pdLinkResults").innerHTML =
    `<div class="pd-row"><b>Reaches ${ok} of ${rows.length} nearest repeaters</b>` +
    ` <span class="sub2">(close this dialog to see the lines)</span></div>` +
    rows.map(r =>
      `<div class="pd-row"><span style="color:${linkColor(r.margin)}">●</span> ` +
      `${escapeHtml(r.n.name)} — ${(r.dist / 1000).toFixed(1)} km, ` +
      `${r.margin >= 0 ? "+" : ""}${r.margin.toFixed(0)} dB</div>`).join("");
  statusEl.textContent =
    `"${ps.name}" reaches ${ok}/${rows.length} nearby repeaters (${p.model} model, ` +
    `${ps.height_m} m roof).`;
}

// ------------------------------------------------------------ address search

async function geocode(q) {
  let vb = "";
  try {
    const b = map.getBounds();
    const vals = [b.getWest(), b.getNorth(), b.getEast(), b.getSouth()];
    if (vals.every(isFinite) && b.getWest() !== b.getEast()) {
      vb = `&viewbox=${vals.join(",")}`;
    }
  } catch { /* map not laid out yet — search unbiased */ }
  const r = await fetch("https://nominatim.openstreetmap.org/search?format=json&limit=1&q="
                        + encodeURIComponent(q) + vb);
  if (!r.ok) throw new Error("geocoder unavailable");
  const js = await r.json();
  if (!js.length) throw new Error(`no results for "${q}" — try adding city/state`);
  return js[0];
}

$("addrGo").addEventListener("click", async () => {
  const q = $("addrInput").value.trim();
  if (!q) return;
  try {
    statusEl.textContent = "Looking up address…";
    const hit = await geocode(q);
    const ll = L.latLng(+hit.lat, +hit.lon);
    map.setView(ll, Math.max(map.getZoom(), 14));
    if (mode === "network") addSite(ll);
    else if (mode === "community") { if (!$("potForm").hidden) beginPotentialForm(ll); }
    else setTx(ll);
    statusEl.textContent = hit.display_name;
  } catch (err) {
    statusEl.textContent = "Error: " + err.message;
    statusEl.classList.add("error");
  }
});
$("addrInput").addEventListener("keydown", e => {
  if (e.key === "Enter") { e.preventDefault(); $("addrGo").click(); }
});

let computeTimer = null;
function scheduleCompute() {
  clearTimeout(computeTimer);
  computeTimer = setTimeout(computeCoverage, 500);
}

$("updateBtn").addEventListener("click", computeCoverage);

for (const id of ["freq", "txPower", "txGain", "txHeight", "omni", "bearing",
                  "beamwidth", "f2b", "rxSens", "rxGain", "rxHeight", "margin",
                  "env", "pathModel", "radius"]) {
  $(id).addEventListener("input", () => {
    updateBudget();
    if (id === "bearing") $("bearingVal").textContent = $("bearing").value;
    if (id === "omni") $("dirControls").style.display = $("omni").checked ? "none" : "";
    if (id === "rxSens") $("rxPreset").value = "custom";
    if (["txGain", "omni", "beamwidth", "f2b"].includes(id)) $("txAntPreset").value = "custom";
    if (id === "rxGain") $("rxAntPreset").value = "custom";
    if (txLatLng) scheduleCompute();
    if (mode === "network" && sites.length >= 2) scheduleLinks();
  });
}

const ANTENNAS_BY_ID = Object.fromEntries(ANTENNA_CATALOG.map(a => [a.id, a]));

function antennaLabel(a) {
  const parts = [`${effectiveGain(a).toFixed(1)} dBi`];
  if (a.claim) parts.push(`claims ${a.claim}`);
  if (a.omni === false) parts.push("directional");
  return `${a.name} (${parts.join(", ")})`;
}

function populateAntennaSelects() {
  for (const selId of ["txAntPreset", "rxAntPreset"]) {
    const sel = $(selId);
    sel.innerHTML = "";
    let group = null, og = null;
    for (const a of ANTENNA_CATALOG) {
      if (a.group !== group) {
        group = a.group;
        og = document.createElement("optgroup");
        og.label = group;
        sel.appendChild(og);
      }
      const o = document.createElement("option");
      o.value = a.id;
      o.textContent = antennaLabel(a);
      og.appendChild(o);
    }
    const c = document.createElement("option");
    c.value = "custom";
    c.textContent = "Custom";
    sel.appendChild(c);
  }
  $("txAntPreset").value = "p1pro";
  $("rxAntPreset").value = "muzi17";
}

$("txAntPreset").addEventListener("change", () => {
  const a = ANTENNAS_BY_ID[$("txAntPreset").value];
  if (!a) return;
  const omni = a.omni !== false;
  $("txGain").value = effectiveGain(a);
  $("omni").checked = omni;
  $("dirControls").style.display = omni ? "none" : "";
  if (!omni) { $("beamwidth").value = a.beamwidth; $("f2b").value = a.f2b; }
  updateBudget();
  if (txLatLng) scheduleCompute();
});

$("rxAntPreset").addEventListener("change", () => {
  const a = ANTENNAS_BY_ID[$("rxAntPreset").value];
  if (!a) return;
  $("rxGain").value = effectiveGain(a);
  updateBudget();
  if (txLatLng) scheduleCompute();
});

$("rxPreset").addEventListener("change", () => {
  const v = $("rxPreset").value;
  if (v !== "custom") {
    $("rxSens").value = v;
    if (v === "-121") $("freq").value = 910.525;   // MeshCore US default channel
    updateBudget();
    if (txLatLng) scheduleCompute();
  }
});

populateAntennaSelects();
updateBudget();
buildLegend(+$("rxSens").value);
$("ver").textContent = `v${APP_VERSION} · `;
