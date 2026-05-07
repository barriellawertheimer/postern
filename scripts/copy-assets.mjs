// Copies non-TS assets from src/ into dist/ so runtime imports via
// fileURLToPath(import.meta.url) resolve correctly.
//
// Also copies the built admin-ui SPA bundle (admin-ui/dist) into
// dist/admin-ui when present. The static plugin tolerates this being
// absent — admin can be enabled before the UI has been built.
import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

const fileAssets = [["src/db/schema.sql", "dist/db/schema.sql"]];

for (const [from, to] of fileAssets) {
  const src = resolve(root, from);
  const dst = resolve(root, to);
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(src, dst);
  console.log(`copied ${from} -> ${to}`);
}

const adminUiSrc = resolve(root, "admin-ui/dist");
const adminUiDst = resolve(root, "dist/admin-ui");
if (existsSync(adminUiSrc)) {
  rmSync(adminUiDst, { recursive: true, force: true });
  cpSync(adminUiSrc, adminUiDst, { recursive: true });
  console.log(`copied admin-ui/dist -> dist/admin-ui`);
} else {
  console.log("skipped: admin-ui/dist not built (run `npm run build:admin` first)");
}
