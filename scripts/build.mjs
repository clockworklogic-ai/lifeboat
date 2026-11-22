import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const siteDir = path.join(root, "site");
fs.mkdirSync(siteDir, { recursive: true });

const esbuildBin = process.env.ESBUILD_BIN || "esbuild";
execFileSync(
  esbuildBin,
  [
    path.join(root, "src/app.js"),
    "--bundle",
    "--format=iife",
    "--target=es2022",
    "--minify",
    "--outfile=" + path.join(siteDir, "app.js"),
  ],
  { stdio: "inherit" }
);

const stat = fs.statSync(path.join(siteDir, "app.js"));
const kb = (stat.size / 1024).toFixed(1);
console.log(`built site/app.js (${kb} KB)`);
