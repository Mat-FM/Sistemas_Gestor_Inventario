"""Columnas de cada tipo de archivo (Tabla 13 de la Entrega 2) y validación de cada fila antes de enviarla.

Las reglas son las mismas del servicio que recibe las filas (largos y tipos), para señalar el campo exacto del error.
Los mensajes son los mismos que en ms-catalogo y ms-proveedores. La conversión de categoría, producto y bodega en
sus identificadores la hace ImportacionService, porque necesita llamar a otros servicios.
"""

import re
from datetime import datetime
from decimal import Decimal, InvalidOperation

COLUMNAS = {
    "PRODUCTOS": ["codigo", "nombre", "descripcion", "categoria", "unidad_medida", "precio"],
    "PROVEEDORES": ["nit", "razon_social", "nombre_contacto", "telefono", "correo", "direccion"],
    "STOCK_INICIAL": ["codigo_producto", "codigo_bodega", "cantidad", "codigo_lote", "fecha_vencimiento"],
}

_PRECIO_MAXIMO = Decimal("9999999999.99")
_CORREO = re.compile(r"^[^@\s]+@[^@\s]+$")
# Parte entera con separador de miles: 1.234 o 1.234.567 (grupos de tres cifras).
_MILES = {sep: re.compile(rf"^\d{{1,3}}(?:{re.escape(sep)}\d{{3}})+$") for sep in (".", ",")}


def _normalizar_numero(valor: str) -> str:
    """Lleva un número escrito a la española (2.500,50), a la inglesa (2,500.50) o sin miles (2500,5) a la forma
    2500.50 que lee Decimal. Con los dos separadores, el último es el decimal; con uno repetido es de miles. Los
    grupos de miles deben ser de tres cifras: si la forma es imposible (1.2.3) se devuelve tal cual y Decimal la
    rechaza. Un solo separador, una sola vez, es decimal ("2,500" vale 2,5, como siempre)."""
    for miles, decimal in ((".", ","), (",", ".")):
        if miles in valor and decimal in valor:
            if valor.rfind(decimal) < valor.rfind(miles) or valor.count(decimal) != 1:
                continue  # el decimal no es el último separador: no es este formato
            entero, fraccion = valor.split(decimal)
            if _MILES[miles].match(entero):
                return entero.replace(miles, "") + "." + fraccion
            return valor
    for miles in (".", ","):
        if valor.count(miles) > 1 and _MILES[miles].match(valor):
            return valor.replace(miles, "")
    return valor.replace(",", ".") if "." not in valor else valor


def validar(tipo: str, valores: dict[str, str]) -> tuple[dict, list[dict]]:
    """Devuelve los datos de la fila ya convertidos (números como número, vacíos como None) y sus errores
    [{campo, mensaje}]. Si hay errores, los datos no se usan."""
    errores: list[dict] = []
    v = _Validador(valores, errores)

    if tipo == "PRODUCTOS":
        datos = {
            "codigo": v.texto("codigo", maximo=30),
            "nombre": v.texto("nombre", maximo=150),
            "descripcion": v.texto("descripcion", maximo=500, obligatorio=False),
            "categoria": v.texto("categoria", maximo=100),
            "unidad_medida": v.texto("unidad_medida", maximo=20),
            "precio": v.numero("precio", minimo=Decimal(0), maximo=_PRECIO_MAXIMO),
        }
    elif tipo == "PROVEEDORES":
        datos = {
            "nit": v.texto("nit", maximo=20),
            "razon_social": v.texto("razon_social", maximo=150),
            "nombre_contacto": v.texto("nombre_contacto", maximo=100),
            "telefono": v.texto("telefono", maximo=20),
            "correo": v.correo("correo", maximo=255),
            "direccion": v.texto("direccion", maximo=255),
        }
    else:  # STOCK_INICIAL
        datos = {
            "codigo_producto": v.texto("codigo_producto", maximo=30),
            "codigo_bodega": v.texto("codigo_bodega"),
            "cantidad": v.numero("cantidad", mayor_que=Decimal(0)),
            "codigo_lote": v.texto("codigo_lote", obligatorio=False),
            "fecha_vencimiento": v.fecha("fecha_vencimiento"),
        }
    return datos, errores


class _Validador:
    def __init__(self, valores: dict[str, str], errores: list[dict]):
        self.valores = valores
        self.errores = errores

    def _error(self, campo: str, mensaje: str) -> None:
        self.errores.append({"campo": campo, "mensaje": mensaje})

    def texto(self, campo: str, maximo: int | None = None, obligatorio: bool = True) -> str | None:
        valor = self.valores.get(campo, "")
        if valor == "":
            if obligatorio:
                self._error(campo, f"El campo {campo} es obligatorio.")
            return None
        if maximo is not None and len(valor) > maximo:
            self._error(campo, f"El campo {campo} no puede tener más de {maximo} caracteres.")
        return valor

    def correo(self, campo: str, maximo: int) -> str | None:
        valor = self.texto(campo, maximo=maximo)
        if valor is not None and not _CORREO.match(valor):
            self._error(campo, f"El campo {campo} debe ser un correo electrónico válido.")
        return valor

    def numero(self, campo: str, minimo: Decimal | None = None, maximo: Decimal | None = None,
               mayor_que: Decimal | None = None) -> int | float | None:
        """Acepta 2500.5, 2500,5 (coma decimal, como en Excel en español) y con separador de miles (2.500,50)."""
        valor = self.texto(campo)
        if valor is None:
            return None
        try:
            numero = Decimal(_normalizar_numero(valor))
            if not numero.is_finite():
                raise InvalidOperation
        except InvalidOperation:
            self._error(campo, f"El campo {campo} debe ser un número.")
            return None
        if minimo is not None and numero < minimo:
            self._error(campo, f"El campo {campo} debe ser al menos {minimo}.")
        if mayor_que is not None and numero <= mayor_que:
            self._error(campo, f"El campo {campo} debe ser mayor que {mayor_que}.")
        if maximo is not None and numero > maximo:
            self._error(campo, f"El campo {campo} no puede ser mayor que {maximo}.")
        return int(numero) if numero == numero.to_integral_value() else float(numero)

    def fecha(self, campo: str) -> str | None:
        """Opcional, con el formato AAAA-MM-DD (en Excel, una celda de fecha)."""
        valor = self.texto(campo, obligatorio=False)
        if valor is None:
            return None
        try:
            return datetime.strptime(valor, "%Y-%m-%d").date().isoformat()
        except ValueError:
            self._error(campo, f"El campo {campo} debe ser una fecha con el formato AAAA-MM-DD.")
            return None
