"""Configuración leída del entorno (RNF14): nada de direcciones ni contraseñas escritas en el código."""
import os


def _entero(nombre, por_defecto):
    valor = os.environ.get(nombre)
    if valor is None or valor == "":
        return por_defecto
    try:
        return int(valor)
    except ValueError as error:
        raise RuntimeError(f"La variable {nombre} debe ser un número") from error


def _decimal(nombre, por_defecto):
    valor = os.environ.get(nombre)
    if valor is None or valor == "":
        return por_defecto
    try:
        return float(valor)
    except ValueError as error:
        raise RuntimeError(f"La variable {nombre} debe ser un número") from error


class Config:
    """Se lee al crear la aplicación, así las pruebas pueden cambiar el entorno antes."""

    def __init__(self):
        self.servicio = os.environ.get("SERVICE_NAME", "ms-notificaciones")
        self.puerto = _entero("PORT", 5000)
        self.nivel_log = os.environ.get("LOG_LEVEL", "INFO").upper()

        self.db = {
            "host": os.environ.get("DB_HOST", "127.0.0.1"),
            "port": _entero("DB_PORT", 5435),
            "dbname": os.environ.get("DB_NAME", "notificaciones_db"),
            "user": os.environ.get("DB_USER", "notificaciones"),
            "password": os.environ.get("DB_PASSWORD", "change_me"),
        }
        self.db_pool_max = _entero("DB_POOL_MAX", 10)

        self.inventario_url = os.environ.get("MS_INVENTARIO_URL", "http://ms-inventario:3000")

        # Llamadas entre servicios (RNF18): espera máxima, reintentos y cortacircuito.
        self.timeout_s = _decimal("CALL_TIMEOUT_SECONDS", 3)
        self.esperas_reintento_s = [0.2, 0.4, 0.8]
        self.fallos_para_abrir = 5
        self.tiempo_abierto_s = 30

        # Servidor de correo externo (llamada 9). Sin SMTP_HOST no se envían correos.
        self.smtp = {
            "host": os.environ.get("SMTP_HOST", ""),
            "port": _entero("SMTP_PORT", 587),
            "user": os.environ.get("SMTP_USER", ""),
            "password": os.environ.get("SMTP_PASSWORD", ""),
            "remitente": os.environ.get("MAIL_FROM", ""),
        }

        # La revisión diaria corre en un hilo dentro del proceso; las pruebas la apagan.
        self.revision_diaria_activa = os.environ.get("REVISION_DIARIA_ACTIVA", "true").lower() != "false"
