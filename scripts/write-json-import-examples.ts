/**
 * Writes docs/json-import-examples/*.json from lib/json-import-examples.ts
 * (the one source; scripts/verify-json-import.ts asserts they match).
 *   npx tsx scripts/write-json-import-examples.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { JSON_IMPORT_EXAMPLES, jsonImportExampleText, type JsonImportExampleId } from "@/lib/json-import-examples";

const dir = path.join(process.cwd(), "docs", "json-import-examples");
mkdirSync(dir, { recursive: true });
for (const id of Object.keys(JSON_IMPORT_EXAMPLES) as JsonImportExampleId[]) {
  writeFileSync(path.join(dir, `${id}.json`), jsonImportExampleText(id));
  console.log(`wrote docs/json-import-examples/${id}.json`);
}
