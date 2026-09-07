import { cp, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const source = resolve("packages/extension");
const target = resolve("dist/extension");
await mkdir(target, { recursive: true });
await cp(resolve(source, "manifest.json"), resolve(target, "manifest.json"));
await cp(resolve(source, "popup.html"), resolve(target, "popup.html"));
await cp(resolve(source, "popup.css"), resolve(target, "popup.css"));
for (const file of ["service-worker.js", "lunch-money-content.js", "banner.css", "fortuneo-adapter.js", "fortuneo-content.js", "popup.js"]) {
  await cp(resolve(source, "src", file), resolve(target, file));
}
