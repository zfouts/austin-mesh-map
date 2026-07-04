/**
 * Terrain tile proxy. Static assets in ./public are served automatically
 * before this Worker runs, so the only requests that reach it are
 * /terrain/{z}/{x}/{y}.png (proxied to the AWS Terrain Tiles open dataset,
 * cached at the edge) and genuine 404s.
 */

const TERRAIN_ORIGIN = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium";
const TILE_PATH = /^\/terrain\/(\d{1,2})\/(\d+)\/(\d+)\.png$/;
const EDGE_TTL = 60 * 60 * 24 * 30;     // 30 days — SRTM terrain doesn't change
const BROWSER_TTL = 60 * 60 * 24 * 7;
const MESH_API = "https://scope.digitaino.com/api/nodes?limit=1000";

export default {
  async fetch(request) {
    const url = new URL(request.url);

    // Live mesh-node list (Austin MeshCore scope), edge-cached 5 minutes.
    if (url.pathname === "/api/mesh-nodes") {
      const upstream = await fetch(MESH_API, {
        headers: { "User-Agent": "radio-map.zach.workers.dev mesh planner" },
        cf: { cacheEverything: true,
              cacheTtlByStatus: { "200-299": 300, "500-599": 0 } },
      });
      if (!upstream.ok) {
        return new Response("mesh source unavailable", { status: 502 });
      }
      return new Response(upstream.body, {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=300",
        },
      });
    }

    // NLCD land-cover tiles (US only), rendered via the MRLC WMS and cached
    // hard at the edge — land cover changes on a multi-year cadence.
    const lc = url.pathname.match(/^\/landcover\/(\d{1,2})\/(\d+)\/(\d+)\.png$/);
    if (lc) {
      const z = Number(lc[1]), x = Number(lc[2]), y = Number(lc[3]);
      const n = 2 ** z;
      if (z < 6 || z > 13 || x < 0 || x >= n || y < 0 || y >= n) {
        return new Response("Invalid tile coordinates", { status: 400 });
      }
      const world = 40075016.686;
      const span = world / n;
      const x0 = -world / 2 + x * span;
      const y1 = world / 2 - y * span;
      const wms = "https://www.mrlc.gov/geoserver/mrlc_display/NLCD_2021_Land_Cover_L48/wms" +
        "?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS=NLCD_2021_Land_Cover_L48" +
        "&STYLES=&CRS=EPSG:3857&WIDTH=256&HEIGHT=256&FORMAT=image/png" +
        `&BBOX=${x0},${y1 - span},${x0 + span},${y1}`;
      const upstream = await fetch(wms, {
        cf: { cacheEverything: true,
              cacheTtlByStatus: { "200-299": EDGE_TTL, "404": 60, "500-599": 0 } },
      });
      if (!upstream.ok || !(upstream.headers.get("content-type") || "").includes("image")) {
        return new Response("No land cover", { status: 404 });
      }
      return new Response(upstream.body, {
        status: 200,
        headers: {
          "Content-Type": "image/png",
          "Cache-Control": `public, max-age=${BROWSER_TTL}, immutable`,
        },
      });
    }

    const m = url.pathname.match(TILE_PATH);
    if (!m) {
      return new Response("Not found", { status: 404 });
    }

    const z = Number(m[1]), x = Number(m[2]), y = Number(m[3]);
    const n = 2 ** z;
    if (z < 0 || z > 15 || x < 0 || x >= n || y < 0 || y >= n) {
      return new Response("Invalid tile coordinates", { status: 400 });
    }

    // Cache good tiles for a month, but never pin an upstream error at the
    // edge — a cached 5xx would silently flatten that tile's terrain for
    // every user until the TTL expired.
    const upstream = await fetch(`${TERRAIN_ORIGIN}/${z}/${x}/${y}.png`, {
      cf: {
        cacheEverything: true,
        cacheTtlByStatus: { "200-299": EDGE_TTL, "404": 60, "500-599": 0 },
      },
    });
    if (!upstream.ok) {
      // Missing tiles (open ocean) — the client treats these as sea level.
      return new Response("No tile", { status: 404 });
    }

    return new Response(upstream.body, {
      status: 200,
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": `public, max-age=${BROWSER_TTL}, immutable`,
        "Access-Control-Allow-Origin": "*",
      },
    });
  },
};
