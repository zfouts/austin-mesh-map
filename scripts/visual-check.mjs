/* Real-browser pre-deploy check: loads the app in headless Chromium and
 * asserts RENDERED state, not just DOM attributes — this is the layer that
 * catches "CSS display beats the hidden attribute" class bugs.
 *
 * Usage: node scripts/visual-check.mjs [baseUrl]
 * Default baseUrl http://localhost:8931 (start `npx wrangler dev --port 8931`).
 */
import { chromium } from "playwright";

const BASE = process.argv[2] || "http://localhost:8931";
let fails = 0;
const check = (name, ok) => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}`);
  if (!ok) fails++;
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 850 } });
const pageErrors = [];
page.on("pageerror", e => pageErrors.push(String(e)));

await page.goto(BASE, { waitUntil: "networkidle", timeout: 45000 });
await page.waitForTimeout(1200);

// --- the bug class that bit us: modal must not RENDER on load
check("modal backdrop not visible on load", !(await page.isVisible("#modalBack")));
check("sidebar visible", await page.isVisible("#panel"));
check("map has leaflet tiles", await page.locator(".leaflet-tile").count() > 0);
check("coverage tab content visible", await page.isVisible("#updateBtn"));
check("status line empty (no script error)",
  !/Script error/.test(await page.textContent("#status")));
check("elevation profile panel not visible before inspect",
  !(await page.isVisible("#profile")));

// --- tabs render exclusively
await page.click("#tabBtn-network");
check("network tab visible after click", await page.isVisible("#repeaterBtn"));
check("coverage tab hidden after switch", !(await page.isVisible("#updateBtn")));
await page.click("#tabBtn-settings");
check("settings selects visible", await page.isVisible("#pathModel"));

// --- modal opens, closes via Esc, stays closed
await page.click("#tabBtn-community");
await page.click("#potProposeBtn");
check("modal opens on Propose", await page.isVisible("#modalBack"));
check("form fields rendered in modal", await page.isVisible("#potAddress"));
await page.click("#modalMin");
await page.waitForTimeout(150);
check("minimize hides form body", !(await page.isVisible("#potAddress")));
check("minimized bar still visible", await page.isVisible("#modalBar"));
await page.click("#modalMin");
await page.waitForTimeout(150);
check("restore brings form back", await page.isVisible("#potAddress"));
const card = await page.locator("#modalCard").boundingBox();
check("floating card leaves most of the map exposed",
  card !== null && card.width < 620);
await page.keyboard.press("Escape");
await page.waitForTimeout(150);
check("Esc closes modal", !(await page.isVisible("#modalBack")));

// --- coverage compute end-to-end: click map, wait for overlay + legend
await page.click("#tabBtn-coverage");
await page.mouse.click(760, 420);
await page.waitForFunction(
  () => /Done|tiles failed/.test(document.getElementById("status").textContent),
  { timeout: 90000 });
check("coverage computes from a map click",
  /Done/.test(await page.textContent("#status")));
check("legend appears after compute", await page.isVisible("#legend"));
check("overlay image on map", await page.locator(".leaflet-image-layer").count() > 0);

// --- community list view
await page.click("#tabBtn-community");
await page.click("#potListToggle");
await page.waitForTimeout(1200);
check("list view toggles open", await page.isVisible("#potList"));

// --- permalinks
await page.goto(BASE + "/#network", { waitUntil: "networkidle" });
await page.waitForTimeout(600);
check("#network permalink opens Network tab", await page.isVisible("#repeaterBtn"));
await page.click("#tabBtn-community");
check("tab click updates hash", (await page.evaluate(() => location.hash)) === "#community");

check("no page errors", pageErrors.length === 0);
if (pageErrors.length) console.log(pageErrors.join("\n"));

await page.screenshot({ path: "/tmp/amm-visual.png" });
console.log(`\nscreenshot: /tmp/amm-visual.png — ${fails ? fails + " FAILURES" : "all clear"}`);
await browser.close();
process.exit(fails ? 1 : 0);
