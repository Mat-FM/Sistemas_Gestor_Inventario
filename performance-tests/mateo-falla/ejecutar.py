"""Corre las pruebas de escenarios.py con Locust sin interfaz y luego escribe el resumen.

Uso (dentro del contenedor de Locust, ver README):
    python ejecutar.py                 # las 15, con la duración y los usuarios de cada escenario
    python ejecutar.py R01 K03         # solo algunas (respetando el orden de escenarios.py)
    python ejecutar.py --rapido        # comprobación: 10 usuarios y 30 s por prueba (no sirve como resultado)
    python ejecutar.py --duracion=1m   # preliminar: los mismos usuarios, cada prueba dura como máximo 1 min

Cada prueba deja en results/ sus CSV y un informe HTML de Locust; resumen.py arma RESULTADOS.md con todas.
"""
import json
import os
import subprocess
import sys
from pathlib import Path

from escenarios import ESCENARIOS

AQUI = Path(__file__).resolve().parent
RESULTADOS = AQUI / "results"


def correr(escenario, rapido, duracion=None):
    usuarios = min(escenario["usuarios"], 10) if rapido else escenario["usuarios"]
    tasa = min(escenario["tasa"], 5) if rapido else escenario["tasa"]
    duracion = "30s" if rapido else duracion or escenario["duracion"]
    prefijo = RESULTADOS / escenario["id"]
    comando = [
        "locust", "-f", str(AQUI / escenario["archivo"]), escenario["clase"],
        "--headless", "--only-summary",
        "--users", str(usuarios), "--spawn-rate", str(tasa), "--run-time", duracion,
        "--stop-timeout", "10",
        "--csv", str(prefijo), "--html", f"{prefijo}.html",
        "--loglevel", "WARNING",
    ]
    if escenario.get("historial"):
        # Historial segundo a segundo: resumen.py calcula con él el punto de quiebre (E01) y la tendencia en el tiempo (S01).
        comando.append("--csv-full-history")
    print(f"\n=== {escenario['id']} {escenario['clase']}: {usuarios} usuarios, {tasa}/s, {duracion}", flush=True)
    # Locust sale con 1 si hubo peticiones fallidas: eso no detiene las demás pruebas, lo dice el resumen.
    codigo = subprocess.run(comando, cwd=AQUI).returncode
    # Cómo llegaron las peticiones (por el Gateway o directo) y con qué parámetros: la guía pide documentarlos por escenario.
    via = os.environ.get("PERF_MODO", "directo").strip().lower()
    host = os.environ.get("PERF_GATEWAY_URL", "http://api-gateway:8000") if via == "gateway" else "cada servicio (PERF_*_URL)"
    if escenario.get("interna"):
        # Las rutas /internas/... no pasan por el Gateway: van directo al servicio en los dos modos.
        via, host = "directo (ruta interna)", os.environ.get("PERF_CATALOGO_URL", "http://ms-catalogo:8000")
    (RESULTADOS / f"{escenario['id']}.via").write_text(via, encoding="utf-8")
    parametros = {"usuarios": usuarios, "tasa": tasa, "duracion": duracion, "host": host}
    (RESULTADOS / f"{escenario['id']}.params.json").write_text(json.dumps(parametros), encoding="utf-8")
    return codigo


def main(argumentos):
    rapido = "--rapido" in argumentos
    duracion = next((a.split("=", 1)[1] for a in argumentos if a.startswith("--duracion=")), None)
    pedidos = {a.upper() for a in argumentos if not a.startswith("--")}
    escenarios = [e for e in ESCENARIOS if not pedidos or e["id"] in pedidos]
    desconocidos = pedidos - {e["id"] for e in ESCENARIOS}
    if desconocidos:
        sys.exit(f"Escenarios desconocidos: {', '.join(sorted(desconocidos))}")
    RESULTADOS.mkdir(exist_ok=True)
    for escenario in escenarios:
        correr(escenario, rapido, duracion)
    extra = ["--rapido"] if rapido else [f"--duracion={duracion}"] if duracion else []
    subprocess.run([sys.executable, str(AQUI / "resumen.py")] + extra, cwd=AQUI, check=True)


if __name__ == "__main__":
    main(sys.argv[1:])
