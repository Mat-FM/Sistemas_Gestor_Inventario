"""Pool de conexiones a la base de datos propia de ms-notificaciones (RNF02)."""
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

_pool = None


def iniciar(config):
    global _pool
    if _pool is None:
        _pool = ConnectionPool(
            kwargs={**config.db, "row_factory": dict_row, "connect_timeout": 5},
            min_size=1,
            max_size=config.db_pool_max,
            open=True,
            # No falla al arrancar si la base aún no responde: /health lo mostrará.
            wait=False,
        )
    return _pool


def conexion():
    """Uso: `with conexion() as con:`. Al salir del bloque se confirma la transacción
    (o se deshace si hubo una excepción) y la conexión vuelve al pool."""
    return _pool.connection(timeout=5)


def cerrar():
    global _pool
    if _pool is not None:
        _pool.close()
        _pool = None
