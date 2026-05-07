// Copies non-TS assets (currently just schema.sql) from src/ into dist/
// so runtime imports via fileURLToPath(import.meta.url) resolve correctly.
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const assets = [["src/db/schema.sql", "dist/db/schema.sql"]];

for (const [from, to] of assets) {
  const src = resolve(root, from);
  const dst = resolve(root, to);
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(src, dst);
  console.log(`copied ${from} -> ${to}`);
}
