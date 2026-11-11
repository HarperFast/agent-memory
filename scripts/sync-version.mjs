// Run by `npm version`: writes the new package.json version into src/version.ts, the version the running plugin
// advertises to other apps.
import { readFileSync, writeFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
writeFileSync(new URL('../src/version.ts', import.meta.url), `export const PACKAGE_VERSION = '${version}';\n`);
