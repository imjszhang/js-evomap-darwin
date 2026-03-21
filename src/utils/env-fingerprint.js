import { platform, arch, version as nodeVersion } from "node:process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function getPkgVersion() {
  try {
    const pkg = JSON.parse(
      readFileSync(join(__dirname, "..", "..", "package.json"), "utf-8"),
    );
    return pkg.version;
  } catch {
    return "0.0.0";
  }
}

export function getEnvFingerprint() {
  return {
    platform: platform,
    arch: arch,
    node_version: nodeVersion,
    darwin_version: getPkgVersion(),
  };
}
