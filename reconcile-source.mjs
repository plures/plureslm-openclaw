import { DatabaseSync } from "node:sqlite";
const src = new DatabaseSync("C:\\Users\\kbristol\\.openclaw\\memory\\main.sqlite", { readOnly: true });

const total = src.prepare("SELECT COUNT(*) n FROM chunks").get().n;
const emptyText = src.prepare("SELECT COUNT(*) n FROM chunks WHERE text IS NULL OR TRIM(text)=''").get().n;
const noId = src.prepare("SELECT COUNT(*) n FROM chunks WHERE id IS NULL").get().n;
const nonEmpty = src.prepare("SELECT COUNT(*) n FROM chunks WHERE id IS NOT NULL AND TRIM(COALESCE(text,''))<>''").get().n;

console.log(JSON.stringify({ total, emptyText, noId, nonEmpty }, null, 2));
console.log("EXPECTED: nonEmpty should ≈ imported(1084)+refused(11) = 1095; emptyText should ≈ skipped(597)");
console.log(`RECONCILE: nonEmpty(${nonEmpty}) vs imported+refused(1095) => ${nonEmpty === 1095 ? "EXACT" : "DELTA=" + (nonEmpty - 1095)}`);
console.log(`RECONCILE: emptyText(${emptyText}) vs skipped(597) => ${emptyText === 597 ? "EXACT" : "DELTA=" + (emptyText - 597)}`);
src.close();
