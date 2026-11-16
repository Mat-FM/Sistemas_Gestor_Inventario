"""Aplica en orden los archivos .sql de migrations/ que aún no se han aplicado.

Cada archivo corre en su propia transacción y queda anotado en la tabla migracion.
Uso: `flask --app wsgi migrar` (también se aplican solas al arrancar).
"""
from pathlib import Path

from . import db, logger

CARPETA = Path(__file__).resolve().parent.parent / "migrations"
_CANDADO = 525252


def migrar():
    aplicadas_ahora = []
    with db.conexion() as con:
        con.autocommit = True
        # El candado evita que dos copias del servicio migren a la vez al arrancar.
        con.execute("SELECT pg_advisory_lock(%s)", (_CANDADO,))
        try:
            con.execute(
                """CREATE TABLE IF NOT EXISTS migracion (
                       nombre    VARCHAR(255) PRIMARY KEY,
                       aplicada  TIMESTAMPTZ  NOT NULL DEFAULT now()
                   )"""
            )
            aplicadas = {fila["nombre"] for fila in con.execute("SELECT nombre FROM migracion")}
            pendientes = sorted(p for p in CARPETA.glob("*.sql") if p.name not in aplicadas)
            for archivo in pendientes:
                try:
                    with con.transaction():
                        con.execute(archivo.read_text(encoding="utf-8"))
                        con.execute("INSERT INTO migracion (nombre) VALUES (%s)", (archivo.name,))
                except Exception as error:
                    raise RuntimeError(f"Falló la migración {archivo.name}: {error}") from error
                aplicadas_ahora.append(archivo.name)
                logger.info("migracion aplicada", archivo=archivo.name)
        finally:
            con.execute("SELECT pg_advisory_unlock(%s)", (_CANDADO,))
            con.autocommit = False
    return aplicadas_ahora
