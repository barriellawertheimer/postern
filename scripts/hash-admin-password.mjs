#!/usr/bin/env node
// One-shot CLI: prompts for an admin password (no echo) and prints the
// scrypt-encoded hash to stdout. Paste the result into .env as
// ADMIN_PASSWORD_HASH. Never invoked at runtime.
//
// Usage:
//   npm run hash:admin                          # interactive
//   echo "mypw" | npm run hash:admin --silent   # piped (for tests)

import { createInterface } from "node:readline";
import { stdin, stdout, stderr, exit } from "node:process";
import { hashPasswordForSetup } from "../src/admin/auth.ts";

async function readSecret(prompt) {
  // Piped input: read stdin to first newline.
  if (!stdin.isTTY) {
    return await new Promise((resolve) => {
      let buf = "";
      stdin.setEncoding("utf8");
      stdin.on("data", (chunk) => {
        buf += chunk;
        const nl = buf.indexOf("\n");
        if (nl >= 0) {
          stdin.pause();
          resolve(buf.slice(0, nl).replace(/\r$/, ""));
        }
      });
      stdin.on("end", () => resolve(buf.replace(/\r?\n$/, "")));
    });
  }
  // TTY: prompt with no echo via the readline `_writeToOutput` shim.
  return await new Promise((resolve) => {
    const rl = createInterface({ input: stdin, output: stdout, terminal: true });
    let prompted = false;
    // @ts-ignore — internal but stable across Node 18+.
    const orig = rl._writeToOutput;
    // @ts-ignore
    rl._writeToOutput = function (s) {
      if (!prompted) {
        prompted = true;
        orig.call(this, s);
      }
      // swallow keystroke echoes
    };
    rl.question(prompt, (answer) => {
      rl.close();
      stdout.write("\n");
      resolve(answer);
    });
  });
}

const pw = await readSecret("Admin password: ");
if (!pw || pw.length < 8) {
  stderr.write("password must be at least 8 characters\n");
  exit(2);
}
const confirm = stdin.isTTY ? await readSecret("Confirm:         ") : pw;
if (pw !== confirm) {
  stderr.write("passwords did not match\n");
  exit(2);
}

stdout.write(`${hashPasswordForSetup(pw)}\n`);
