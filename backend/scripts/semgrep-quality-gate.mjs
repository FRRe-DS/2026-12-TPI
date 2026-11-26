import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function countFindings(report) {
  if (report?.version !== "2.1.0" || !Array.isArray(report.runs) || report.runs.length === 0) {
    throw new Error("se esperaba un informe SARIF 2.1.0 con al menos una ejecución");
  }

  const counts = { error: 0, warning: 0, note: 0, none: 0, suppressed: 0 };
  for (const run of report.runs) {
    if (!Array.isArray(run?.results)) {
      throw new Error("la ejecución SARIF no contiene una lista de resultados");
    }
    const rules = new Map((run.tool?.driver?.rules ?? []).map((rule) => [rule.id, rule]));

    for (const result of run.results) {
      if (!result || typeof result.ruleId !== "string" || !result.ruleId) {
        throw new Error("un resultado SARIF no identifica su regla");
      }
      if (result.suppressions?.some((entry) => entry.status === undefined || entry.status === "accepted")) {
        counts.suppressed++;
        continue;
      }

      const level = result.level ?? rules.get(result.ruleId)?.defaultConfiguration?.level ?? "warning";
      if (!["error", "warning", "note", "none"].includes(level)) {
        throw new Error(`nivel SARIF inválido: ${level}`);
      }
      counts[level]++;
    }
  }
  return counts;
}

function runGate(reportPath) {
  let counts;
  try {
    counts = countFindings(JSON.parse(readFileSync(reportPath, "utf8")));
  } catch (error) {
    console.error(`Error al evaluar el informe de Semgrep: ${error.message}`);
    return 2;
  }

  // Semgrep representa HIGH, CRITICAL y el antiguo ERROR como error en SARIF.
  console.log(`Semgrep: ${counts.error} altos/críticos, ${counts.warning} warnings, ${counts.note + counts.none} informativos, ${counts.suppressed} suprimidos.`);
  if (counts.error > 0) {
    console.error("Quality Gate: revisar los hallazgos altos o críticos en el informe SARIF.");
    return 1;
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runGate(process.argv[2]);
}
