/* Antenna catalog. Sources: manufacturer datasheets and the Austin Mesh
 * RF Index (rfindex.com/mesh/antennas), which independently measures VSWR.
 *
 * `base` is the gain we model, in dBi. Where a marketing claim is physically
 * implausible for the antenna's size/class (e.g. "10 dBi" for a 17 cm whip —
 * a half-wave dipole is 2.15 dBi, period), `base` is the honest physics
 * number and `claim` records what the listing says. Effective gain shown in
 * the UI additionally subtracts mismatch loss computed from measured VSWR.
 */

"use strict";

const ANTENNA_CATALOG = [
  // -------- directional
  { id: "ya913", group: "Directional", name: "Laird YA9-13 yagi",
    base: 13, vswr: 1.5, omni: false, beamwidth: 30, f2b: 18 },
  { id: "arcpanel", group: "Directional", name: "ARC Wireless flat panel",
    base: 13.2, vswr: 1.179, omni: false, beamwidth: 35, f2b: 20 },

  // -------- base-station omnis (N-type, fixed mount)
  { id: "rokland58", group: "Base-station omni", name: "Rokland 5.8 dBi large fiberglass", base: 5.8, vswr: 1.013 },
  { id: "rak8", group: "Base-station omni", name: "RAKwireless 8 dBi fiberglass", base: 8, vswr: 1.955 },
  { id: "hexa8", group: "Base-station omni", name: "Hexa Boost fiberglass", base: 6, claim: "8", vswr: 1.124 },
  { id: "zdtech7", group: "Base-station omni", name: "ZDTECH fiberglass", base: 5.5, claim: "7", vswr: 1.17 },
  { id: "seeed5", group: "Base-station omni", name: "Seeed Studio 5 dBi fiberglass", base: 5, vswr: 2.088 },
  { id: "lairdma9", group: "Base-station omni", name: "Laird MA9-5N whip", base: 5, claim: "5.5", vswr: 1.506 },
  { id: "rokland6", group: "Base-station omni", name: "Rokland low-profile fiberglass", base: 3.5, claim: "6", vswr: 1.047 },
  { id: "rak3", group: "Base-station omni", name: "RAKwireless 3 dBi fiberglass", base: 3, vswr: 1.215 },
  { id: "cws3", group: "Base-station omni", name: "Canadian Wireless Supply 3 dBi fiberglass", base: 3, vswr: 1.643 },
  { id: "alfa", group: "Base-station omni", name: "Alfa AOA-915-5ACM 18 cm", base: 2.2, claim: "5", vswr: 1.057 },
  { id: "meshn", group: "Base-station omni", name: "Meshnology 17.8 cm N", base: 2.2, claim: "5", vswr: 1.1 },
  { id: "taoglas", group: "Base-station omni", name: "Taoglas TI.16 whip (N)", base: 2.2, claim: "5 w/ ground plane", vswr: 1.21 },

  // -------- mobile / mag-mount
  { id: "lairdnmo", group: "Mobile / mag-mount", name: "Laird TRA9020S3CBN (NMO)", base: 3, vswr: 1.335 },
  { id: "eifagur", group: "Mobile / mag-mount", name: "Eifagur magnetic base", base: 3, claim: "5.8", vswr: 1.46 },
  { id: "tenmorycsa", group: "Mobile / mag-mount", name: "Tenmory TB-CSA21", base: 2.5, claim: "3", vswr: 1.178 },

  // -------- portable whips (SMA)
  { id: "muzi17", group: "Portable whip", name: "Muzi Works 17 cm whip", base: 2.2, vswr: 1.172 },
  { id: "gizont", group: "Portable whip", name: "Gizont NB-IoT whip", base: 2.2, claim: "10 (!)", vswr: 1.329 },
  { id: "tenmory5", group: "Portable whip", name: "Tenmory whip", base: 2.2, claim: "5", vswr: 1.151 },
  { id: "diymalls", group: "Portable whip", name: "DIYMalls DIY0147", base: 2.2, claim: "5" },
  { id: "maxtena", group: "Portable whip", name: "Maxtena SMA whip", base: 2.2, claim: "4", vswr: 1.538 },
  { id: "cdebyte", group: "Portable whip", name: "CDEBYTE TX915-JKD-20", base: 2.2, claim: "3.5", vswr: 1.48 },
  { id: "te916", group: "Portable whip", name: "TE ANT-916-CW-RCS", base: 2.2, claim: "3.3", vswr: 1.202 },
  { id: "jc402", group: "Portable whip", name: "JC JCG402LR-2", base: 2, vswr: 2.365 },
  { id: "linxqw", group: "Portable whip", name: "Linx ANT-868-CW-QW ¼-wave", base: 1.6, vswr: 1.759 },
  { id: "linxdip", group: "Portable whip", name: "Linx SMA ½-wave dipole", base: 1.2, vswr: 1.736 },
  { id: "pulse", group: "Portable whip", name: "Pulse Larsen W1063M", base: 1, vswr: 1.332 },
  { id: "ziisor", group: "Portable whip", name: "Ziisor TX915-JZ-5", base: 2.2, claim: "3", vswr: 8.67 },
  { id: "dswf868", group: "Portable whip", name: "DSWF 37.5 cm (868 MHz band)", base: 4, claim: "12 (exaggerated)" },

  // -------- PCB / internal
  { id: "linxpcb", group: "PCB / internal", name: "Linx PCB Flex (u.FL)", base: -1, vswr: 1.704 },
  { id: "molex", group: "PCB / internal", name: "Molex PCB dipole (u.FL)", base: 1.3, vswr: 1.551 },

  // -------- stock antennas
  { id: "tbeam", group: "Stock antenna", name: "LILYGO T-Beam stock", base: 1, claim: "unknown", vswr: 6.278 },
  { id: "techo", group: "Stock antenna", name: "LILYGO T-Echo stock", base: 1, claim: "unknown", vswr: 3.677 },
];

/* Reflection (mismatch) loss in dB from measured VSWR — power that bounces
 * back down the coax instead of radiating. */
function mismatchLoss(vswr) {
  if (!vswr || vswr <= 1) return 0;
  const rho = (vswr - 1) / (vswr + 1);
  return -10 * Math.log10(1 - rho * rho);
}

function effectiveGain(a) {
  return Math.round((a.base - mismatchLoss(a.vswr)) * 10) / 10;
}
