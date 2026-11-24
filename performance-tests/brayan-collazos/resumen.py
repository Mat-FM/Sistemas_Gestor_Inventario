"""Lee los resultados de results/ y escribe RESULTADOS.md:

- La tabla de las 15 pruebas con el veredicto frente a RNF06 (p95 < 2 s y menos de 1 % de errores).
- Lo que la guía del taller pide documentar por escenario: tipología, usuarios, spawn rate, duración, host, versión de Locust y si la API
  pagina.
- Estrés (E01): el punto de quiebre, es decir, con cuántos usuarios y a cuántas peticiones por segundo el p95 pasó de 2 s o los errores
  de 1 % de forma sostenida.
- Capacidad (S01): la tendencia en el tiempo, comparando el principio y el final de la meseta.
- CPU y memoria de los contenedores, si se registraron con recursos.sh.
"""
import csv
import json
import os
import sys
from datetime import datetime
from importlib import metadata
from pathlib import Path

from escenarios import ESCENARIOS

AQUI = Path(__file__).resolve().parent
RESULTADOS = AQUI / "results"
P95_MAXIMO_MS = 2000
ERRORES_MAXIMO = 0.01
SEGUNDOS_SOSTENIDOS = 5  # el quiebre debe mantenerse este tiempo, para no tomar un pico aislado como quiebre


def numero(fila, columna):
    try:
        return float(fila[columna])
    except (KeyError, TypeError, ValueError):
        return None


def leer_csv(archivo):
    if not archivo.exists():
        return []
    with archivo.open(encoding="utf-8") as f:
        return list(csv.DictReader(f))


def leer(id_escenario):
    filas = leer_csv(RESULTADOS / f"{id_escenario}_stats.csv")
    total = next((f for f in filas if f["Name"] == "Aggregated"), None)
    return total, [f for f in filas if f["Name"] != "Aggregated"]


def historial(id_escenario):
    """Filas del total (Aggregated) del historial segundo a segundo, en orden de tiempo. Se descartan los segundos sin tráfico (el arranque,
    cuando Locust todavía no tiene peticiones en su ventana): su percentil no significa nada y falsearía el quiebre y la tendencia."""
    filas = [f for f in leer_csv(RESULTADOS / f"{id_escenario}_stats_history.csv") if f["Name"] == "Aggregated"]
    return [f for f in filas if (numero(f, "Requests/s") or 0) > 0 and numero(f, "95%")]


def texto_de(id_escenario, sufijo, por_defecto="—"):
    archivo = RESULTADOS / f"{id_escenario}{sufijo}"
    return archivo.read_text(encoding="utf-8").strip() if archivo.exists() else por_defecto


def veredicto(escenario, total):
    peticiones = numero(total, "Request Count") or 0
    if peticiones == 0:
        return "SIN DATOS"
    cumple = (numero(total, "95%") or 0) < P95_MAXIMO_MS and (numero(total, "Failure Count") or 0) / peticiones < ERRORES_MAXIMO
    if escenario["obligatorio"]:
        return "CUMPLE" if cumple else "NO CUMPLE"
    return "dentro del umbral" if cumple else "fuera del umbral"


def fuera_de_umbral(fila):
    p95 = numero(fila, "95%")
    rps = numero(fila, "Requests/s") or 0
    fallos = numero(fila, "Failures/s") or 0
    return (p95 is not None and p95 > P95_MAXIMO_MS) or (rps > 0 and fallos / rps > ERRORES_MAXIMO)


def punto_de_quiebre(filas):
    """Primer momento en que el p95 o los errores salen del umbral y siguen fuera durante SEGUNDOS_SOSTENIDOS filas seguidas."""
    if not filas:
        return "Sin historial (¿se corrió E01?)."
    for i in range(len(filas) - SEGUNDOS_SOSTENIDOS + 1):
        ventana = filas[i:i + SEGUNDOS_SOSTENIDOS]
        if all(fuera_de_umbral(f) for f in ventana):
            f = filas[i]
            segundos = int(numero(f, "Timestamp") - numero(filas[0], "Timestamp"))
            return (f"**Quiebre a los {segundos} s, con {numero(f, 'User Count'):.0f} usuarios y {numero(f, 'Requests/s'):.1f} peticiones/s**: "
                    f"p95 {numero(f, '95%') or 0:.0f} ms y {numero(f, 'Failures/s') or 0:.1f} fallos/s. Desde ahí el p95 o los errores "
                    f"quedaron fuera del umbral al menos {SEGUNDOS_SOSTENIDOS} s seguidos.")
    usuarios = max(numero(f, "User Count") or 0 for f in filas)
    rps = max(numero(f, "Requests/s") or 0 for f in filas)
    return f"**No se quebró**: llegó a {usuarios:.0f} usuarios y {rps:.1f} peticiones/s sin salir del umbral de forma sostenida."


def meseta_de_rendimiento(filas, maximo_ms):
    """La otra forma de quebrarse: las peticiones por segundo dejan de crecer aunque sigan entrando usuarios. Los usuarios de más quedan
    esperando un turno (un proceso del servidor, una conexión a la base de datos) y no completan peticiones, así que ni el p95 ni los
    errores lo muestran: solo aparecen, al final, como la petición más lenta. Se toma como meseta el primer momento en que el promedio
    de 10 s llega al 95 % de su máximo, si después todavía entran al menos un 20 % más de usuarios."""
    if len(filas) < 30:
        return ""
    rps = [numero(f, "Requests/s") or 0 for f in filas]
    suave = [sum(rps[max(0, i - 9):i + 1]) / len(rps[max(0, i - 9):i + 1]) for i in range(len(rps))]
    tope = max(suave)
    i = next(i for i, v in enumerate(suave) if v >= 0.95 * tope)
    usuarios = numero(filas[i], "User Count") or 0
    maximos = max(numero(f, "User Count") or 0 for f in filas)
    if not usuarios or maximos < usuarios * 1.2:
        return ""
    segundos = int(numero(filas[i], "Timestamp") - numero(filas[0], "Timestamp"))
    return (f"**Meseta de rendimiento a los {segundos} s, con {usuarios:.0f} usuarios y {suave[i]:.1f} peticiones/s**: desde ahí las peticiones por "
            f"segundo no crecen aunque lleguen hasta {maximos:.0f} usuarios. Los {maximos - usuarios:.0f} de más esperan turno sin completar "
            f"peticiones (no cuentan en el p95 ni en los errores); la petición más lenta tardó {maximo_ms / 1000:.0f} s.")


def promedio(filas, columna):
    valores = [v for v in (numero(f, columna) for f in filas) if v is not None]
    return sum(valores) / len(valores) if valores else 0


def tasa_de_error(filas):
    rps = sum(numero(f, "Requests/s") or 0 for f in filas)
    return (sum(numero(f, "Failures/s") or 0 for f in filas) / rps) if rps else 0


def tendencia(filas, usuarios):
    """Compara el primer y el último 10 % de la meseta (las filas con todos los usuarios ya activos)."""
    meseta = [f for f in filas if (numero(f, "User Count") or 0) >= usuarios]
    if len(meseta) < 20:
        return "Sin historial suficiente (¿se corrió S01 con su duración?)."
    decimo = max(len(meseta) // 10, 1)
    inicio, final = meseta[:decimo], meseta[-decimo:]
    p95_i, p95_f = promedio(inicio, "95%"), promedio(final, "95%")
    rps_i, rps_f = promedio(inicio, "Requests/s"), promedio(final, "Requests/s")
    if not p95_i:
        return "Sin datos del inicio de la meseta."
    cambio = (p95_f - p95_i) / p95_i
    lectura = "estable" if abs(cambio) < 0.2 else ("se degrada con el tiempo" if cambio > 0 else "mejora con el tiempo")
    return "\n".join([
        "| Tramo | p95 medio (ms) | Peticiones/s | Errores |",
        "|---|---|---|---|",
        f"| Primer 10 % de la meseta | {p95_i:.0f} | {rps_i:.1f} | {tasa_de_error(inicio):.2%} |",
        f"| Último 10 % de la meseta | {p95_f:.0f} | {rps_f:.1f} | {tasa_de_error(final):.2%} |",
        "",
        f"Cambio del p95: {cambio:+.0%} → **{lectura}** (se toma como estable un cambio menor del 20 %).",
    ])


def recursos():
    """CPU y memoria por contenedor, de results/recursos.csv (lo escribe recursos.sh durante la corrida). El pico suele ser el arranque
    (preparación de datos, inicios de sesión): la mediana dice cuánto usa en el régimen normal. 100 % es un núcleo."""
    filas = leer_csv(RESULTADOS / "recursos.csv")
    if not filas:
        return ["No se registraron (correr `./recursos.sh` en otra terminal durante las pruebas)."]
    por_contenedor = {}
    for f in filas:
        por_contenedor.setdefault(f["contenedor"], []).append((float(f["cpu"].rstrip("%") or 0), f["memoria"]))
    lineas = ["| Contenedor | CPU mediana (%) | CPU máx. (%) | Memoria en el pico |", "|---|---|---|---|"]
    resumen = []
    for nombre, muestras in por_contenedor.items():
        cpus = sorted(c for c, _ in muestras)
        mediana = cpus[len(cpus) // 2]
        pico = max(muestras, key=lambda m: m[0])
        resumen.append((nombre, mediana, pico[0], pico[1]))
    for nombre, mediana, maximo, memoria in sorted(resumen, key=lambda r: -r[1]):
        lineas.append(f"| {nombre} | {mediana:.1f} | {maximo:.1f} | {memoria} |")
    return lineas


def main(rapido):
    try:
        version = metadata.version("locust")
    except metadata.PackageNotFoundError:
        version = "desconocida"
    reducidas = []
    for e in ESCENARIOS:
        corrida = json.loads(texto_de(e["id"], ".params.json", "{}")).get("duracion")
        if corrida and corrida != e["duracion"]:
            reducidas.append(f"{e['id']} {corrida} (definida: {e['duracion']})")
    reducidas = ("duración reducida en " + ", ".join(reducidas) + "; el resto con la definida") if reducidas and not rapido else ""
    lineas = [
        "# Resultados de las pruebas de rendimiento — Brayan Collazos (API Gateway y ms-inventario)",
        "",
        f"Generado el {datetime.now():%Y-%m-%d %H:%M} con Locust {version}."
        + (" · **corrida rápida de comprobación (10 usuarios, 30 s): no es un resultado válido**" if rapido else "")
        + (f" · **resultados preliminares: {reducidas}**" if reducidas else ""),
        "",
        f"Entorno: {os.environ.get('PERF_ENTORNO', 'sin declarar')}",
        "",
        "Estado de la API: los listados del Gateway (usuarios) y de ms-inventario (saldos, kardex, lotes y bodegas) y de ms-catalogo **paginan** "
        "(`?pagina&por_pagina`, 20 por defecto, máximo 100); `/categorias` devuelve el árbol completo, sin paginar. Las pruebas G y la mezcla (M01, E01 y S01) "
        "van siempre por el Gateway, con una sola cuenta de administrador y los límites de peticiones del Gateway subidos (RNF19) para medir "
        "el Gateway y no el limitador.",
        "",
        "Criterio RNF06: p95 < 2000 ms y errores < 1 %. Las pruebas de referencia se comparan con el mismo umbral, pero RNF06 solo obliga a "
        "las consultas. Un estado inesperado o un cuerpo que no cumple lo esperado (un listado vacío o sin `meta`, un movimiento sin "
        "`id_movimiento`, un reintento que devuelve otro movimiento) cuenta como error.",
        "",
        "| Prueba | Tipología | Qué ejercita | Vía | Peticiones | Errores | Mediana (ms) | p95 (ms) | p99 (ms) | Máx. (ms) | Peticiones/s | Resultado |",
        "|---|---|---|---|---|---|---|---|---|---|---|---|",
    ]
    parametros = ["", "## Parámetros de cada escenario", "",
                  "| Prueba | Usuarios | Spawn rate (usuarios/s) | Duración | Host |", "|---|---|---|---|---|"]
    detalle = []
    for e in ESCENARIOS:
        total, filas = leer(e["id"])
        if total is None:
            lineas.append(f"| {e['id']} {e['clase']} | {e['tipologia']} | {e['tipo']} | — | — | — | — | — | — | — | — | NO EJECUTADA |")
            continue
        peticiones = numero(total, "Request Count") or 0
        errores = numero(total, "Failure Count") or 0
        porcentaje = f"{errores:.0f} ({errores / peticiones:.2%})" if peticiones else "—"
        lineas.append(
            f"| {e['id']} {e['clase']} | {e['tipologia']} | {e['tipo']} | {texto_de(e['id'], '.via')} | {peticiones:.0f} | {porcentaje} "
            f"| {numero(total, 'Median Response Time') or 0:.0f} | {numero(total, '95%') or 0:.0f} | {numero(total, '99%') or 0:.0f} "
            f"| {numero(total, 'Max Response Time') or 0:.0f} | {numero(total, 'Requests/s') or 0:.1f} | {veredicto(e, total)} |"
        )
        p = json.loads(texto_de(e["id"], ".params.json", "{}"))
        parametros.append(f"| {e['id']} | {p.get('usuarios', '—')} | {p.get('tasa', '—')} | {p.get('duracion', '—')} | {p.get('host', '—')} |")
        detalle.append(f"\n### {e['id']} — {e['descripcion']}\n")
        detalle.append("| Operación | Peticiones | Errores | p95 (ms) |\n|---|---|---|---|")
        for f in filas:
            detalle.append(f"| `{f['Type']} {f['Name']}` | {numero(f, 'Request Count') or 0:.0f} | {numero(f, 'Failure Count') or 0:.0f} "
                           f"| {numero(f, '95%') or 0:.0f} |")

    capacidad = next(e for e in ESCENARIOS if e["id"] == "S01")
    usuarios_s01 = json.loads(texto_de("S01", ".params.json", "{}")).get("usuarios", capacidad["usuarios"])
    lineas += parametros
    total_e01 = leer("E01")[0]
    meseta = meseta_de_rendimiento(historial("E01"), numero(total_e01, "Max Response Time") or 0) if total_e01 else ""
    lineas += ["", "## Estrés (E01): punto de quiebre", "", punto_de_quiebre(historial("E01"))] + (["", meseta] if meseta else [])
    lineas += ["", f"## Capacidad (S01): tendencia en el tiempo con {usuarios_s01} usuarios", "", tendencia(historial("S01"), usuarios_s01)]
    lineas += ["", "## CPU y memoria de los contenedores", ""] + recursos()
    lineas += ["", "## Detalle por operación"] + detalle + [""]
    (AQUI / "RESULTADOS.md").write_text("\n".join(lineas), encoding="utf-8")
    print("\n".join(lineas[:12 + len(ESCENARIOS)]))


if __name__ == "__main__":
    main("--rapido" in sys.argv)
