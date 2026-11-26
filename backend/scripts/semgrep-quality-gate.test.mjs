import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { countFindings } from "./semgrep-quality-gate.mjs";

function report(results, rules = []) {
  return { version: "2.1.0", runs: [{ tool: { driver: { rules } }, results }] };
}

test("distingue un escaneo limpio, un warning, un hallazgo alto y un error técnico", () => {
  const cases = [
    { input: report([]), status: 0, message: /0 altos\/críticos/ },
    { input: report([{ ruleId: "aviso", level: "warning" }]), status: 0, message: /1 warnings/ },
    { input: report([{ ruleId: "alta-o-critica", level: "error" }]), status: 1, message: /1 altos\/críticos/ },
    { input: { version: "2.1.0", runs: [] }, status: 2, message: /Error al evaluar el informe/ },
  ];
  const directory = mkdtempSync(join(tmpdir(), "m6-sarif-"));
  const fixture = join(directory, "report.sarif");
  const script = fileURLToPath(new URL("./semgrep-quality-gate.mjs", import.meta.url));
  try {
    for (const { input, status, message } of cases) {
      writeFileSync(fixture, JSON.stringify(input));
      const run = spawnSync(process.execPath, [script, fixture], { encoding: "utf8" });
      assert.ifError(run.error);
      assert.equal(run.status, status);
      assert.match(run.stdout + run.stderr, message);
    }
  } finally {
    unlinkSync(fixture);
    rmdirSync(directory);
  }
});

test("usa el nivel de la regla y respeta la severidad explícita del resultado", () => {
  const rules = [{ id: "regla", defaultConfiguration: { level: "error" } }];
  const result = countFindings(report([{ ruleId: "regla" }, { ruleId: "regla", level: "warning" }], rules));
  assert.equal(result.error, 1);
  assert.equal(result.warning, 1);
});

test("sólo cuenta como activos los hallazgos cuya supresión no fue aceptada", () => {
  const entries = [
    { ruleId: "aceptado", level: "error", suppressions: [{ kind: "inSource" }] },
    { ruleId: "pendiente", level: "error", suppressions: [{ kind: "external", status: "underReview" }] },
  ];
  const result = countFindings(report(entries));
  assert.equal(result.error, 1);
  assert.equal(result.suppressed, 1);
});
