"""Exportación a CSV (RF16), pensada para abrirse con Excel en español:

- Separado por punto y coma y con coma decimal (2500,5), como lo guarda Excel en español.
- En UTF-8 con BOM, para que Excel muestre bien las tildes y las eñes.
- Un texto que empieza por =, +, - o @ se antepone con un apóstrofo, para que Excel no lo ejecute como fórmula.
"""

import csv
import io

_INICIO_DE_FORMULA = ("=", "+", "-", "@")


def generar(columnas: list[tuple[str, str]], filas: list[dict]) -> bytes:
    """`columnas` es [(clave, título)]: el título va en el encabezado y la clave se toma de cada fila."""
    salida = io.StringIO()
    escritor = csv.writer(salida, delimiter=";")
    escritor.writerow([titulo for _, titulo in columnas])
    for fila in filas:
        escritor.writerow([_celda(fila.get(clave)) for clave, _ in columnas])
    return salida.getvalue().encode("utf-8-sig")


def _celda(valor) -> str:
    if valor is None:
        return ""
    if isinstance(valor, bool):
        return "Sí" if valor else "No"
    if isinstance(valor, float):
        return str(int(valor)) if valor.is_integer() else str(valor).replace(".", ",")
    if isinstance(valor, int):
        return str(valor)
    texto = str(valor)
    return "'" + texto if texto.startswith(_INICIO_DE_FORMULA) else texto
