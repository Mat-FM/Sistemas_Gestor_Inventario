"""Configuración del servicio. Todo sale de variables de entorno (RNF14); no hay valores secretos en el código."""

import os

from sqlalchemy import URL


def _url_base_de_datos() -> str:
    """URL de conexión a PostgreSQL armada con las variables DB_*. URL.create escapa la contraseña."""
    return URL.create(
        "postgresql+psycopg",
        username=os.environ.get("DB_USER", "reportes"),
        password=os.environ.get("DB_PASSWORD", ""),
        host=os.environ.get("DB_HOST", "127.0.0.1"),
        port=int(os.environ.get("DB_PORT", "5432")),
        database=os.environ.get("DB_NAME", "reportes_db"),
    ).render_as_string(hide_password=False)


def cargar_configuracion() -> dict:
    """Se lee al crear la aplicación (no al importar el módulo), para que las pruebas puedan cambiar el entorno."""
    return {
        "SERVICE_NAME": os.environ.get("SERVICE_NAME", "ms-reportes"),
        "LOG_LEVEL": os.environ.get("LOG_LEVEL", "INFO"),
        "SQLALCHEMY_DATABASE_URI": _url_base_de_datos(),
        # Comprueba la conexión antes de usarla, por si PostgreSQL la cerró.
        "SQLALCHEMY_ENGINE_OPTIONS": {"pool_pre_ping": True},
        # Direcciones de los demás servicios y tiempo máximo de cada llamada (RNF18).
        "MS_CATALOGO_URL": os.environ.get("MS_CATALOGO_URL", "http://ms-catalogo:8000"),
        "MS_PROVEEDORES_URL": os.environ.get("MS_PROVEEDORES_URL", "http://ms-proveedores:8000"),
        "MS_INVENTARIO_URL": os.environ.get("MS_INVENTARIO_URL", "http://ms-inventario:3000"),
        "MS_COMPRAS_URL": os.environ.get("MS_COMPRAS_URL", "http://ms-compras:3000"),
        "CALL_TIMEOUT_SECONDS": float(os.environ.get("CALL_TIMEOUT_SECONDS", "3")),
    }
