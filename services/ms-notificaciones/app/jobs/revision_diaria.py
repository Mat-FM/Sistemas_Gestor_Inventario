"""Revisión diaria (llamada 5): a la hora configurada consulta GET /lotes y GET /saldos/bajo-umbral de
ms-inventario y genera las alertas de vencimiento (RF17) y de stock bajo (RF09) que falten.

Corre en un hilo del mismo proceso. Si ms-inventario no responde, la revisión registra el fallo y
espera al día siguiente; el resto del servicio sigue atendiendo peticiones.
"""
import threading
import uuid
from datetime import date, datetime, timedelta

from .. import db, logger
from ..clients import inventario
from ..clients.http import ServicioNoDisponible
from ..repositories import configuracion as repo_configuracion
from ..services import notificaciones

_REINTENTO_SIN_BASE_S = 60


def _mensaje_vencimiento(lote, limite):
    codigo = lote.get("codigo_lote") or lote.get("id_lote")
    cantidad = lote.get("cantidad_disponible", lote.get("cantidad"))
    texto = f"El lote {codigo} del producto {lote.get('id_producto')}"
    if lote.get("id_bodega"):
        texto += f" en la bodega {lote['id_bodega']}"
    texto += f" vence el {lote.get('fecha_vencimiento') or limite.isoformat()}"
    if cantidad is not None:
        texto += f" ({cantidad} unidades)"
    return texto + "."


def _mensaje_stock_bajo(saldo):
    return (
        f"El producto {saldo.get('id_producto')} tiene {saldo.get('cantidad_total')} unidades entre las dos bodegas, "
        f"por debajo del mínimo de {saldo.get('cantidad_minima')}."
    )


def _crear(tipo, mensaje, id_producto, id_bodega, request_id):
    if not isinstance(id_producto, int):
        return False
    _notificacion, creada = notificaciones.crear(
        {
            "tipo": tipo,
            "mensaje": mensaje[:500],
            "id_producto": id_producto,
            "id_bodega": id_bodega if isinstance(id_bodega, int) else None,
            "rol_destinatario": "ADMINISTRADOR",
        },
        request_id,
    )
    return creada


def ejecutar(hoy=None):
    """Hace una revisión completa y devuelve un resumen. Nunca lanza por fallos de ms-inventario."""
    request_id = str(uuid.uuid4())
    hoy = hoy or date.today()
    with db.conexion() as con:
        dias = repo_configuracion.obtener(con)["dias_anticipacion_vencimiento"]
    limite = hoy + timedelta(days=dias)
    resumen = {"vencimiento": 0, "stock_bajo": 0, "errores": []}

    try:
        for lote in inventario.lotes_por_vencer(limite.isoformat(), request_id):
            mensaje = _mensaje_vencimiento(lote, limite)
            if _crear("VENCIMIENTO", mensaje, lote.get("id_producto"), lote.get("id_bodega"), request_id):
                resumen["vencimiento"] += 1
    except ServicioNoDisponible as error:
        resumen["errores"].append(f"GET /lotes: {error.causa}")

    try:
        for saldo in inventario.saldos_bajo_umbral(request_id):
            if _crear("STOCK_BAJO", _mensaje_stock_bajo(saldo), saldo.get("id_producto"), None, request_id):
                resumen["stock_bajo"] += 1
    except ServicioNoDisponible as error:
        resumen["errores"].append(f"GET /saldos/bajo-umbral: {error.causa}")

    nivel = logger.warn if resumen["errores"] else logger.info
    nivel("revision diaria", request_id=request_id, **resumen)
    return resumen


def proxima_ejecucion(hora, ahora):
    """Siguiente fecha y hora en que toca la revisión (hoy si aún no pasó la hora, si no mañana)."""
    candidata = datetime.combine(ahora.date(), hora)
    return candidata if candidata > ahora else candidata + timedelta(days=1)


class Programador:
    """Hilo que duerme hasta la hora de la revisión. reprogramar() lo despierta para que vuelva a leer la hora."""

    def __init__(self):
        self._cambio = threading.Event()
        self._detener = threading.Event()
        self._hilo = None

    def iniciar(self):
        if self._hilo is None:
            self._hilo = threading.Thread(target=self._ciclo, name="revision-diaria", daemon=True)
            self._hilo.start()

    def reprogramar(self):
        self._cambio.set()

    def detener(self):
        self._detener.set()
        self._cambio.set()

    def _ciclo(self):
        while not self._detener.is_set():
            self._cambio.clear()
            try:
                with db.conexion() as con:
                    hora = repo_configuracion.obtener(con)["hora_revision_diaria"]
            except Exception as error:
                logger.warn("revision diaria sin configuracion", causa=str(error))
                self._cambio.wait(_REINTENTO_SIN_BASE_S)
                continue
            siguiente = proxima_ejecucion(hora, datetime.now())
            logger.info("revision diaria programada", para=siguiente.isoformat(timespec="minutes"))
            if self._cambio.wait((siguiente - datetime.now()).total_seconds()):
                continue  # Cambió la configuración o se pidió detener: se vuelve a calcular.
            try:
                ejecutar()
            except Exception as error:
                logger.error("fallo la revision diaria", error=str(error))


programador = Programador()
