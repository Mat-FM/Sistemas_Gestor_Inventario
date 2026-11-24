"""Corre las pruebas de escenarios.py con Locust sin interfaz y luego escribe el resumen.

Uso (dentro del contenedor de Locust, ver README):
    python ejecutar.py                 # las 15, con la duración y los usuarios de cada escenario
    python ejecutar.py C01 N03         # solo algunas
    python ejecutar.py --rapido        # comprobación: 10 usuarios y 30 s por prueba (no sirve como resultado)

Cada prueba deja en results/ sus CSV y un informe HTML de Locust; resumen.py arma RESULTADOS.md con todas.
"""
import subprocess
import sys
from pathlib import Path

from escenarios import ESCENARIOS

AQUI = Path(__file__).resolve().parent
RESULTADOS = AQUI / "results"


def correr(escenario, rapido):
    usuarios = min(escenario["usuarios"], 10) if rapido else escenario["usuarios"]
    tasa = min(escenario["tasa"], 5) if rapido else escenario["tasa"]
    duracion = "30s" if rapido else escenario["duracion"]
    prefijo = RESULTADOS / escenario["id"]
    comando = [
        "locust", "-f", str(AQUI / escenario["archivo"]), escenario["clase"],
        "--headless", "--only-summary",
        "--users", str(usuarios), "--spawn-rate", str(tasa), "--run-time", duracion,
        "--stop-timeout", "10",
        "--csv", str(prefijo), "--html", f"{prefijo}.html",
        "--loglevel", "WARNING",
    ]
    print(f"\n=== {escenario['id']} {escenario['clase']}: {usuarios} usuarios, {tasa}/s, {duracion}", flush=True)
    # Locust sale con 1 si hubo peticiones fallidas: eso no detiene las demás pruebas, lo dice el resumen.
    return subprocess.run(comando, cwd=AQUI).returncode


def main(argumentos):
    rapido = "--rapido" in argumentos
    pedidos = {a.upper() for a in argumentos if not a.startswith("--")}
    escenarios = [e for e in ESCENARIOS if not pedidos or e["id"] in pedidos]
    desconocidos = pedidos - {e["id"] for e in ESCENARIOS}
    if desconocidos:
        sys.exit(f"Escenarios desconocidos: {', '.join(sorted(desconocidos))}")
    RESULTADOS.mkdir(exist_ok=True)
    for escenario in escenarios:
        correr(escenario, rapido)
    subprocess.run([sys.executable, str(AQUI / "resumen.py")] + (["--rapido"] if rapido else []), cwd=AQUI, check=True)


if __name__ == "__main__":
    main(sys.argv[1:])
