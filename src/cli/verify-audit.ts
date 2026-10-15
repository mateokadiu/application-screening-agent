import { verifyAuditFile } from "../infra/audit.ts";

const file = process.argv[2] ?? "output/audit.jsonl";
const result = verifyAuditFile(file);
if (result.ok) {
  console.log(`✓ ${file}: ${result.count} entries, hash chain intact`);
} else {
  console.error(`✗ ${file}: line ${result.line}: ${result.problem}`);
  process.exit(1);
}
