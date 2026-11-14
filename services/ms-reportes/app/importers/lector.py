"""Lectura de los archivos de la carga masiva (RF16): CSV o Excel (.xlsx).

- CSV en UTF-8 (también con BOM), separado por coma o por punto y coma (el que usa Excel en español).
- Excel: solo .xlsx y su primera hoja.
- La fila 1 es el encabezado. Los nombres de las columnas no distinguen mayúsculas ni espacios en los extremos,
  y las columnas que sobran se ignoran.
- Las filas completamente vacías se saltan. Cada fila conserva su número en el archivo (la primera de datos es la 2),
  el mismo que el usuario ve en Excel.
"""

import csv
import io
from dataclasses import dataclass
from datetime import date, datetime

from openpyxl import load_workbook

from app.errores import ApiError

EXTENSIONES = (".csv", ".xlsx")


@dataclass
class FilaLeida:
    numero: int
    valores: dict[str, str]  # columna -> texto ("" si la celda está vacía)


def leer(nombre_archivo: str, contenido: bytes, columnas: list[str]) -> list[FilaLeida]:
    """Lee el archivo y devuelve sus filas de datos. 422 si el formato no se admite, si no se puede leer,
    si faltan columnas o si no tiene filas."""
    nombre = nombre_archivo.lower()
    if nombre.endswith(".csv"):
        renglones = _renglones_csv(contenido)
    elif nombre.endswith(".xlsx"):
        renglones = _renglones_excel(contenido)
    else:
        raise _error("El archivo debe ser CSV o Excel (.xlsx).")

    if not renglones:
        raise _error("El archivo está vacío.")

    encabezado = [_texto(valor).lower() for valor in renglones[0]]
    faltantes = [columna for columna in columnas if columna not in encabezado]
    if faltantes:
        raise _error(f"Faltan las columnas: {', '.join(faltantes)}.")

    posiciones = {columna: encabezado.index(columna) for columna in columnas}
    filas = []
    for numero, renglon in enumerate(renglones[1:], start=2):
        valores = {columna: _texto(renglon[i]) if i < len(renglon) else "" for columna, i in posiciones.items()}
        if any(valores.values()):
            filas.append(FilaLeida(numero, valores))

    if not filas:
        raise _error("El archivo no tiene filas con datos.")
    return filas


def _renglones_csv(contenido: bytes) -> list[list]:
    try:
        texto = contenido.decode("utf-8-sig")
    except UnicodeDecodeError:
        raise _error("El archivo CSV debe estar guardado en UTF-8.")

    primera_linea = texto.split("\n", 1)[0]
    separador = ";" if primera_linea.count(";") > primera_linea.count(",") else ","
    return list(csv.reader(io.StringIO(texto), delimiter=separador))


def _renglones_excel(contenido: bytes) -> list[list]:
    try:
        libro = load_workbook(io.BytesIO(contenido), read_only=True, data_only=True)
        try:
            return [list(renglon) for renglon in libro.worksheets[0].iter_rows(values_only=True)]
        finally:
            libro.close()
    except Exception:
        # Un archivo dañado o que no es un Excel real puede fallar de muchas formas.
        raise _error("No se pudo leer el archivo de Excel.")


def _texto(valor) -> str:
    """Convierte el valor de una celda en texto: los números enteros sin decimales y las fechas como AAAA-MM-DD."""
    if valor is None:
        return ""
    if isinstance(valor, datetime):
        return valor.date().isoformat()
    if isinstance(valor, date):
        return valor.isoformat()
    if isinstance(valor, float) and valor.is_integer():
        return str(int(valor))
    return str(valor).strip()


def _error(mensaje: str) -> ApiError:
    return ApiError.datos_no_validos([{"campo": "archivo", "mensaje": mensaje}])
