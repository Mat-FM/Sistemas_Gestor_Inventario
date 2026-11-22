"""Lee results/<ID>_stats.csv de cada prueba y escribe RESULTADOS.md con el veredicto frente a RNF06:
percentil 95 menor que 2 s y menos de 1 % de errores."""
import csv
import os
import sys
from datetime import datetime
from pathlib import Path

from escenarios import ESCENARIOS

AQUI = Path(__file__).resolve().parent
P95_MAXIMO_MS = 2000
ERRORES_MAXIMO = 0.01


def leer(id_escenario):
    archivo = AQUI / "results" / f"{id_escenario}_stats.csv"
    if not archivo.exists():
        return None, []
    with archivo.open(encoding="utf-8") as f:
        filas = list(csv.DictReader(f))
    total = next((f for f in filas if f["Name"] == "Aggregated"), None)
    return total, [f for f in filas if f["Name"] != "Aggregated"]


def via_de(id_escenario):
    archivo = AQUI / "results" / f"{id_escenario}.via"
    return archivo.read_text(encoding="utf-8").strip() if archivo.exists() else "—"


def numero(fila, columna):
    try:
        return float(fila[columna])
    except (KeyError, TypeError, ValueError):
        return 0.0


def veredicto(escenario, total):
    peticiones = numero(total, "Request Count")
    if peticiones == 0:
        return "SIN DATOS"
    cumple = numero(total, "95%") < P95_MAXIMO_MS and numero(total, "Failure Count") / peticiones < ERRORES_MAXIMO
    if escenario["obligatorio"]:
        return "CUMPLE" if cumple else "NO CUMPLE"
    return "dentro del umbral" if cumple else "fuera del umbral"


def main(rapido):
    lineas = [
        "# Resultados de las pruebas de rendimiento — Brayan Collazos (API Gateway y ms-inventario)",
        "",
        f"Generado el {datetime.now():%Y-%m-%d %H:%M}. La columna «Vía» dice cómo llegó cada prueba: `gateway` (por el API Gateway, con sesión) o `directo` (a ms-inventario)"
        + (" · **corrida rápida de comprobación (10 usuarios, 30 s): no es un resultado válido**" if rapido else ""),
        "",
        f"Entorno: {os.environ.get('PERF_ENTORNO', 'sin declarar')}",
        "",
        "Criterio RNF06: p95 < 2000 ms y errores < 1 %. Las pruebas de referencia (escritura, integración, contención,",
        "estrés y pico) se comparan con el mismo umbral, pero RNF06 solo obliga a las consultas.",
        "",
        "| Prueba | Vía | Tipo | Peticiones | Errores | Mediana (ms) | p95 (ms) | p99 (ms) | Máx. (ms) | Peticiones/s | Resultado |",
        "|---|---|---|---|---|---|---|---|---|---|---|",
    ]
    detalle = []
    for e in ESCENARIOS:
        total, filas = leer(e["id"])
        if total is None:
            lineas.append(f"| {e['id']} {e['clase']} | — | {e['tipo']} | — | — | — | — | — | — | — | NO EJECUTADA |")
            continue
        peticiones = numero(total, "Request Count")
        errores = numero(total, "Failure Count")
        porcentaje = f"{errores:.0f} ({errores / peticiones:.2%})" if peticiones else "—"
        lineas.append(
            f"| {e['id']} {e['clase']} | {via_de(e['id'])} | {e['tipo']} | {peticiones:.0f} | {porcentaje} | {numero(total, 'Median Response Time'):.0f} "
            f"| {numero(total, '95%'):.0f} | {numero(total, '99%'):.0f} | {numero(total, 'Max Response Time'):.0f} "
            f"| {numero(total, 'Requests/s'):.1f} | {veredicto(e, total)} |"
        )
        detalle.append(f"\n### {e['id']} — {e['descripcion']}\n")
        detalle.append("| Operación | Peticiones | Errores | p95 (ms) |\n|---|---|---|---|")
        for f in filas:
            detalle.append(f"| `{f['Type']} {f['Name']}` | {numero(f, 'Request Count'):.0f} | {numero(f, 'Failure Count'):.0f} | {numero(f, '95%'):.0f} |")
    lineas += ["", "## Detalle por operación"] + detalle + [""]
    (AQUI / "RESULTADOS.md").write_text("\n".join(lineas), encoding="utf-8")
    print("\n".join(lineas[:11 + len(ESCENARIOS)]))


if __name__ == "__main__":
    main("--rapido" in sys.argv)
