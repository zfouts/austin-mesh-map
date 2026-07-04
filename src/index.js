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

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

const POWER_VALUES = ["unknown", "grid", "solar-needed"];
const ACCESS_VALUES = ["unknown", "rooftop", "tower", "water-tank", "pole", "hilltop", "other"];
const RADIO_VALUES = ["seeed-20", "heltec-22", "rak1w-30"];

function siteFields(body) {
  return {
    address: String(body.address || "").trim().slice(0, 160),
    company: String(body.company || "").trim().slice(0, 80),
    contact: String(body.contact || "").trim().slice(0, 120),
    power: POWER_VALUES.includes(body.power) ? body.power : "unknown",
    access: ACCESS_VALUES.includes(body.access) ? body.access : "unknown",
    radio: RADIO_VALUES.includes(body.radio) ? body.radio : "heltec-22",
  };
}

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { "Content-Type": "application/json" },
});

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Community-identified potential repeater sites, persisted in D1.
    if (url.pathname === "/api/potential-sites") {
      if (request.method === "GET") {
        const { results } = await env.DB.prepare(
          "SELECT s.id, s.name, s.notes, s.lat, s.lon, s.height_m, s.status, " +
          "s.address, s.company, s.contact, s.power, s.access, s.radio, " +
          "s.submitted_by, s.created_at, COUNT(n.id) AS note_count " +
          "FROM potential_sites s LEFT JOIN potential_site_notes n ON n.site_id = s.id " +
          "GROUP BY s.id ORDER BY s.created_at DESC LIMIT 500").all();
        return json({ sites: results });
      }
      if (request.method === "POST") {
        let body;
        try { body = await request.json(); } catch { return json({ error: "bad json" }, 400); }
        const name = String(body.name || "").trim().slice(0, 60);
        const notes = String(body.notes || "").trim().slice(0, 500);
        const lat = Number(body.lat), lon = Number(body.lon);
        const height = Math.min(Math.max(Number(body.height_m) || 10, 1), 200);
        if (!name) return json({ error: "name required" }, 400);
        if (!isFinite(lat) || !isFinite(lon) ||
            lat < -60 || lat > 72 || lon < -180 || lon > 180) {
          return json({ error: "invalid coordinates" }, 400);
        }
        const ip = request.headers.get("CF-Connecting-IP") || "unknown";
        const ipHash = (await sha256Hex("amm-salt:" + ip)).slice(0, 16);
        const { results: cnt } = await env.DB.prepare(
          "SELECT COUNT(*) AS n FROM potential_sites " +
          "WHERE ip_hash = ? AND created_at > datetime('now', '-1 day')")
          .bind(ipHash).all();
        if (cnt[0].n >= 10) {
          return json({ error: "daily submission limit reached" }, 429);
        }
        const VALID_STATUS = ["idea", "scouted", "contacted", "approved", "declined"];
        const status = VALID_STATUS.includes(body.status) ? body.status : "idea";
        const by = String(body.submitted_by || "").trim().slice(0, 40);
        const f = siteFields(body);
        const r = await env.DB.prepare(
          "INSERT INTO potential_sites (name, notes, lat, lon, height_m, status, submitted_by, " +
          "address, company, contact, power, access, radio, ip_hash) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id, created_at")
          .bind(name, notes, lat, lon, height, status, by,
                f.address, f.company, f.contact, f.power, f.access, f.radio, ipHash).all();
        return json({ ok: true, id: r.results[0].id }, 201);
      }
      return json({ error: "method not allowed" }, 405);
    }

    // Edit an existing potential site. Every edit writes an audit note (which
    // is what the daily note rate-limit counts, so edits are limited too).
    const editMatch = url.pathname.match(/^\/api\/potential-sites\/(\d+)$/);
    if (editMatch && request.method === "PUT") {
      const siteId = Number(editMatch[1]);
      let body;
      try { body = await request.json(); } catch { return json({ error: "bad json" }, 400); }
      const { results: existing } = await env.DB.prepare(
        "SELECT id FROM potential_sites WHERE id = ?").bind(siteId).all();
      if (!existing.length) return json({ error: "no such site" }, 404);
      const name = String(body.name || "").trim().slice(0, 60);
      if (!name) return json({ error: "name required" }, 400);
      const notes = String(body.notes || "").trim().slice(0, 500);
      const height = Math.min(Math.max(Number(body.height_m) || 10, 1), 200);
      const f = siteFields(body);
      const author = String(body.author || "").trim().slice(0, 40);
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      const ipHash = (await sha256Hex("amm-salt:" + ip)).slice(0, 16);
      const { results: cnt } = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM potential_site_notes " +
        "WHERE ip_hash = ? AND created_at > datetime('now', '-1 day')")
        .bind(ipHash).all();
      if (cnt[0].n >= 30) return json({ error: "daily edit limit reached" }, 429);
      await env.DB.prepare(
        "UPDATE potential_sites SET name = ?, notes = ?, height_m = ?, " +
        "address = ?, company = ?, contact = ?, power = ?, access = ?, radio = ? WHERE id = ?")
        .bind(name, notes, height, f.address, f.company, f.contact,
              f.power, f.access, f.radio, siteId).run();
      await env.DB.prepare(
        "INSERT INTO potential_site_notes (site_id, note, author, ip_hash) VALUES (?, ?, ?, ?)")
        .bind(siteId, "(details edited)", author, ipHash).run();
      return json({ ok: true });
    }

    // Outreach notes thread on a potential site ("talked to the owner 7/4…"),
    // optionally moving its status along the idea→contacted→approved pipeline.
    const noteMatch = url.pathname.match(/^\/api\/potential-sites\/(\d+)\/notes$/);
    if (noteMatch) {
      const siteId = Number(noteMatch[1]);
      if (request.method === "GET") {
        const { results } = await env.DB.prepare(
          "SELECT note, author, created_at FROM potential_site_notes " +
          "WHERE site_id = ? ORDER BY created_at DESC LIMIT 50").bind(siteId).all();
        return json({ notes: results });
      }
      if (request.method === "POST") {
        let body;
        try { body = await request.json(); } catch { return json({ error: "bad json" }, 400); }
        const note = String(body.note || "").trim().slice(0, 500);
        const author = String(body.author || "").trim().slice(0, 40);
        if (!note) return json({ error: "note required" }, 400);
        const { results: site } = await env.DB.prepare(
          "SELECT id FROM potential_sites WHERE id = ?").bind(siteId).all();
        if (!site.length) return json({ error: "no such site" }, 404);
        const ip = request.headers.get("CF-Connecting-IP") || "unknown";
        const ipHash = (await sha256Hex("amm-salt:" + ip)).slice(0, 16);
        const { results: cnt } = await env.DB.prepare(
          "SELECT COUNT(*) AS n FROM potential_site_notes " +
          "WHERE ip_hash = ? AND created_at > datetime('now', '-1 day')")
          .bind(ipHash).all();
        if (cnt[0].n >= 30) return json({ error: "daily note limit reached" }, 429);
        await env.DB.prepare(
          "INSERT INTO potential_site_notes (site_id, note, author, ip_hash) VALUES (?, ?, ?, ?)")
          .bind(siteId, note, author, ipHash).run();
        const VALID_STATUS = ["idea", "scouted", "contacted", "approved", "declined"];
        if (VALID_STATUS.includes(body.status)) {
          await env.DB.prepare("UPDATE potential_sites SET status = ? WHERE id = ?")
            .bind(body.status, siteId).run();
        }
        return json({ ok: true }, 201);
      }
      return json({ error: "method not allowed" }, 405);
    }

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
