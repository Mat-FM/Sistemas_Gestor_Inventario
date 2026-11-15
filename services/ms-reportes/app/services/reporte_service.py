"""Reportes (RF11, RF15) e indicadores (RF14). Se calculan en el momento con datos de ms-inventario, ms-catalogo y
ms-compras (llamada 6 de la Entrega 2) y no se guardan. No sabe nada de HTTP.

Si un servicio no responde, sus clientes lanzan ServicioNoDisponible y la petición responde 503.
"""

from collections import defaultdict
from datetime import date, timedelta
from decimal import Decimal

from app.clients import catalogo, compras, inventario
from app.errores import ApiError

# Rotación: solo las salidas por venta o despacho; los traslados, ajustes y devoluciones no cuentan.
TIPO_SALIDA = "SALIDA"
LIMITE_ROTACION = 10

# Indicadores: valores por defecto.
DIAS_PERIODO = 30
DIAS_PROXIMOS_A_VENCER = 30
LIMITE_INDICADORES = 5
# Órdenes que todavía esperan mercancía.
ESTADOS_PENDIENTES = ("ENVIADA", "RECIBIDA_PARCIAL")


def existencias(id_bodega: int | None, id_categoria: int | None) -> list[dict]:
    """Existencias por producto y bodega (RF11). ?id_categoria incluye sus subcategorías, como la búsqueda de RF12."""
    productos = _por_id(catalogo.productos(), "id_producto")
    bodegas = _por_id(inventario.bodegas(), "id_bodega")
    categorias = _con_subcategorias(id_categoria) if id_categoria is not None else None

    filas = []
    for saldo in inventario.saldos(id_bodega):
        producto = productos.get(int(saldo["id_producto"]))
        if producto is None or (categorias is not None and int(producto["id_categoria"]) not in categorias):
            continue
        filas.append({
            "id_producto": producto["id_producto"],
            "codigo": producto["codigo"],
            "nombre": producto["nombre"],
            "id_categoria": producto["id_categoria"],
            "id_bodega": int(saldo["id_bodega"]),
            "bodega": _nombre_bodega(bodegas, saldo["id_bodega"]),
            "cantidad_disponible": _cantidad(_decimal(saldo["cantidad_disponible"])),
        })
    return sorted(filas, key=lambda f: (f["codigo"], f["id_bodega"]))


def valorizacion(id_bodega: int | None) -> dict:
    """Valor de cada producto (cantidad en existencia por su precio registrado) y valor_total (RF11)."""
    return _valorizar(catalogo.productos(), inventario.saldos(id_bodega))


def rotacion(fecha_desde: date, fecha_hasta: date, limite: int) -> dict:
    """Productos activos ordenados por sus salidas en el periodo (RF11). Los que no tuvieron salidas cuentan con 0."""
    return _rotacion(catalogo.productos(), fecha_desde, fecha_hasta, limite)


def kardex(filtros: dict) -> list[dict]:
    """Movimientos con los filtros de GET /movimientos, del más reciente al más antiguo, con el código y el nombre
    del producto y el nombre de la bodega (RF15)."""
    movimientos = inventario.movimientos(filtros)
    productos = _por_id(catalogo.productos(), "id_producto")
    bodegas = _por_id(inventario.bodegas(), "id_bodega")

    filas = []
    for m in movimientos:
        producto = productos.get(int(m["id_producto"]), {})
        filas.append({
            "id_movimiento": m.get("id_movimiento"),
            "fecha": m.get("fecha"),
            "tipo": m.get("tipo"),
            "id_producto": int(m["id_producto"]),
            "codigo": producto.get("codigo"),
            "nombre": producto.get("nombre"),
            "id_bodega": m.get("id_bodega"),
            "bodega": _nombre_bodega(bodegas, m.get("id_bodega")),
            "cantidad": _cantidad(_decimal(m.get("cantidad"))),
            "saldo_resultante": _cantidad(_decimal(m.get("saldo_resultante"))),
            "id_usuario": m.get("id_usuario"),
            "documento_referencia": m.get("documento_referencia"),
            "observacion": m.get("observacion"),
        })
    return filas


def indicadores(fecha_desde: date | None, fecha_hasta: date | None) -> dict:
    """Panel de indicadores (RF14). Sin fecha_hasta, el periodo termina hoy; sin fecha_desde, empieza 30 días antes
    de fecha_hasta. El periodo solo afecta a mayor_rotacion; los demás indicadores son del momento."""
    hoy = date.today()
    fecha_hasta = fecha_hasta or hoy
    fecha_desde = fecha_desde or fecha_hasta - timedelta(days=DIAS_PERIODO)
    validar_rango(fecha_desde, fecha_hasta)

    productos = catalogo.productos()
    saldos = inventario.saldos()

    # Agotados: productos activos cuya suma en las dos bodegas es 0, también los que no tienen saldo.
    totales = defaultdict(Decimal)
    for saldo in saldos:
        totales[int(saldo["id_producto"])] += _decimal(saldo["cantidad_disponible"])
    agotados = sum(1 for p in productos if p.get("estado") == "ACTIVO" and totales[int(p["id_producto"])] <= 0)

    vence_antes_de = (hoy + timedelta(days=DIAS_PROXIMOS_A_VENCER)).isoformat()

    return {
        "valor_total": _valorizar(productos, saldos)["valor_total"],
        "productos_bajo_umbral": len(inventario.saldos_bajo_umbral()),
        "productos_agotados": agotados,
        "proximos_a_vencer": len(inventario.lotes(vence_antes_de)),
        "mayor_rotacion": _rotacion(productos, fecha_desde, fecha_hasta, LIMITE_INDICADORES)["mayor_rotacion"],
        "ordenes_pendientes": sum(compras.contar_ordenes(estado) for estado in ESTADOS_PENDIENTES),
    }


def validar_rango(fecha_desde: date, fecha_hasta: date) -> None:
    """422 si el periodo termina antes de empezar."""
    if fecha_desde > fecha_hasta:
        raise ApiError.datos_no_validos([{"campo": "fecha_hasta",
                                          "mensaje": "El campo fecha_hasta debe ser igual o posterior a fecha_desde."}])


def _valorizar(productos: list[dict], saldos: list[dict]) -> dict:
    por_id = _por_id(productos, "id_producto")
    cantidades = defaultdict(Decimal)
    for saldo in saldos:
        cantidades[int(saldo["id_producto"])] += _decimal(saldo["cantidad_disponible"])

    filas = []
    total = Decimal(0)
    for id_producto, cantidad in cantidades.items():
        producto = por_id.get(id_producto)
        if producto is None:
            continue
        precio = _decimal(producto["precio"])
        valor = cantidad * precio
        total += valor
        filas.append({
            "id_producto": id_producto,
            "codigo": producto["codigo"],
            "nombre": producto["nombre"],
            "cantidad": _cantidad(cantidad),
            "precio": _dinero(precio),
            "valor": _dinero(valor),
        })
    return {"productos": sorted(filas, key=lambda f: f["codigo"]), "valor_total": _dinero(total)}


def _rotacion(productos: list[dict], fecha_desde: date, fecha_hasta: date, limite: int) -> dict:
    salidas = defaultdict(Decimal)
    filtros = {"tipo": TIPO_SALIDA, "fecha_desde": fecha_desde.isoformat(), "fecha_hasta": fecha_hasta.isoformat()}
    for movimiento in inventario.movimientos(filtros):
        salidas[int(movimiento["id_producto"])] += abs(_decimal(movimiento["cantidad"]))

    filas = [{
        "id_producto": p["id_producto"],
        "codigo": p["codigo"],
        "nombre": p["nombre"],
        "salidas": _cantidad(salidas[int(p["id_producto"])]),
    } for p in productos if p.get("estado") == "ACTIVO"]

    return {
        "mayor_rotacion": sorted(filas, key=lambda f: (-f["salidas"], f["codigo"]))[:limite],
        "menor_rotacion": sorted(filas, key=lambda f: (f["salidas"], f["codigo"]))[:limite],
    }


def _con_subcategorias(id_categoria: int) -> set[int]:
    return {id_categoria} | {int(c["id_categoria"]) for c in catalogo.categorias()
                             if c.get("id_categoria_padre") is not None and int(c["id_categoria_padre"]) == id_categoria}


def _por_id(elementos: list[dict], clave: str) -> dict[int, dict]:
    return {int(e[clave]): e for e in elementos}


def _nombre_bodega(bodegas: dict[int, dict], id_bodega) -> str | None:
    return bodegas.get(int(id_bodega), {}).get("nombre") if id_bodega is not None else None


def _decimal(valor) -> Decimal:
    """Las cantidades y los precios pueden llegar como número o como texto ("2500.50"). Se suman en Decimal."""
    return Decimal(str(valor)) if valor is not None else Decimal(0)


def _cantidad(valor: Decimal) -> int | float:
    return int(valor) if valor == valor.to_integral_value() else float(valor)


def _dinero(valor: Decimal) -> float:
    return float(valor.quantize(Decimal("0.01")))
