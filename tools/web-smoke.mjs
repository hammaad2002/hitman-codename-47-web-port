#!/usr/bin/env node
// Headless browser smoke test for the web build (local development only).
//   node tools/web-smoke.mjs [--seconds 120] [--query "devIso&autoplay&capture=300,600"] [--port 5174]
//                            [--browser chrome|firefox|webkit] [--angle vulkan|gl|swiftshader] [--headed]
// Start the dev server for it with: cd web && npx vite --port 5174 (5173 is left for interactive use).
// Each port is its own origin, so its OPFS install is separate.
// Browsers and profiles: see tools/browsers.mjs.
// Captured frames go to work/web-frames/.
import { mkdirSync, writeFileSync } from "node:fs";
import { browserArgs, launch } from "./browsers.mjs";

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const seconds = Number(opt("seconds", "480"));
const minFrames = Number(opt("min-frames", "0"));
const query = opt("query", "devIso&autoplay&capture=300,600");
const capMatch = /(?:^|&)capture=([0-9,]+)/.exec(query);
const expectedCaps = capMatch ? capMatch[1].split(",").filter(Boolean) : [];
const port = opt("port", "5174");
const url = `http://localhost:${port}/?${query}`;
const outDir = "work/web-frames";
mkdirSync(outDir, { recursive: true });

const ctx = await launch({ ...browserArgs(args), port });
const page = (ctx.pages().length === 1 && ctx.pages()[0].url() === "about:blank")
  ? ctx.pages()[0]
  : (await ctx.newPage());
const t0 = Date.now();
const stamp = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(6);
page.on("console", (m) => {
  const t = m.text();
  console.log(`${stamp()} console.${m.type()}: ${t}`);
});
page.on("pageerror", (e) => console.log(`${stamp()} pageerror: ${e.message}\n${e.stack ?? ""}`));
page.on("crash", () => console.log(`${stamp()} page crashed`));

await page.goto(url);
await page.waitForLoadState("domcontentloaded");
let gl = "unknown";
for (let attempt = 0; attempt < 5; attempt++) {
  try {
    gl = await page.evaluate(() => {
      const c = document.createElement("canvas").getContext("webgl2");
      const d = c && c.getExtension("WEBGL_debug_renderer_info");
      return c ? `${c.getParameter(d ? d.UNMASKED_RENDERER_WEBGL : c.RENDERER)}` : "no webgl2";
    });
    break;
  } catch (e) {
    await page.waitForTimeout(500);
  }
}
console.log(`${stamp()} WebGL2 renderer: ${gl}`);

// --blur-at / --focus-at <seconds after the game starts running>: simulate the window losing and
// regaining focus (as when clicking another application).
const blurAt = Number(opt("blur-at", "-1"));
const focusAt = Number(opt("focus-at", "-1"));
let runningSince = 0;
let blurred = false, focused = false;
let lastState = "";
let lastStatus = "";
let lastFrames = -1;
let lastLogLen = 0;
let saved = new Set();
const deadline = Date.now() + seconds * 1000;
while (Date.now() < deadline) {
  await page.waitForTimeout(2000);
  const s = await page.evaluate((from) => {
    const d = window.__bella;
    if (!d) return { state: "loading", frames: 0, status: document.getElementById("status")?.textContent ?? "", logLen: 0, caps: [], newLogs: [] };
    const newLogs = d.log ? d.log.slice(from) : [];
    return { state: d.state, frames: d.frames, status: document.getElementById("status")?.textContent ?? "", logLen: d.log?.length ?? 0, caps: Object.keys(d.captures ?? {}), newLogs };
  }, lastLogLen);
  lastLogLen = s.logLen;
  for (const l of s.newLogs) console.log(`${stamp()} engine: ${l}`);
  if (s.state === "running" && !runningSince) runningSince = Date.now();
  const ranFor = runningSince ? (Date.now() - runningSince) / 1000 : -1;
  if (blurAt >= 0 && !blurred && ranFor >= blurAt) {
    blurred = true;
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    console.log(`${stamp()} >>> window blur (frames ${s.frames})`);
  }
  if (focusAt >= 0 && !focused && ranFor >= focusAt) {
    focused = true;
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    console.log(`${stamp()} >>> window focus (frames ${s.frames})`);
  }
  if (s.state !== lastState || (s.state !== "running" && s.status !== lastStatus)) console.log(`${stamp()} state: ${s.state} (${s.status})`);
  lastStatus = s.status;
  if (s.frames !== lastFrames && s.state === "running") console.log(`${stamp()} frames presented: ${s.frames}`);
  lastState = s.state;
  lastFrames = s.frames;
  for (const k of s.caps) {
    if (saved.has(k)) continue;
    const data = await page.evaluate((key) => window.__bella.captures[key], k);
    writeFileSync(`${outDir}/frame_${String(k).padStart(5, "0")}.png`, Buffer.from(data.split(",")[1], "base64"));
    saved.add(k);
    console.log(`${stamp()} saved ${outDir}/frame_${String(k).padStart(5, "0")}.png`);
  }
  const focusTestPending = (blurAt >= 0 && !blurred) || (focusAt >= 0 && !focused);
  if (!focusTestPending) {
    if (expectedCaps.length > 0 && expectedCaps.every((k) => saved.has(k)) && s.frames >= minFrames) break;
    else if (expectedCaps.length === 0 && minFrames > 0 && s.frames >= minFrames) break;
  }
  if (s.state === "error") {
    console.log(`${stamp()} loop break: s.state === "error"`);
    break;
  }
}
console.log(`${stamp()} finished loop: deadline_passed=${Date.now() >= deadline}`);
const engineLog = await page.evaluate(() => window.__bella?.log?.join("\n") ?? "");
writeFileSync("work/web-engine.log", engineLog);
console.log("---- engine log (tail; full log in work/web-engine.log) ----\n" + engineLog.split("\n").slice(-40).join("\n"));
const shellLog = await page.evaluate(() => document.getElementById("log").innerText);
if (shellLog) console.log("---- shell log ----\n" + shellLog);
await ctx.close();
