# How repeater placement works

The "Suggest repeater sites" button answers one question: **where could a
single new radio stand so that its *worst* link to any of your sites is as
strong as possible?** This is a maximin optimization — maximize the minimum —
run as a brute-force grid search over real terrain. Nothing about it guesses
or uses heuristics like "pick the highest point"; every candidate is scored by
simulating actual radio links.

## The pipeline

### 1. Define the search area

Take the bounding box of all placed sites, pad it by 30% on each side (minimum
~2 km). A repeater is occasionally best placed *outside* the hull of the sites
(e.g. up a hill behind one of them), which is why the padding exists. If the
obvious high ground is far outside your sites' footprint, add a throwaway site
near it to stretch the box.

### 2. Generate candidates

Lay a **42 × 42 grid** over the search area — about 1,700 candidate locations.
Candidates within 300 m of an existing site are discarded (a repeater on top
of an existing node adds nothing). Grid granularity is therefore about 1/42 of
the box span; for a 20 km network that's ~500 m between candidates.

### 3. Score every candidate — the physics

For each candidate, trace a full propagation path to **every** site:

1. **Terrain profile** — ground elevation sampled every few dozen meters along
   the straight path (AWS Terrain Tiles; ~30 m SRTM data, ~15 m 3DEP in the US
   at close zoom).
2. **Earth curvature** — terrain is dropped relative to the candidate's
   tangent plane using the 4/3-effective-earth-radius convention
   (`g' = g − d²/2·8495 km`), the standard way radio horizons are modeled.
3. **Free-space path loss** — `32.44 + 20·log₁₀(d_km) + 20·log₁₀(f_MHz)` dB.
4. **Propagation engine** — the coarse 1,700-candidate sweep uses two-edge
   Deygout diffraction for speed; the top candidates and all displayed
   margins are then computed with the **NTIA ITM (Longley-Rice v1.2.2)**
   model — the same algorithm used by SPLAT! and professional planning tools —
   which adds terrain-roughness statistics (Δh), smooth-earth diffraction,
   two-ray line-of-sight effects, and troposcatter.
5. **Link budget** — the margin for that site is

   ```
   margin = TXpower + Grep + Gsite − fade_margin − FSPL − diffraction − RXsens
   ```

   using the panel's TX power, receiver sensitivity, and fade/clutter margin,
   the *Repeater height/gain* inputs for the candidate, and each site's own
   height and gain. Antennas are treated as omnidirectional here.

The candidate's **score is the minimum margin across all sites** — its worst
link. A candidate that reaches four sites at +30 dB but misses the fifth by
−5 dB scores −5: a repeater is only as good as its weakest leg. (Scoring
aborts early once a candidate's worst link falls below −60 dB — hopeless spots
don't get full evaluation.)

### 4. Coarse-then-fine refinement

The 1,700-candidate sweep runs with terrain sampled at 2.5× the normal step
length for speed. The winners are then **re-scored at full resolution** before
being shown, so the numbers in the popups come from the same fidelity as the
coverage map.

### 5. Pick the recommendations

Candidates are sorted by score and picked greedily, skipping any within
`max(500 m, box-span/30)` of an already-picked one — otherwise all 15
recommendations would cluster on the same hilltop. Up to **15 markers
(R1…R15)** are placed, ranked best-first. Each popup shows the spot's
elevation, its worst-link margin, the individual margin to every site, a
**Show coverage** button (renders that spot's full footprint), and **Add as
site** (accepts it into the network so its links are drawn and the next
search can build on it).

## Why hilltops win without being asked for

Elevation is never a scoring input — only link margins are. But height is how
a location clears ridges toward several sites *simultaneously*, so high ground
tends to win the maximin contest naturally. The important nuance: the
algorithm happily prefers a **lower** spot when it genuinely sees better — a
saddle looking down two valleys can beat a taller summit whose own ridge
blocks one direction.

Verified example (real terrain, automated test): Boulder, CO ↔ Nederland, CO,
21.4 km with the Front Range foothills between. The direct link scores
−27.9 dB (diffraction pegged at the 60 dB cap — hopeless). The search picked a
2,491 m bench on the intervening ridge — not the tallest peak in the box —
with **+13.7 dB margin to both ends**.

## What it does NOT know

- **Land access.** R1 may be in a wilderness area or someone's back yard. The
  physics ranking is the starting point; the per-site margins tell you how
  much slack you have to shift to the nearest buildable spot (drop a manual
  site there to check).
- **Clutter.** Trees and buildings at the candidate site beyond what SRTM's
  canopy-influenced elevations capture. The fade/clutter margin input is the
  blunt instrument for this.
- **Multi-repeater solutions.** It places ONE new node per run. If no single
  spot reaches everything ("best candidate is X dB short"), accept the best
  candidate with *Add as site* and run the search again for the remaining
  gap — build multi-hop networks iteratively.
- **Real antenna heights of mesh nodes.** Nodes imported from the live mesh
  layer use the Repeater height/gain inputs, not their true mast heights.

## Cost and knobs

A full search is ~1,700 candidates × N sites × a few hundred terrain samples
per path — a few million elevation lookups, a few seconds in the browser, with
progress shown in the status line. The knobs that change the answer most, in
order: **repeater height** (clears ridges), search area (add an outlying site
to widen it), fade margin, and receiver sensitivity.
