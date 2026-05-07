// Guard wrapper: builds the admin SPA if `admin-ui/` is present, otherwise
// no-ops cleanly. Lets users who only need the contact backend run
// `npm run build` without scaffolding the UI directory.

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const adminUiDir = resolve(root, "admin-ui");
const adminUiPkg = resolve(adminUiDir, "package.json");

if (!existsSync(adminUiPkg)) {
  console.log("skipped admin UI build: admin-ui/package.json not present");
  process.exit(0);
}

const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";

// Install if node_modules is missing (cold checkout).
if (!existsSync(resolve(adminUiDir, "node_modules"))) {
  console.log("installing admin-ui dependencies (npm ci)...");
  const inst = spawnSync(npmCmd, ["ci"], { cwd: adminUiDir, stdio: "inherit", shell: true });
  if (inst.status !== 0) process.exit(inst.status ?? 1);
}

console.log("building admin-ui...");
const build = spawnSync(npmCmd, ["run", "build"], { cwd: adminUiDir, stdio: "inherit", shell: true });
process.exit(build.status ?? 1);
