#!/usr/bin/env node
// Scripted play session (local development): node tools/hitman-play.mjs --port 5191 --script "wait:6000,click:770:748,shot:a,key:Enter,wait:600,shot:b"
// Steps: wait:<frames>, click:<x>:<y>, move:<x>:<y>, key:<Code>, shot:<name> (screenshot to work/play/<name>.png), settle:<ms>.
import { mkdirSync } from "node:fs";
import { browserArgs, launch } from "./browsers.mjs";

const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);
const port = opt("port", "5191");
const steps = opt("script", "").split(",").filter(Boolean);
const query = opt("query", "devGame&autoplay");
mkdirSync("work/play", { recursive: true });
const ctx = await launch({ ...browserArgs(args), port });
const page = ctx.pages()[0] ?? (await ctx.newPage());
page.on("pageerror", (e) => console.log("pageerror:", e.message));
await page.goto(`http://localhost:${port}/?${query}`);
const frames = () => page.evaluate(() => window.__bella?.frames ?? 0);
let logAt = 0;
const flush = async () => {
  const l = await page.evaluate((from) => (window.__bella?.log ?? []).slice(from), logAt);
  logAt += l.length;
  for (const x of l) if (!/LoadLibrary|COM IDirectSound|QueryInterface/.test(x)) console.log("engine:", x.slice(0, 220));
};
for (const s of steps) {
  const [k, a, b] = s.split(":");
  if (k === "wait") {
    const target = (await frames()) + Number(a);
    const t0 = Date.now();
    while ((await frames()) < target && Date.now() - t0 < 240000) {
      await page.waitForTimeout(500);
      await flush();
    }
  } else if (k === "click") {
    await page.mouse.move(Number(a), Number(b));
    await page.waitForTimeout(150);
    await page.mouse.down();
    await page.waitForTimeout(120);
    await page.mouse.up();
  } else if (k === "move") {
    await page.mouse.move(Number(a), Number(b), { steps: 12 });
  } else if (k === "key") {
    await page.keyboard.down(a);
    await page.waitForTimeout(120);
    await page.keyboard.up(a);
  } else if (k === "type") {
    await page.keyboard.type(a, { delay: 150 });
  } else if (k === "shot") {
    await page.screenshot({ path: `work/play/${a}.png` });
  } else if (k === "settle") {
    await page.waitForTimeout(Number(a));
  }
  await flush();
}
console.log("frames:", await frames());
await ctx.close();
