/**
 * Fails if anything that must stay on the server is found in the files the
 * browser downloads: the Railway API host, the names of the secret variables,
 * or the secret values themselves (read from the environment or .env.local,
 * never printed). Run after `next build`.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const CLIENT_BUNDLE = join(ROOT, ".next", "static");
const SECRET_NAMES = ["RAILWAY_SANDBOX_TOKEN", "CONSOLE_PASSPHRASE", "SESSION_SECRET"];
/** Shorter values would match ordinary text by chance. */
const MIN_VALUE_LENGTH = 8;

if (!existsSync(CLIENT_BUNDLE)) {
  console.error("check-bundle: no .next/static directory. Run `npm run build` first.");
  process.exit(1);
}
if (existsSync(join(ROOT, ".env.local"))) process.loadEnvFile(join(ROOT, ".env.local"));

const forbidden = new Map<string, string>([
  ["backboard.railway.com", "the Railway API host"],
  ["Project-Access-Token", "the Railway auth header"],
  ...SECRET_NAMES.map((name): [string, string] => [name, `the variable name ${name}`]),
]);
for (const name of SECRET_NAMES) {
  const value = process.env[name];
  if (value && value.length >= MIN_VALUE_LENGTH) forbidden.set(value, `the value of ${name}`);
}

const files = readdirSync(CLIENT_BUNDLE, { recursive: true, encoding: "utf8" })
  .map((name) => join(CLIENT_BUNDLE, name))
  .filter((path) => /\.(js|css|json|map|html|txt)$/.test(path));

const leaks: string[] = [];
for (const file of files) {
  const content = readFileSync(file, "utf8");
  for (const [needle, description] of forbidden) {
    if (content.includes(needle)) leaks.push(`${file.replace(`${ROOT}/`, "")} contains ${description}`);
  }
}

if (leaks.length > 0) {
  console.error(`check-bundle: FAILED\n  ${leaks.join("\n  ")}`);
  process.exit(1);
}
console.log(`check-bundle: ok. ${files.length} client files checked for ${forbidden.size} forbidden strings.`);
