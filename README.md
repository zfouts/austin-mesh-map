# Austin Mesh Map

> **This is an AI-generated project, directed by humans.** The code, physics
> ports, calibration studies, and documentation were written by Claude
> (Anthropic) working under the direction of Zachary Fouts. Design decisions,
> feature priorities, and reality checks came from the human; the
> implementation came from the AI. Bugs are a joint venture.

RF coverage and repeater planning for the Austin, TX MeshCore network — and a
general-purpose 915 MHz coverage mapper for anyone else.

**Live:** https://austin-mesh-map.zach.workers.dev · [How it's calculated](https://austin-mesh-map.zach.workers.dev/how)

Interactive antenna coverage maps in the browser, built on open data. Click the
map to place a transmitter, and it renders a terrain-aware signal-strength
overlay on OpenStreetMap. Defaults are set for a Seeed SenseCAP P1 Pro
(22 dBm) with a 5 dBi omni talking to LoRa-class receivers — the typical
MeshCore repeater build — but everything is adjustable, including a
34-antenna catalog and directional yagi support.

Runs as a Cloudflare Worker: static assets plus a tiny edge function that
proxies and caches elevation tiles, so anyone can use it at a public URL.

## Develop

```sh
npm install
npm run dev       # http://localhost:8787
```

## Deploy

```sh
npm run deploy    # deploys to <name>.<account>.workers.dev
```

To serve it on your own domain (the zone must be on Cloudflare), uncomment the
`routes` block in `wrangler.jsonc` and adjust the hostname.

## How it works

- **Basemap** — OpenStreetMap tiles via Leaflet.
- **Elevation** — the free [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/)
  open dataset (SRTM-derived, terrarium PNG encoding). The Worker at
  `/terrain/{z}/{x}/{y}.png` proxies the S3 bucket and caches tiles at the
  Cloudflare edge for 30 days.
- **Propagation model** — computed client-side. 720 azimuth rays are walked
  outward from the transmitter, sampling terrain elevation along each:
  - free-space path loss: `32.44 + 20·log₁₀(d_km) + 20·log₁₀(f_MHz)`
  - 4/3-effective-earth-radius curvature
  - two-edge Deygout diffraction (ITU-R P.526 `J(v)` per edge) for coverage
    heatmaps, plus a full JavaScript port of the NTIA **ITM (Longley-Rice
    v1.2.2)** model (`public/itm.js`, ported from the public-domain reference
    implementation) used for point inspection, P2P links, and repeater
    candidate scoring
  - a gaussian-rolloff azimuth pattern for directional antennas
    (`G(θ) = G₀ − 12·(θ/HPBW)²`, clamped at the front-to-back ratio)
- **Rendering** — received power is quantized into 10 dB bands from −60 dBm
  down to the receiver sensitivity and painted onto a canvas overlay
  (single-hue sequential ramp, dark = strong). Below sensitivity is
  transparent. After computing, click anywhere on the map for a per-point
  link budget popup.
- **Multi-site P2P mode** — switch to "Multi-site P2P" and click (or search an
  address via Nominatim) to add up to 12 sites, each with its own height and
  antenna gain. Every pair is evaluated as a point-to-point link and drawn
  green (≥10 dB margin), amber (0–10 dB), or red (blocked); click a link for
  its full budget and elevation profile.
- **Repeater placement** — grid-searches the terrain around your sites for
  the spot whose *worst* link to any site is best (maximin), refines the top
  candidates at full resolution, and drops up to 15 ranked "R" markers with
  per-site margins and a one-click "Add as site" button. Full algorithm
  write-up: [docs/repeater-placement.md](docs/repeater-placement.md).
- **Elevation profile** — clicking a point also opens a heywhatsthat-style
  path profile below the map: terrain along the bearing (4/3-earth curvature
  applied), the line-of-sight ray between the two antennas, the first Fresnel
  zone, and a marker on the dominant obstruction. Hover for
  distance/elevation/clearance at any point along the path.

## Model limitations

This is a planning tool, not a guarantee:

- Coverage heatmaps use two-edge Deygout (for speed), which underestimates
  loss over three-plus ridgelines; link and repeater calculations use the
  full ITM engine, which handles irregular terrain statistically.
- Building/vegetation clutter is modeled statistically, not per-obstacle: an
  environment setting (open/rural/suburban/urban) adds a per-antenna-end loss
  that fades out as the antenna rises above ~20 m AGL. Pick the environment
  honestly — "suburban" vs "open" moves the coverage edge by tens of dB at
  handheld heights.
- SRTM terrain is ~30 m resolution and includes some canopy height.
- The vertical antenna pattern is ignored (fine for typical yagi downtilt at
  these ranges).

## Regulatory note

In the US, FCC §15.247 limits 902–928 MHz ISM to 30 dBm TX with up to 6 dBi of
antenna gain (36 dBm EIRP). With a 13 dBi antenna in a point-to-multipoint
system you'd need to back the transmitter down accordingly (roughly 23 dBm);
fixed point-to-point links get a more generous 1 dB power reduction per 3 dB of
excess gain. The calculator happily models whatever you enter — staying legal
is on you.


## Credits

This tool stands on a lot of open work:

- **[NTIA ITM](https://github.com/NTIA/itm)** — the Longley-Rice v1.2.2
  reference implementation (U.S. Government work, public domain).
  `public/itm.js` is a faithful JavaScript port of it.
- **John A. Magliacane, KD2BD** — SPLAT!, which established ITM as the
  community standard for this kind of tool, and the
  **[Meshtastic Site Planner](https://github.com/meshtastic/meshtastic-site-planner)**
  which carries that convention forward.
- **ITU-R P.1812 / P.526** — the delta-Bullington diffraction construction
  (the model family CloudRF uses for most MeshCore community coverage maps).
- **[AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/)** —
  open elevation data (Mapzen terrarium tiles, NASA SRTM / USGS 3DEP).
- **[MRLC NLCD](https://www.mrlc.gov/)** — US land cover, powering the
  automatic clutter model.
- **[Austin Mesh RF Index](https://www.rfindex.com/mesh/antennas)** — measured
  antenna VSWR data behind the honest antenna catalog.
- **[scope.digitaino.com](https://scope.digitaino.com)** — live Austin
  MeshCore node data and the observed-link measurements used for calibration.
- **[Leaflet](https://leafletjs.com/)**, **[OpenStreetMap](https://www.openstreetmap.org/)**,
  **Esri** (imagery & hillshade tiles), **[Nominatim](https://nominatim.org/)** —
  the map itself.

Built with [Claude Code](https://claude.com/claude-code), directed by
[@zfouts](https://github.com/zfouts).
