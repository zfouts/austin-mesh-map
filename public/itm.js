/* ITS Irregular Terrain Model (Longley-Rice), point-to-point mode.
 *
 * JavaScript port of the NTIA reference implementation
 * (github.com/NTIA/itm, U.S. Government work, public domain), kept
 * structurally faithful to the C++ so it can be diffed against upstream.
 *
 * Entry point: itmPointToPoint(hTx, hRx, pfl, opts) -> {A_db, Afs, Aref,
 * mode, warnings}. pfl is the classic profile format: pfl[0] = number of
 * intervals, pfl[1] = interval length in meters, pfl[2..] = elevations.
 */

"use strict";

(function (global) {

const A0_METER = 6370e3;
const A9000_METER = 9000e3;
const THIRD = 1 / 3;
const MODE_P2P = 0;
const MODE_LOS = 1, MODE_DIFFRACTION = 2, MODE_TROPOSCATTER = 3;

const MAXd = Math.max, MINd = Math.min;
const DIM = (x, y) => (x > y ? x - y : 0);
const fdim = DIM;

// ---- minimal complex helpers (Z_g and R_e are the only complex values)
const cAbs = z => Math.hypot(z.re, z.im);
function cSqrt(z) {
  const r = cAbs(z);
  return { re: Math.sqrt((r + z.re) / 2),
           im: (z.im >= 0 ? 1 : -1) * Math.sqrt((r - z.re) / 2) };
}
function cDiv(a, b) {
  const d = b.re * b.re + b.im * b.im;
  return { re: (a.re * b.re + a.im * b.im) / d,
           im: (a.im * b.re - a.re * b.im) / d };
}

// ---- InitializePointToPoint.cpp
function initializePointToPoint(f_mhz, h_sys, N_0, pol, epsilon, sigma) {
  const gamma_a = 157e-9;
  const N_s = (h_sys === 0) ? N_0 : N_0 * Math.exp(-h_sys / 9460.0);
  const gamma_e = gamma_a * (1.0 - 0.04665 * Math.exp(N_s / 179.3));
  const ep_r = { re: epsilon, im: 18000 * sigma / f_mhz };
  let Z_g = cSqrt({ re: ep_r.re - 1.0, im: ep_r.im });
  if (pol === 1) Z_g = cDiv(Z_g, ep_r);            // vertical polarization
  return { Z_g, gamma_e, N_s };
}

// ---- FindHorizons.cpp
function findHorizons(pfl, a_e, h, theta_hzn, d_hzn) {
  const np = Math.trunc(pfl[0]);
  const xi = pfl[1];
  const d = pfl[0] * pfl[1];
  const z_tx = pfl[2] + h[0];
  const z_rx = pfl[np + 2] + h[1];
  theta_hzn[0] = (z_rx - z_tx) / d - d / (2 * a_e);
  theta_hzn[1] = -(z_rx - z_tx) / d - d / (2 * a_e);
  d_hzn[0] = d;
  d_hzn[1] = d;
  let d_tx = 0.0, d_rx = d;
  for (let i = 1; i < np; i++) {
    d_tx += xi;
    d_rx -= xi;
    const theta_tx = (pfl[i + 2] - z_tx) / d_tx - d_tx / (2 * a_e);
    const theta_rx = -(z_rx - pfl[i + 2]) / d_rx - d_rx / (2 * a_e);
    if (theta_tx > theta_hzn[0]) { theta_hzn[0] = theta_tx; d_hzn[0] = d_tx; }
    if (theta_rx > theta_hzn[1]) { theta_hzn[1] = theta_rx; d_hzn[1] = d_rx; }
  }
}

// ---- LinearLeastSquaresFit.cpp
function linearLeastSquaresFit(pfl, d_start, d_end) {
  const np = Math.trunc(pfl[0]);
  let i_start = Math.trunc(fdim(d_start / pfl[1], 0.0));
  let i_end = np - Math.trunc(fdim(np, d_end / pfl[1]));
  if (i_end <= i_start) {
    i_start = Math.trunc(fdim(i_start, 1.0));
    i_end = np - Math.trunc(fdim(np, i_end + 1.0));
  }
  const x_length = i_end - i_start;
  let mid_shifted_index = -0.5 * x_length;
  const mid_shifted_end = i_end + mid_shifted_index;
  let sum_y = 0.5 * (pfl[i_start + 2] + pfl[i_end + 2]);
  let scaled_sum_y = 0.5 * (pfl[i_start + 2] - pfl[i_end + 2]) * mid_shifted_index;
  for (let i = 2; i <= x_length; i++) {
    i_start++;
    mid_shifted_index++;
    sum_y += pfl[i_start + 2];
    scaled_sum_y += pfl[i_start + 2] * mid_shifted_index;
  }
  sum_y = sum_y / x_length;
  scaled_sum_y = scaled_sum_y * 12.0 / ((x_length * x_length + 2.0) * x_length);
  return [sum_y - scaled_sum_y * mid_shifted_end,
          sum_y + scaled_sum_y * (np - mid_shifted_end)];
}

// ---- ComputeDeltaH.cpp
function computeDeltaH(pfl, d_start, d_end) {
  const s = new Array(247).fill(0);
  const np = Math.trunc(pfl[0]);
  let x_start = d_start / pfl[1];
  let x_end = d_end / pfl[1];
  if (x_end - x_start < 2.0) return 0;
  let p10 = Math.trunc(0.1 * (x_end - x_start + 8.0));
  p10 = MINd(MAXd(4, p10), 25);
  const n = 10 * p10 - 5;
  const p90 = n - p10;
  const np_s = n - 1;
  s[0] = np_s;
  s[1] = 1.0;
  x_end = (x_end - x_start) / np_s;
  let i = Math.trunc(x_start);
  x_start -= i + 1.0;
  for (let j = 0; j < n; j++) {
    while (x_start > 0.0 && (i + 1) < np) { x_start--; i++; }
    s[j + 2] = pfl[i + 3] + (pfl[i + 3] - pfl[i + 2]) * x_start;
    x_start += x_end;
  }
  let [fit_y1, fit_y2] = linearLeastSquaresFit(s, 0.0, np_s);
  fit_y2 = (fit_y2 - fit_y1) / np_s;
  const diffs = [];
  for (let j = 0; j < n; j++) {
    diffs.push(s[j + 2] - fit_y1);
    fit_y1 += fit_y2;
  }
  diffs.sort((a, b) => b - a);                 // descending
  const q10 = diffs[p10 - 1];
  const q90 = diffs[p90];
  const delta_h_d = q10 - q90;
  return delta_h_d / (1.0 - 0.8 * Math.exp(-(d_end - d_start) / 50e3));
}

// ---- QuickPfl.cpp
function quickPfl(pfl, gamma_e, h) {
  const theta_hzn = [0, 0], d_hzn = [0, 0], h_e = [0, 0];
  const d = pfl[0] * pfl[1];
  const np = Math.trunc(pfl[0]);
  const a_e = 1 / gamma_e;

  findHorizons(pfl, a_e, h, theta_hzn, d_hzn);

  const d_start = MINd(15.0 * h[0], 0.1 * d_hzn[0]);
  const d_end = d - MINd(15.0 * h[1], 0.1 * d_hzn[1]);

  const delta_h = computeDeltaH(pfl, d_start, d_end);

  if (d_hzn[0] + d_hzn[1] > 1.5 * d) {
    // well within line-of-sight
    const [fit_tx, fit_rx] = linearLeastSquaresFit(pfl, d_start, d_end);
    h_e[0] = h[0] + fdim(pfl[2], fit_tx);
    h_e[1] = h[1] + fdim(pfl[np + 2], fit_rx);
    for (let i = 0; i < 2; i++)
      d_hzn[i] = Math.sqrt(2.0 * h_e[i] * a_e) *
                 Math.exp(-0.07 * Math.sqrt(delta_h / MAXd(h_e[i], 5.0)));
    const combined = d_hzn[0] + d_hzn[1];
    if (combined <= d) {
      const q = Math.pow(d / combined, 2);
      for (let i = 0; i < 2; i++) {
        h_e[i] = h_e[i] * q;
        d_hzn[i] = Math.sqrt(2.0 * h_e[i] * a_e) *
                   Math.exp(-0.07 * Math.sqrt(delta_h / MAXd(h_e[i], 5.0)));
      }
    }
    for (let i = 0; i < 2; i++) {
      const q = Math.sqrt(2.0 * h_e[i] * a_e);
      theta_hzn[i] = (0.65 * delta_h * (q / d_hzn[i] - 1.0) - 2.0 * h_e[i]) / q;
    }
  } else {
    let fit;
    fit = linearLeastSquaresFit(pfl, d_start, 0.9 * d_hzn[0]);
    h_e[0] = h[0] + fdim(pfl[2], fit[0]);
    fit = linearLeastSquaresFit(pfl, d - 0.9 * d_hzn[1], d_end);
    h_e[1] = h[1] + fdim(pfl[np + 2], fit[1]);
  }
  return { theta_hzn, d_hzn, h_e, delta_h, d };
}

// ---- TerrainRoughness.cpp / SigmaHFunction.cpp
const terrainRoughness = (d, delta_h) => delta_h * (1.0 - 0.8 * Math.exp(-d / 50e3));
const sigmaHFunction = delta_h => 0.78 * delta_h * Math.exp(-0.5 * Math.pow(delta_h, 0.25));

// ---- FreeSpaceLoss.cpp
const freeSpaceLoss = (d, f_mhz) => 32.45 + 20 * Math.log10(f_mhz) + 20 * Math.log10(d / 1000);

// ---- FresnelIntegral.cpp
function fresnelIntegral(v2) {
  if (v2 < 5.76) return 6.02 + 9.11 * Math.sqrt(v2) - 1.27 * v2;
  return 12.953 + 10 * Math.log10(v2);
}

// ---- KnifeEdgeDiffraction.cpp
function knifeEdgeDiffraction(d, f_mhz, a_e, theta_los, d_hzn) {
  const d_ML = d_hzn[0] + d_hzn[1];
  const theta_nlos = d / a_e - theta_los;
  const d_nlos = d - d_ML;
  const v_1 = 0.0795775 * (f_mhz / 47.7) * theta_nlos * theta_nlos *
              d_hzn[0] * d_nlos / (d_nlos + d_hzn[0]);
  const v_2 = 0.0795775 * (f_mhz / 47.7) * theta_nlos * theta_nlos *
              d_hzn[1] * d_nlos / (d_nlos + d_hzn[1]);
  return fresnelIntegral(v_1) + fresnelIntegral(v_2);
}

// ---- SmoothEarthDiffraction.cpp
function heightFunction(x_km, K) {
  let w, result;
  if (x_km < 200.0) {
    w = -Math.log(K);
    if (K < 1e-5 || x_km * w * w * w > 5495.0) {
      result = -117.0;
      if (x_km > 1.0) result = 17.372 * Math.log(x_km) + result;
    } else {
      result = 2.5e-5 * x_km * x_km / K - 8.686 * w - 15.0;
    }
  } else {
    result = 0.05751 * x_km - 4.343 * Math.log(x_km);
    if (x_km < 2000) {
      w = 0.0134 * x_km * Math.exp(-0.005 * x_km);
      result = (1.0 - w) * result + w * (17.372 * Math.log(x_km) - 117.0);
    }
  }
  return result;
}

function smoothEarthDiffraction(d, f_mhz, a_e, theta_los, d_hzn, h_e, Z_g) {
  const a = [0, 0, 0], d_km = [0, 0, 0], K = [0, 0, 0];
  const B_0 = [0, 0, 0], x_km = [0, 0, 0], C_0 = [0, 0, 0];
  const theta_nlos = d / a_e - theta_los;
  const d_ML = d_hzn[0] + d_hzn[1];
  a[0] = (d - d_ML) / (d / a_e - theta_los);
  a[1] = 0.5 * d_hzn[0] * d_hzn[0] / h_e[0];
  a[2] = 0.5 * d_hzn[1] * d_hzn[1] / h_e[1];
  d_km[0] = (a[0] * theta_nlos) / 1000.0;
  d_km[1] = d_hzn[0] / 1000.0;
  d_km[2] = d_hzn[1] / 1000.0;
  for (let i = 0; i < 3; i++) {
    C_0[i] = Math.pow((4.0 / 3.0) * A0_METER / a[i], THIRD);
    K[i] = 0.017778 * C_0[i] * Math.pow(f_mhz, -THIRD) / cAbs(Z_g);
    B_0[i] = 1.607 - K[i];
  }
  x_km[1] = B_0[1] * C_0[1] * C_0[1] * Math.pow(f_mhz, THIRD) * d_km[1];
  x_km[2] = B_0[2] * C_0[2] * C_0[2] * Math.pow(f_mhz, THIRD) * d_km[2];
  x_km[0] = B_0[0] * C_0[0] * C_0[0] * Math.pow(f_mhz, THIRD) * d_km[0] + x_km[1] + x_km[2];
  const F_1 = heightFunction(x_km[1], K[1]);
  const F_2 = heightFunction(x_km[2], K[2]);
  const G_x = 0.05751 * x_km[0] - 10.0 * Math.log10(x_km[0]);
  return G_x - F_1 - F_2 - 20;
}

// ---- DiffractionLoss.cpp
function diffractionLoss(d, d_hzn, h_e, Z_g, a_e, delta_h, h, mode, theta_los, d_sML, f_mhz) {
  const A_k = knifeEdgeDiffraction(d, f_mhz, a_e, theta_los, d_hzn);
  const A_se = smoothEarthDiffraction(d, f_mhz, a_e, theta_los, d_hzn, h_e, Z_g);
  const delta_h_dsML = terrainRoughness(d_sML, delta_h);
  const sigma_h_d = sigmaHFunction(delta_h_dsML);
  const A_fo = MINd(15.0, 5 * Math.log10(1.0 + 1e-5 * h[0] * h[1] * f_mhz * sigma_h_d));
  const delta_h_d = terrainRoughness(d, delta_h);
  let q = h[0] * h[1];
  const qk = h_e[0] * h_e[1] - q;
  if (mode === MODE_P2P) q += 10.0;
  const term1 = Math.sqrt(1.0 + qk / q);
  const d_ML = d_hzn[0] + d_hzn[1];
  q = (term1 + (-theta_los * a_e + d_ML) / d) * MINd(delta_h_d * f_mhz / 47.7, 6283.2);
  const w = 25.1 / (25.1 + Math.sqrt(q));
  return w * A_se + (1.0 - w) * A_k + A_fo;
}

// ---- LineOfSightLoss.cpp
function lineOfSightLoss(d, h_e, Z_g, delta_h, M_d, A_d0, d_sML, f_mhz) {
  const delta_h_d = terrainRoughness(d, delta_h);
  const sigma_h_d = sigmaHFunction(delta_h_d);
  const wn = f_mhz / 47.7;
  const sum_he = h_e[0] + h_e[1];
  const sin_psi = sum_he / Math.sqrt(d * d + sum_he * sum_he);
  let R_e = cDiv({ re: sin_psi - Z_g.re, im: -Z_g.im },
                 { re: sin_psi + Z_g.re, im: Z_g.im });
  const atten = Math.exp(-MINd(10.0, wn * sigma_h_d * sin_psi));
  R_e = { re: R_e.re * atten, im: R_e.im * atten };
  const q = R_e.re * R_e.re + R_e.im * R_e.im;
  if (q < 0.25 || q < sin_psi) {
    const scale = Math.sqrt(sin_psi / q);
    R_e = { re: R_e.re * scale, im: R_e.im * scale };
  }
  let delta_phi = wn * 2.0 * h_e[0] * h_e[1] / d;
  if (delta_phi > Math.PI / 2.0)
    delta_phi = Math.PI - Math.pow(Math.PI / 2.0, 2) / delta_phi;
  const rr = { re: Math.cos(delta_phi) + R_e.re, im: -Math.sin(delta_phi) + R_e.im };
  const A_t = -10 * Math.log10(rr.re * rr.re + rr.im * rr.im);
  const A_d = M_d * d + A_d0;
  const w = 1 / (1 + f_mhz * delta_h / MAXd(10e3, d_sML));
  return w * A_t + (1 - w) * A_d;
}

// ---- H0Function.cpp
function h0Curve(j, r) {
  const a = [25.0, 80.0, 177.0, 395.0, 705.0];
  const b = [24.0, 45.0, 68.0, 80.0, 105.0];
  return 10 * Math.log10(1 + a[j] * Math.pow(1 / r, 4) + b[j] * Math.pow(1 / r, 2));
}
function h0Function(r, eta_s) {
  eta_s = MINd(MAXd(eta_s, 1), 5);
  const i = Math.trunc(eta_s);
  const q = eta_s - i;
  let result = h0Curve(i - 1, r);
  if (q !== 0.0) result = (1.0 - q) * result + q * h0Curve(i, r);
  return result;
}

// ---- TroposcatterLoss.cpp
function fFunction(td) {
  const a = [133.4, 104.6, 71.8];
  const b = [0.332e-3, 0.212e-3, 0.157e-3];
  const c = [-10, -2.5, 5];
  const i = td <= 10e3 ? 0 : (td <= 70e3 ? 1 : 2);
  return a[i] + b[i] * td + c[i] * Math.log10(td);
}

function troposcatterLoss(d, theta_hzn, d_hzn, h_e, a_e, N_s, f_mhz, theta_los, h0ref) {
  let H_0;
  const wn = f_mhz / 47.7;
  if (h0ref.h0 > 15.0) {
    H_0 = h0ref.h0;
  } else {
    let ad = d_hzn[0] - d_hzn[1];
    let rr = h_e[1] / h_e[0];
    if (ad < 0.0) { ad = -ad; rr = 1.0 / rr; }
    const theta = theta_hzn[0] + theta_hzn[1] + d / a_e;
    const r_1 = 2.0 * wn * theta * h_e[0];
    const r_2 = 2.0 * wn * theta * h_e[1];
    if (r_1 < 0.2 && r_2 < 0.2) return 1001;
    let s = (d - ad) / (d + ad);
    const q = MINd(MAXd(0.1, rr / s), 10.0);
    s = MAXd(0.1, s);
    const h_0 = (d - ad) * (d + ad) * theta * 0.25 / d;
    const Z_0 = 1.7556e3, Z_1 = 8.0e3;
    const eta_s = (h_0 / Z_0) * (1.0 + (0.031 - N_s * 2.32e-3 + N_s * N_s * 5.67e-6)
                  * Math.exp(-Math.pow(MINd(1.7, h_0 / Z_1), 6)));
    const H_00 = (h0Function(r_1, eta_s) + h0Function(r_2, eta_s)) / 2;
    const Delta_H_0 = MINd(H_00,
      6.0 * (0.6 - Math.log10(MAXd(eta_s, 1.0))) * Math.log10(s) * Math.log10(q));
    H_0 = MAXd(H_00 + Delta_H_0, 0.0);
    if (eta_s < 1.0) {
      const SQRT2 = Math.SQRT2;
      H_0 = eta_s * H_0 + (1.0 - eta_s) * 10 *
        Math.log10(Math.pow((1.0 + SQRT2 / r_1) * (1.0 + SQRT2 / r_2), 2) *
                   (r_1 + r_2) / (r_1 + r_2 + 2 * SQRT2));
    }
    if (H_0 > 15.0 && h0ref.h0 >= 0.0) H_0 = h0ref.h0;
  }
  h0ref.h0 = H_0;
  const th = d / a_e - theta_los;
  const D_0 = 40e3, H_METER = 47.7;
  return fFunction(th * d) + 10 * Math.log10(wn * H_METER * Math.pow(th, 4))
       - 0.1 * (N_s - 301.0) * Math.exp(-th * d / D_0) + H_0;
}

// ---- LongleyRice.cpp
function longleyRice(theta_hzn, f_mhz, Z_g, d_hzn, h_e, gamma_e, N_s, delta_h, h, d, mode) {
  const a_e = 1 / gamma_e;
  const d_hzn_s = [Math.sqrt(2.0 * h_e[0] * a_e), Math.sqrt(2.0 * h_e[1] * a_e)];
  const d_sML = d_hzn_s[0] + d_hzn_s[1];
  const d_ML = d_hzn[0] + d_hzn[1];
  const theta_los = -MAXd(theta_hzn[0] + theta_hzn[1], -d_ML / a_e);

  if (N_s < 150) throw new Error("ITM: surface refractivity too small");
  if (N_s > 400) throw new Error("ITM: surface refractivity too large");
  if (a_e < 4000000 || a_e > 13333333) throw new Error("ITM: effective earth out of range");
  if (Z_g.re <= Math.abs(Z_g.im)) throw new Error("ITM: ground impedance");

  const d_3 = MAXd(d_sML, d_ML + 5.0 * Math.pow(a_e * a_e / f_mhz, THIRD));
  const d_4 = d_3 + 10.0 * Math.pow(a_e * a_e / f_mhz, THIRD);
  const A_3 = diffractionLoss(d_3, d_hzn, h_e, Z_g, a_e, delta_h, h, mode, theta_los, d_sML, f_mhz);
  const A_4 = diffractionLoss(d_4, d_hzn, h_e, Z_g, a_e, delta_h, h, mode, theta_los, d_sML, f_mhz);
  const M_d = (A_4 - A_3) / (d_4 - d_3);
  const A_d0 = A_3 - M_d * d_3;

  let A_ref, propmode;

  if (d < d_sML) {
    const A_sML = d_sML * M_d + A_d0;
    let d_0 = 0.04 * f_mhz * h_e[0] * h_e[1];
    let d_1;
    if (A_d0 >= 0.0) {
      d_0 = MINd(d_0, 0.5 * d_ML);
      d_1 = d_0 + 0.25 * (d_ML - d_0);
    } else {
      d_1 = MAXd(-A_d0 / M_d, 0.25 * d_ML);
    }
    const A_1 = lineOfSightLoss(d_1, h_e, Z_g, delta_h, M_d, A_d0, d_sML, f_mhz);
    let flag = false;
    let k1 = 0, k2 = 0;
    if (d_0 < d_1) {
      const A_0 = lineOfSightLoss(d_0, h_e, Z_g, delta_h, M_d, A_d0, d_sML, f_mhz);
      const q = Math.log(d_sML / d_0);
      k2 = MAXd(0.0, ((d_sML - d_0) * (A_1 - A_0) - (d_1 - d_0) * (A_sML - A_0)) /
                     ((d_sML - d_0) * Math.log(d_1 / d_0) - (d_1 - d_0) * q));
      flag = A_d0 > 0.0 || k2 > 0.0;
      if (flag) {
        k1 = (A_sML - A_0 - k2 * q) / (d_sML - d_0);
        if (k1 < 0.0) {
          k1 = 0.0;
          k2 = DIM(A_sML, A_0) / q;
          if (k2 === 0.0) k1 = M_d;
        }
      }
    }
    if (!flag) {
      k1 = DIM(A_sML, A_1) / (d_sML - d_1);
      k2 = 0.0;
      if (k1 === 0.0) k1 = M_d;
    }
    const A_o = A_sML - k1 * d_sML - k2 * Math.log(d_sML);
    A_ref = A_o + k1 * d + k2 * Math.log(d);
    propmode = MODE_LOS;
  } else {
    const d_5 = d_ML + 200e3;
    const d_6 = d_ML + 400e3;
    const h0ref = { h0: -1 };
    const A_6 = troposcatterLoss(d_6, theta_hzn, d_hzn, h_e, a_e, N_s, f_mhz, theta_los, h0ref);
    const A_5 = troposcatterLoss(d_5, theta_hzn, d_hzn, h_e, a_e, N_s, f_mhz, theta_los, h0ref);
    let M_s, A_s0, d_x;
    if (A_5 < 1000.0) {
      M_s = (A_6 - A_5) / 200e3;
      d_x = MAXd(MAXd(d_sML,
              d_ML + 1.088 * Math.pow(a_e * a_e / f_mhz, THIRD) * Math.log(f_mhz)),
              (A_5 - A_d0 - M_s * d_5) / (M_d - M_s));
      A_s0 = (M_d - M_s) * d_x + A_d0;
    } else {
      M_s = M_d;
      A_s0 = A_d0;
      d_x = 10e6;
    }
    if (d > d_x) {
      A_ref = M_s * d + A_s0;
      propmode = MODE_TROPOSCATTER;
    } else {
      A_ref = M_d * d + A_d0;
      propmode = MODE_DIFFRACTION;
    }
  }
  return { A_ref: MAXd(A_ref, 0.0), propmode };
}

// ---- InverseComplementaryCumulativeDistributionFunction.cpp
function inverseCCDF(q) {
  const C_0 = 2.515516, C_1 = 0.802853, C_2 = 0.010328;
  const D_1 = 1.432788, D_2 = 0.189269, D_3 = 0.001308;
  let x = q;
  if (q > 0.5) x = 1.0 - x;
  const T_x = Math.sqrt(-2.0 * Math.log(x));
  const zeta = ((C_2 * T_x + C_1) * T_x + C_0) /
               (((D_3 * T_x + D_2) * T_x + D_1) * T_x + 1.0);
  let Q_q = T_x - zeta;
  if (q > 0.5) Q_q = -Q_q;
  return Q_q;
}

// ---- Variability.cpp
function curveFn(c1, c2, x1, x2, x3, d_e) {
  return (c1 + c2 / (1.0 + Math.pow((d_e - x2) / x3, 2))) *
         Math.pow(d_e / x1, 2) / (1.0 + Math.pow(d_e / x1, 2));
}

function variability(time, location, situation, h_e, delta_h, f_mhz, d, A_ref, climate, mdvar) {
  const all_year = [
    [-9.67, -0.62, 1.26, -9.21, -0.62, -0.39, 3.15],
    [12.7, 9.19, 15.5, 9.05, 9.19, 2.86, 857.9],
    [144.9e3, 228.9e3, 262.6e3, 84.1e3, 228.9e3, 141.7e3, 2222.e3],
    [190.3e3, 205.2e3, 185.2e3, 101.1e3, 205.2e3, 315.9e3, 164.8e3],
    [133.8e3, 143.6e3, 99.8e3, 98.6e3, 143.6e3, 167.4e3, 116.3e3],
  ];
  const bsm1 = [2.13, 2.66, 6.11, 1.98, 2.68, 6.86, 8.51];
  const bsm2 = [159.5, 7.67, 6.65, 13.11, 7.16, 10.38, 169.8];
  const xsm1 = [762.2e3, 100.4e3, 138.2e3, 139.1e3, 93.7e3, 187.8e3, 609.8e3];
  const xsm2 = [123.6e3, 172.5e3, 242.2e3, 132.7e3, 186.8e3, 169.6e3, 119.9e3];
  const xsm3 = [94.5e3, 136.4e3, 178.6e3, 193.5e3, 133.5e3, 108.9e3, 106.6e3];
  const bsp1 = [2.11, 6.87, 10.08, 3.68, 4.75, 8.58, 8.43];
  const bsp2 = [102.3, 15.53, 9.60, 159.3, 8.12, 13.97, 8.19];
  const xsp1 = [636.9e3, 138.7e3, 165.3e3, 464.4e3, 93.2e3, 216.0e3, 136.2e3];
  const xsp2 = [134.8e3, 143.7e3, 225.7e3, 93.1e3, 135.9e3, 152.0e3, 188.5e3];
  const xsp3 = [95.6e3, 98.6e3, 129.7e3, 94.2e3, 113.4e3, 122.7e3, 122.9e3];
  const C_D = [1.224, 0.801, 1.380, 1.000, 1.224, 1.518, 1.518];
  const z_D = [1.282, 2.161, 1.282, 20.0, 1.282, 1.282, 1.282];
  const bfm1 = [1.0, 1.0, 1.0, 1.0, 0.92, 1.0, 1.0];
  const bfm2 = [0.0, 0.0, 0.0, 0.0, 0.25, 0.0, 0.0];
  const bfm3 = [0.0, 0.0, 0.0, 0.0, 1.77, 0.0, 0.0];
  const bfp1 = [1.0, 0.93, 1.0, 0.93, 0.93, 1.0, 1.0];
  const bfp2 = [0.0, 0.31, 0.0, 0.19, 0.31, 0.0, 0.0];
  const bfp3 = [0.0, 2.00, 0.0, 1.79, 2.00, 0.0, 0.0];

  let z_T = inverseCCDF(time / 100);
  let z_L = inverseCCDF(location / 100);
  const z_S = inverseCCDF(situation / 100);

  const c = climate - 1;
  const wn = f_mhz / 47.7;

  const d_ex = Math.sqrt(2 * A9000_METER * h_e[0]) + Math.sqrt(2 * A9000_METER * h_e[1])
             + Math.pow(575.7e12 / wn, THIRD);
  const d_e = (d < d_ex) ? 130e3 * d / d_ex : 130e3 + d - d_ex;

  let mdv = mdvar;
  const plus20 = mdv >= 20;
  if (plus20) mdv -= 20;
  let sigma_S;
  if (plus20) sigma_S = 0.0;
  else sigma_S = 5.0 + 3.0 * Math.exp(-d_e / 100e3);

  const plus10 = mdv >= 10;
  if (plus10) mdv -= 10;

  const V_med = curveFn(all_year[0][c], all_year[1][c], all_year[2][c],
                        all_year[3][c], all_year[4][c], d_e);

  if (mdv === 0) { z_T = z_S; z_L = z_S; }          // single message
  else if (mdv === 1) z_L = z_S;                    // accidental
  else if (mdv === 2) z_L = z_T;                    // mobile
  // else broadcast

  let sigma_L;
  if (plus10) sigma_L = 0.0;
  else {
    const delta_h_d = terrainRoughness(d, delta_h);
    sigma_L = 10.0 * wn * delta_h_d / (wn * delta_h_d + 13.0);
  }
  const Y_L = sigma_L * z_L;

  const q = Math.log(0.133 * wn);
  const g_minus = bfm1[c] + bfm2[c] / (Math.pow(bfm3[c] * q, 2) + 1.0);
  const g_plus = bfp1[c] + bfp2[c] / (Math.pow(bfp3[c] * q, 2) + 1.0);
  const sigma_T_minus = curveFn(bsm1[c], bsm2[c], xsm1[c], xsm2[c], xsm3[c], d_e) * g_minus;
  const sigma_T_plus = curveFn(bsp1[c], bsp2[c], xsp1[c], xsp2[c], xsp3[c], d_e) * g_plus;
  const sigma_TD = C_D[c] * sigma_T_plus;
  const tgtd = (sigma_T_plus - sigma_TD) * z_D[c];

  let sigma_T;
  if (z_T < 0.0) sigma_T = sigma_T_minus;
  else if (z_T <= z_D[c]) sigma_T = sigma_T_plus;
  else sigma_T = sigma_TD + tgtd / z_T;
  const Y_T = sigma_T * z_T;

  const Y_S_temp = sigma_S * sigma_S + Y_T * Y_T / (7.8 + z_S * z_S)
                 + Y_L * Y_L / (24.0 + z_S * z_S);

  let Y_R, Y_S;
  if (mdv === 0) {
    Y_R = 0.0;
    Y_S = Math.sqrt(sigma_T * sigma_T + sigma_L * sigma_L + Y_S_temp) * z_S;
  } else if (mdv === 1) {
    Y_R = Y_T;
    Y_S = Math.sqrt(sigma_L * sigma_L + Y_S_temp) * z_S;
  } else if (mdv === 2) {
    Y_R = Math.sqrt(sigma_T * sigma_T + sigma_L * sigma_L) * z_T;
    Y_S = Math.sqrt(Y_S_temp) * z_S;
  } else {
    Y_R = Y_T + Y_L;
    Y_S = Math.sqrt(Y_S_temp) * z_S;
  }

  let result = A_ref - V_med - Y_R - Y_S;
  if (result < 0.0) result = result * (29.0 - result) / (29.0 - 10.0 * result);
  return result;
}

// ---- itm_p2p.cpp : ITM_P2P_TLS_Ex
const ITM_MODE_NAMES = { 0: "not set", 1: "line-of-sight", 2: "diffraction", 3: "troposcatter" };

function itmPointToPoint(h_tx, h_rx, pfl, opts = {}) {
  const {
    climate = 5,            // continental temperate
    N0 = 301,               // surface refractivity, N-units
    fMhz = 915,
    pol = 1,                // vertical
    epsilon = 15,           // average ground
    sigma = 0.005,
    mdvar = 12,             // mobile mode + location variability eliminated (P2P convention)
    time = 50, location = 50, situation = 50,
  } = opts;

  const np = Math.trunc(pfl[0]);
  const p10 = Math.trunc(0.1 * np);
  let h_sys = 0;
  for (let i = p10; i <= np - p10; i++) h_sys += pfl[i + 2];
  h_sys = h_sys / (np - 2 * p10 + 1);

  const { Z_g, gamma_e, N_s } = initializePointToPoint(fMhz, h_sys, N0, pol, epsilon, sigma);
  const h = [h_tx, h_rx];
  const { theta_hzn, d_hzn, h_e, delta_h, d } = quickPfl(pfl, gamma_e, h);

  const { A_ref, propmode } = longleyRice(theta_hzn, fMhz, Z_g, d_hzn, h_e,
                                          gamma_e, N_s, delta_h, h, d, MODE_P2P);
  const A_fs = freeSpaceLoss(d, fMhz);
  const A_db = variability(time, location, situation, h_e, delta_h, fMhz, d,
                           A_ref, climate, mdvar) + A_fs;
  return { A_db, Afs: A_fs, Aref: A_ref, mode: ITM_MODE_NAMES[propmode],
           deltaH: delta_h };
}

// ============================================================================
// Delta-Bullington diffraction, in the style of ITU-R P.1812 §4.3 — the model
// family CloudRF defaults to for LoRa/MeshCore coverage. This implements the
// diffraction core (Bullington on the actual profile + spherical-earth
// correction via a smooth-profile Bullington); it deliberately omits P.1812's
// ducting/troposcatter/variability terms and is labeled "-style" for that
// reason. Total path loss = free space + this excess.

function dbJ(v) {
  return v > -0.78
    ? 6.9 + 20 * Math.log10(Math.sqrt((v - 0.1) ** 2 + 1) + v - 0.1)
    : 0;
}

/* Bullington part, P.1812 §4.3.1. d in km (cumulative), h in m ASL,
 * hts/hrs = terminal antenna heights ASL, Ce = 1/a_e (1/km), f in GHz. */
function bullingtonPart(d, h, hts, hrs, Ce, fGhz) {
  const n = d.length - 1;
  const dtot = d[n];
  const lam = 0.2998 / fGhz;                 // wavelength, meters
  let Stim = -Infinity;
  for (let i = 1; i < n; i++) {
    const s = (h[i] + 500 * Ce * d[i] * (dtot - d[i]) - hts) / d[i];
    if (s > Stim) Stim = s;
  }
  const Str = (hrs - hts) / dtot;
  let Luc = 0;
  if (Stim < Str) {                          // LOS: check worst Fresnel intrusion
    let vmax = -Infinity;
    for (let i = 1; i < n; i++) {
      const v = (h[i] + 500 * Ce * d[i] * (dtot - d[i])
                - (hts * (dtot - d[i]) + hrs * d[i]) / dtot)
              * Math.sqrt(0.002 * dtot / (lam * d[i] * (dtot - d[i])));
      if (v > vmax) vmax = v;
    }
    Luc = dbJ(vmax);
  } else {                                   // trans-horizon: Bullington point
    let Srim = -Infinity;
    for (let i = 1; i < n; i++) {
      const s = (h[i] + 500 * Ce * d[i] * (dtot - d[i]) - hrs) / (dtot - d[i]);
      if (s > Srim) Srim = s;
    }
    const db = (hrs - hts + Srim * dtot) / (Stim + Srim);
    const vb = (hts + Stim * db - (hts * (dtot - db) + hrs * db) / dtot)
             * Math.sqrt(0.002 * dtot / (lam * db * (dtot - db)));
    Luc = dbJ(vb);
  }
  return Luc + (1 - Math.exp(-Luc / 6.0)) * (10 + 0.02 * dtot);
}

/* Spherical-earth diffraction first-term estimate, ITU-R P.526 §4.2.
 * dtot km, he in m, ae km, f GHz. Returns loss in dB (>= 0). */
function sphericalEarthLoss(dtot, he1, he2, ae, fGhz) {
  const dlos = Math.sqrt(2 * ae) * (Math.sqrt(0.001 * Math.max(he1, 1)) +
                                    Math.sqrt(0.001 * Math.max(he2, 1)));
  if (dtot < 0.8 * dlos) return 0;
  const beta = 1;                            // valid above ~300 MHz
  const X = 21.88 * beta * Math.pow(fGhz / (ae * ae), 1 / 3) * dtot;
  const Yc = 0.9575 * beta * Math.pow(fGhz * fGhz / ae, 1 / 3);
  const G = y => y > 2
    ? 17.6 * Math.sqrt(y - 1.1) - 5 * Math.log10(y - 1.1) - 8
    : Math.max(20 * Math.log10(y + 0.1 * y * y * y), -40);
  const FX = X >= 1.6
    ? 11 + 10 * Math.log10(X) - 17.6 * X
    : -20 * Math.log10(X) - 5.6488 * Math.pow(X, 1.425);
  const loss = -(FX + G(Yc * Math.max(he1, 1)) + G(Yc * Math.max(he2, 1)));
  return Math.max(loss, 0);
}

/* Delta-Bullington excess loss over free space.
 * pfl = classic profile [n, step_m, elevations...], hTx/hRx in m AGL. */
function deltaBullingtonLoss(hTx, hRx, pfl, fMhz) {
  const n = Math.trunc(pfl[0]);
  const step_km = pfl[1] / 1000;
  const fGhz = fMhz / 1000;
  const ae = 8500;                           // median effective earth, km
  const Ce = 1 / ae;
  const d = new Array(n + 1), h = new Array(n + 1);
  for (let i = 0; i <= n; i++) { d[i] = i * step_km; h[i] = pfl[i + 2]; }
  const dtot = d[n];
  const hts = h[0] + hTx, hrs = h[n] + hRx;

  const Lbulla = bullingtonPart(d, h, hts, hrs, Ce, fGhz);

  // least-squares smooth surface, P.1812 Attachment 1 §5
  let v1 = 0, v2 = 0;
  for (let i = 1; i <= n; i++) {
    const di = d[i] - d[i - 1];
    v1 += di * (h[i] + h[i - 1]);
    v2 += di * (h[i] * (2 * d[i] + d[i - 1]) + h[i - 1] * (d[i] + 2 * d[i - 1]));
  }
  let hst = (2 * v1 * dtot - v2) / (dtot * dtot);
  let hsr = (v2 - v1 * dtot) / (dtot * dtot);
  hst = Math.min(hst, h[0]);                 // may not exceed ground at ends
  hsr = Math.min(hsr, h[n]);

  const zeros = new Array(n + 1).fill(0);
  const Lbulls = bullingtonPart(d, zeros, hts - hst, hrs - hsr, Ce, fGhz);
  const Ldsph = sphericalEarthLoss(dtot, hts - hst, hrs - hsr, ae, fGhz);

  return Lbulla + Math.max(Ldsph - Lbulls, 0);
}

global.itmPointToPoint = itmPointToPoint;
global.deltaBullingtonLoss = deltaBullingtonLoss;
if (typeof module !== "undefined" && module.exports) {
  module.exports = { itmPointToPoint, deltaBullingtonLoss };
}

})(typeof window !== "undefined" ? window : globalThis);
