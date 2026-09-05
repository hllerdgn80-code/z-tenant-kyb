// Can this @terminal3/t3n-sdk build the verified trust anchor for an environment?
// Run by run.sh inside a temp dir where exactly one SDK version is installed next to this file.
// One line of output: "OK   <sdk version>  <env>  ..." or "FAIL <sdk version>  <env>  <error>"; exit 1 on FAIL.
import { readFileSync } from "node:fs";
import * as sdk from "@terminal3/t3n-sdk";

const env = process.argv[2] ?? "testnet";
const pkg = new URL("./node_modules/@terminal3/t3n-sdk/package.json", import.meta.url);
const version = JSON.parse(readFileSync(pkg, "utf8")).version;

try {
  if (typeof sdk.fetchTrustedManifest !== "function") throw new Error("fetchTrustedManifest is not exported by this version");
  const anchor = await sdk.fetchTrustedManifest(env);
  console.log(`OK   ${version}  ${env}  anchor keys: ${Object.keys(anchor).join(", ")}`);
} catch (e) {
  console.log(`FAIL ${version}  ${env}  ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
}
