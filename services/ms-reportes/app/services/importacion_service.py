"""Carga masiva validada (RF16). No sabe nada de HTTP.

1. Lee el archivo y valida cada fila con las reglas del servicio destino (errores con su campo).
2. Convierte la categoría, el producto y la bodega en sus identificadores (llamadas 6 y 7 de la Entrega 2).
3. Envía las filas válidas al servicio dueño del dato y agrega las que este rechace (sin campo).
4. Guarda la importación con sus errores.

Estados: PROCESADA si ninguna fila tiene error; CON_ERRORES si al menos una lo tiene (aunque no se cree ninguna);
FALLIDA si un servicio no respondió. En ese caso se guarda un error de toda la importación, con numero_fila 0.
"""

import uuid
from dataclasses import dataclass, field

from app.clients import catalogo, inventario, proveedores
from app.clients.base import ServicioNoDisponible
from app.errores import ApiError
from app.importers import filas as reglas
from app.importers.lector import leer
from app.models import ErrorImportacion, Importacion
from app.repositories import importacion_repository as repositorio

FILA_GENERAL = 0  # numero_fila del error que no es de una fila sino de toda la importación


@dataclass
class _Resultado:
    """Lo que se va acumulando mientras se procesa el archivo."""
    errores: list[ErrorImportacion] = field(default_factory=list)
    filas_con_error: set[int] = field(default_factory=set)

    def agregar(self, numero_fila: int, campo: str | None, mensaje: str) -> None:
        self.errores.append(ErrorImportacion(numero_fila=numero_fila, campo=campo, mensaje=mensaje[:500]))
        if numero_fila != FILA_GENERAL:
            self.filas_con_error.add(numero_fila)


def importar(tipo: str, nombre_archivo: str, contenido: bytes, id_usuario: int) -> Importacion:
    """422 si el archivo no se puede usar (formato, columnas, vacío): en ese caso no se guarda nada."""
    filas_leidas = leer(nombre_archivo, contenido, reglas.COLUMNAS[tipo])
    resultado = _Resultado()

    # 1. Validación de cada fila.
    validas: list[tuple[int, dict]] = []
    for fila in filas_leidas:
        datos, errores = reglas.validar(tipo, fila.valores)
        for error in errores:
            resultado.agregar(fila.numero, error["campo"], error["mensaje"])
        if not errores:
            validas.append((fila.numero, datos))

    creados = 0
    estado = "PROCESADA"
    enviando = False
    try:
        # 2. Conversión de códigos y nombres en identificadores.
        a_enviar = _convertir(tipo, validas, resultado) if validas else []

        # 3. Envío de las filas válidas.
        if a_enviar:
            enviando = True
            respuesta = _enviar(tipo, [datos for _, datos in a_enviar])
            creados = int(respuesta["creados"])
            for rechazo in respuesta["rechazados"]:
                # `fila` es la posición en la lista enviada, desde 1: se traduce al número de fila del archivo.
                numero = a_enviar[int(rechazo["fila"]) - 1][0]
                resultado.agregar(numero, None, str(rechazo["motivo"]))
    except ServicioNoDisponible as e:
        estado, creados = "FALLIDA", 0
        resultado.agregar(FILA_GENERAL, None, _mensaje_de_falla(f"{e.servicio} no respondió.", enviando))
    except (KeyError, IndexError, TypeError, ValueError):
        # Un servicio respondió 200 pero con otra forma.
        estado, creados = "FALLIDA", 0
        resultado.agregar(FILA_GENERAL, None, _mensaje_de_falla("Un servicio dio una respuesta no válida.", enviando))

    if estado != "FALLIDA" and resultado.filas_con_error:
        estado = "CON_ERRORES"

    importacion = Importacion(
        tipo=tipo,
        nombre_archivo=nombre_archivo[:255],
        estado=estado,
        filas_totales=len(filas_leidas),
        filas_validas=creados,
        filas_con_error=len(resultado.filas_con_error),
        id_usuario=id_usuario,
    )
    return repositorio.guardar(importacion, resultado.errores)


def listar(tipo: str | None, pagina: int, por_pagina: int) -> tuple[list[Importacion], int]:
    return repositorio.listar(tipo, pagina, por_pagina)


def buscar(id_importacion: int) -> Importacion:
    importacion = repositorio.buscar(id_importacion)
    if importacion is None:
        raise ApiError.no_existe("La importación no existe.")
    return importacion


def _mensaje_de_falla(motivo: str, enviando: bool) -> str:
    """Si la falla fue al enviar las filas, puede que el destino haya alcanzado a crear algunas."""
    if enviando:
        return f"{motivo} Revise si se cargaron datos antes de volver a subir el archivo."
    return f"{motivo} No se cargó ningún dato; intente de nuevo más tarde."


def _convertir(tipo: str, validas: list[tuple[int, dict]], resultado: _Resultado) -> list[tuple[int, dict]]:
    """Arma cada fila con la forma que espera el servicio destino. Las que no se pueden convertir quedan con error."""
    if tipo == "PROVEEDORES":
        return validas

    convertidas = []
    if tipo == "PRODUCTOS":
        ids_por_nombre = _agrupar(catalogo.categorias(), "nombre", "id_categoria")
        for numero, datos in validas:
            id_categoria = _unico(ids_por_nombre, datos["categoria"], numero, "categoria", resultado,
                                  "La categoría no existe.", "Hay más de una categoría con ese nombre.")
            if id_categoria is not None:
                convertidas.append((numero, {
                    "codigo": datos["codigo"],
                    "nombre": datos["nombre"],
                    "descripcion": datos["descripcion"],
                    "id_categoria": id_categoria,
                    "unidad_medida": datos["unidad_medida"],
                    "precio": datos["precio"],
                }))
        return convertidas

    # STOCK_INICIAL
    ids_producto = _agrupar(catalogo.productos(), "codigo", "id_producto")
    ids_bodega = _agrupar(inventario.bodegas(), "codigo", "id_bodega")
    for numero, datos in validas:
        id_producto = _unico(ids_producto, datos["codigo_producto"], numero, "codigo_producto", resultado,
                             "El producto no existe.", "Hay más de un producto con ese código.")
        id_bodega = _unico(ids_bodega, datos["codigo_bodega"], numero, "codigo_bodega", resultado,
                           "La bodega no existe.", "Hay más de una bodega con ese código.")
        if id_producto is not None and id_bodega is not None:
            fila = {"id_producto": id_producto, "id_bodega": id_bodega, "cantidad": datos["cantidad"]}
            # Los campos opcionales (codigo_lote?, fecha_vencimiento?) solo se envían si traen valor.
            for opcional in ("codigo_lote", "fecha_vencimiento"):
                if datos[opcional] is not None:
                    fila[opcional] = datos[opcional]
            convertidas.append((numero, fila))
    return convertidas


def _agrupar(elementos: list[dict], clave: str, identificador: str) -> dict[str, list[int]]:
    """Identificadores por nombre o código, sin distinguir mayúsculas ni espacios de los extremos."""
    grupos: dict[str, list[int]] = {}
    for elemento in elementos:
        grupos.setdefault(str(elemento[clave]).strip().casefold(), []).append(int(elemento[identificador]))
    return grupos


def _unico(grupos: dict[str, list[int]], valor: str, numero: int, campo: str, resultado: _Resultado,
           si_no_existe: str, si_se_repite: str) -> int | None:
    ids = grupos.get(valor.strip().casefold(), [])
    if len(ids) == 1:
        return ids[0]
    resultado.agregar(numero, campo, si_no_existe if not ids else si_se_repite)
    return None


def _enviar(tipo: str, filas: list[dict]) -> dict:
    if tipo == "PRODUCTOS":
        return catalogo.crear_productos(filas)
    if tipo == "PROVEEDORES":
        return proveedores.crear_proveedores(filas)
    # Una clave por importación: si se reintenta el envío, ms-inventario no duplica los movimientos.
    return inventario.carga_inicial(filas, str(uuid.uuid4()))
