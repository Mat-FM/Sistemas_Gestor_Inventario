"""Importación masiva validada (RF16): POST, GET /importaciones y GET /importaciones/{id}."""

import io
from datetime import datetime

import pytest
import requests
from openpyxl import Workbook

from tests.simulacion import Respuesta, paginado

USUARIO = {"X-User-Id": "7", "X-Request-Id": "id-del-gateway"}

CATEGORIAS = [
    {"id_categoria": 1, "nombre": "Bebidas", "id_categoria_padre": None},
    {"id_categoria": 2, "nombre": "Otros", "id_categoria_padre": None},
    {"id_categoria": 3, "nombre": "otros", "id_categoria_padre": 1},
]


def subir(client, nombre: str, contenido: bytes, tipo: str = "PRODUCTOS", cabeceras=USUARIO):
    return client.post("/importaciones", headers=cabeceras, content_type="multipart/form-data",
                       data={"tipo": tipo, "archivo": (io.BytesIO(contenido), nombre)})


def lote_que_crea_todo(llamada):
    return {"creados": len(llamada["json"]["filas"]), "rechazados": []}


def excel(filas: list[list]) -> bytes:
    libro = Workbook()
    for fila in filas:
        libro.active.append(fila)
    salida = io.BytesIO()
    libro.save(salida)
    return salida.getvalue()


# ---------- PRODUCTOS ----------

def test_importa_productos_y_reporta_cada_error_con_su_fila(client, servicios):
    servicios.responder("/categorias", CATEGORIAS)
    servicios.responder("/internas/productos/lote", {
        "creados": 2, "rechazados": [{"fila": 2, "motivo": "Ya existe un producto con ese código."}]})
    archivo = ("codigo;nombre;descripcion;categoria;unidad_medida;precio;columna_extra\n"
               "P-1;Agua;;bebidas;UNIDAD;1500,5;x\n"       # fila 2: categoría con otras mayúsculas, coma decimal
               "P-2;Gaseosa;350 ml; Bebidas ;UNIDAD;2500;\n"  # fila 3: la rechaza ms-catalogo
               ";;;;;;\n"                                   # fila 4: vacía, se salta
               "P-3;Jugo;;Inexistente;UNIDAD;abc;\n"         # fila 5: precio no válido
               "P-4;Té;;Otros;UNIDAD;10;\n"                 # fila 6: categoría repetida
               "P-5;Café;;Bebidas;UNIDAD;3000;\n").encode("utf-8-sig")

    respuesta = subir(client, "productos.csv", archivo)

    assert respuesta.status_code == 201
    datos = respuesta.get_json()
    assert datos | {"fecha": None} == datos | {
        "id_importacion": 1, "tipo": "PRODUCTOS", "nombre_archivo": "productos.csv", "estado": "CON_ERRORES",
        "filas_totales": 5, "filas_validas": 2, "filas_con_error": 3, "id_usuario": 7, "fecha": None}
    assert datos["errores"] == [
        {"numero_fila": 3, "campo": None, "mensaje": "Ya existe un producto con ese código."},
        {"numero_fila": 5, "campo": "precio", "mensaje": "El campo precio debe ser un número."},
        {"numero_fila": 6, "campo": "categoria", "mensaje": "Hay más de una categoría con ese nombre."},
    ]
    assert datos["fecha"].endswith("Z")

    # Solo se envían las filas válidas, ya con id_categoria, y con el mismo X-Request-Id.
    envio = servicios.llamadas_a("/internas/productos/lote")[0]
    assert [fila["codigo"] for fila in envio["json"]["filas"]] == ["P-1", "P-2", "P-5"]
    assert envio["json"]["filas"][0] == {"codigo": "P-1", "nombre": "Agua", "descripcion": None, "id_categoria": 1,
                                         "unidad_medida": "UNIDAD", "precio": 1500.5}
    assert envio["headers"]["X-Request-Id"] == "id-del-gateway"


def test_si_ninguna_fila_es_valida_no_se_llama_a_otros_servicios(client, servicios):
    respuesta = subir(client, "p.csv", b"codigo,nombre,descripcion,categoria,unidad_medida,precio\n,,,Bebidas,,-1\n")

    assert respuesta.get_json()["estado"] == "CON_ERRORES"
    assert respuesta.get_json()["filas_validas"] == 0
    assert servicios.llamadas == []


def test_importacion_sin_errores_queda_procesada(client, servicios):
    servicios.responder("/categorias", CATEGORIAS)
    servicios.responder("/internas/productos/lote", lote_que_crea_todo)

    respuesta = subir(client, "p.csv", b"codigo,nombre,descripcion,categoria,unidad_medida,precio\n"
                                       b"P-1,Agua,,Bebidas,UNIDAD,1500\n")

    assert respuesta.get_json()["estado"] == "PROCESADA"
    assert respuesta.get_json()["errores"] == []


def test_si_ms_catalogo_no_responde_queda_fallida_sin_cargar_nada(client, servicios):
    servicios.responder("/categorias", requests.ConnectionError("rechazada"))

    respuesta = subir(client, "p.csv", b"codigo,nombre,descripcion,categoria,unidad_medida,precio\n"
                                       b"P-1,Agua,,Bebidas,UNIDAD,1500\n")

    assert respuesta.status_code == 201
    datos = respuesta.get_json()
    assert datos["estado"] == "FALLIDA"
    assert datos["filas_validas"] == 0
    assert datos["errores"] == [{"numero_fila": 0, "campo": None,
                                 "mensaje": "ms-catalogo no respondió. No se cargó ningún dato; intente de nuevo "
                                            "más tarde."}]
    # Es una consulta: se reintentó 3 veces.
    assert len(servicios.llamadas_a("/categorias")) == 4


def test_si_falla_el_envio_de_productos_no_se_reintenta(client, servicios):
    servicios.responder("/categorias", CATEGORIAS)
    servicios.responder("/internas/productos/lote", Respuesta(500))

    respuesta = subir(client, "p.csv", b"codigo,nombre,descripcion,categoria,unidad_medida,precio\n"
                                       b"P-1,Agua,,Bebidas,UNIDAD,1500\n")

    assert respuesta.get_json()["estado"] == "FALLIDA"
    assert "Revise si se cargaron datos" in respuesta.get_json()["errores"][0]["mensaje"]
    # Repetirlo rechazaría como duplicadas las filas ya creadas.
    assert len(servicios.llamadas_a("/internas/productos/lote")) == 1


def test_una_respuesta_con_otra_forma_deja_la_importacion_fallida(client, servicios):
    servicios.responder("/categorias", CATEGORIAS)
    servicios.responder("/internas/productos/lote", {"otra": "forma"})

    respuesta = subir(client, "p.csv", b"codigo,nombre,descripcion,categoria,unidad_medida,precio\n"
                                       b"P-1,Agua,,Bebidas,UNIDAD,1500\n")

    assert respuesta.get_json()["estado"] == "FALLIDA"
    assert respuesta.get_json()["errores"][0]["mensaje"].startswith("Un servicio dio una respuesta no válida.")


# ---------- PROVEEDORES ----------

def test_importa_proveedores_sin_conversion(client, servicios):
    servicios.responder("/internas/proveedores/lote", lote_que_crea_todo)

    respuesta = subir(client, "prov.csv", b"nit,razon_social,nombre_contacto,telefono,correo,direccion\n"
                                          b"900-1,Dist,Ana,300,ana@x.co,Cra 1\n"
                                          b"900-2,Dist2,Luis,301,no-correo,\n", tipo="PROVEEDORES")

    datos = respuesta.get_json()
    assert (datos["estado"], datos["filas_validas"], datos["filas_con_error"]) == ("CON_ERRORES", 1, 1)
    assert datos["errores"] == [
        {"numero_fila": 3, "campo": "correo", "mensaje": "El campo correo debe ser un correo electrónico válido."},
        {"numero_fila": 3, "campo": "direccion", "mensaje": "El campo direccion es obligatorio."},
    ]
    assert servicios.llamadas_a("/internas/proveedores/lote")[0]["json"]["filas"] == [
        {"nit": "900-1", "razon_social": "Dist", "nombre_contacto": "Ana", "telefono": "300", "correo": "ana@x.co",
         "direccion": "Cra 1"}]


# ---------- STOCK_INICIAL ----------

def preparar_stock(servicios):
    servicios.responder("/productos", lambda llamada: paginado([{"id_producto": 10, "codigo": "CAF-500"}], llamada))
    servicios.responder("/bodegas", {"datos": [{"id_bodega": 1, "codigo": "B-CENTRO", "nombre": "Centro"}],
                                     "meta": {"total": 1}})


def test_importa_stock_inicial_desde_excel(client, servicios):
    preparar_stock(servicios)
    servicios.responder("/internas/saldos/carga-inicial", lote_que_crea_todo)
    archivo = excel([
        ["Codigo_Producto", "codigo_bodega", "cantidad", "codigo_lote", "fecha_vencimiento"],
        ["CAF-500", "b-centro", 12, "L-1", datetime(2027, 1, 31)],
        ["CAF-500", "B-CENTRO", 3.5, None, None],
        ["NO-EXISTE", "B-NORTE", 5, None, None],
        ["CAF-500", "B-CENTRO", 0, None, "31/01/2027"],
    ])

    respuesta = subir(client, "stock.xlsx", archivo, tipo="STOCK_INICIAL")

    datos = respuesta.get_json()
    assert (datos["estado"], datos["filas_totales"], datos["filas_validas"]) == ("CON_ERRORES", 4, 2)
    assert datos["errores"] == [
        {"numero_fila": 4, "campo": "codigo_producto", "mensaje": "El producto no existe."},
        {"numero_fila": 4, "campo": "codigo_bodega", "mensaje": "La bodega no existe."},
        {"numero_fila": 5, "campo": "cantidad", "mensaje": "El campo cantidad debe ser mayor que 0."},
        {"numero_fila": 5, "campo": "fecha_vencimiento",
         "mensaje": "El campo fecha_vencimiento debe ser una fecha con el formato AAAA-MM-DD."},
    ]
    envio = servicios.llamadas_a("/internas/saldos/carga-inicial")[0]
    # Los campos opcionales vacíos no se envían.
    assert envio["json"]["filas"] == [
        {"id_producto": 10, "id_bodega": 1, "cantidad": 12, "codigo_lote": "L-1", "fecha_vencimiento": "2027-01-31"},
        {"id_producto": 10, "id_bodega": 1, "cantidad": 3.5},
    ]
    assert envio["headers"]["Idempotency-Key"]


def test_la_identidad_del_gateway_se_reenvia_a_ms_inventario_en_cada_intento(client, servicios, sin_esperas):
    preparar_stock(servicios)
    servicios.responder("/internas/saldos/carga-inicial", Respuesta(503))
    cabeceras = {**USUARIO, "X-User-Rol": "ADMINISTRADOR"}

    subir(client, "stock.csv", b"codigo_producto,codigo_bodega,cantidad,codigo_lote,fecha_vencimiento\n"
                               b"CAF-500,B-CENTRO,5,,\n", tipo="STOCK_INICIAL", cabeceras=cabeceras)

    envios = servicios.llamadas_a("/internas/saldos/carga-inicial")
    assert len(envios) == 4
    assert all(envio["headers"]["X-User-Id"] == "7" and envio["headers"]["X-User-Rol"] == "ADMINISTRADOR"
               for envio in envios)


def test_si_la_peticion_no_trae_el_rol_no_se_inventa_la_cabecera(client, servicios):
    preparar_stock(servicios)
    servicios.responder("/internas/saldos/carga-inicial", lote_que_crea_todo)

    subir(client, "stock.csv", b"codigo_producto,codigo_bodega,cantidad,codigo_lote,fecha_vencimiento\n"
                               b"CAF-500,B-CENTRO,5,,\n", tipo="STOCK_INICIAL")

    envio = servicios.llamadas_a("/internas/saldos/carga-inicial")[0]
    assert envio["headers"]["X-User-Id"] == "7" and "X-User-Rol" not in envio["headers"]


def test_la_carga_inicial_se_reintenta_con_la_misma_clave(client, servicios, sin_esperas):
    preparar_stock(servicios)
    servicios.responder("/internas/saldos/carga-inicial", Respuesta(503))

    respuesta = subir(client, "stock.csv", b"codigo_producto,codigo_bodega,cantidad,codigo_lote,fecha_vencimiento\n"
                                           b"CAF-500,B-CENTRO,5,,\n", tipo="STOCK_INICIAL")

    assert respuesta.get_json()["estado"] == "FALLIDA"
    envios = servicios.llamadas_a("/internas/saldos/carga-inicial")
    assert len(envios) == 4
    assert len({envio["headers"]["Idempotency-Key"] for envio in envios}) == 1
    assert sin_esperas == [0.2, 0.4, 0.8]


# ---------- Archivo que no se puede usar (422, no se guarda) ----------

@pytest.mark.parametrize(("nombre", "contenido", "mensaje"), [
    ("p.xls", b"x", "El archivo debe ser CSV o Excel (.xlsx)."),
    ("p.csv", b"codigo,nombre\nA,B\n", "Faltan las columnas: descripcion, categoria, unidad_medida, precio."),
    ("p.csv", b"codigo,nombre,descripcion,categoria,unidad_medida,precio\n", "El archivo no tiene filas con datos."),
    ("p.csv", b"", "El archivo está vacío."),
    ("p.xlsx", b"no es un excel", "No se pudo leer el archivo de Excel."),
    ("p.csv", "codigo,nombre\nñ,é\n".encode("latin-1"), "El archivo CSV debe estar guardado en UTF-8."),
])
def test_rechaza_un_archivo_que_no_se_puede_usar(client, servicios, nombre, contenido, mensaje):
    respuesta = subir(client, nombre, contenido)

    assert respuesta.status_code == 422
    assert respuesta.get_json()["error"]["detalles"] == [{"campo": "archivo", "mensaje": mensaje}]
    assert client.get("/importaciones").get_json()["meta"]["total"] == 0


def test_valida_tipo_y_archivo(client):
    respuesta = client.post("/importaciones", headers=USUARIO, data={})

    assert respuesta.status_code == 422
    assert respuesta.get_json()["error"]["detalles"] == [
        {"campo": "tipo", "mensaje": "El campo tipo es obligatorio."},
        {"campo": "archivo", "mensaje": "El campo archivo es obligatorio."},
    ]
    assert subir(client, "p.csv", b"x", tipo="OTRO").get_json()["error"]["detalles"][0]["campo"] == "tipo"


def test_exige_la_cabecera_x_user_id(client):
    respuesta = subir(client, "p.csv", b"x", cabeceras={})

    assert respuesta.status_code == 400
    assert respuesta.get_json()["error"]["codigo"] == "PETICION_MAL_FORMADA"


# ---------- Consultas ----------

def test_lista_las_importaciones_mas_recientes_primero_y_filtra_por_tipo(client, servicios):
    servicios.responder("/internas/proveedores/lote", lote_que_crea_todo)
    servicios.responder("/categorias", CATEGORIAS)
    servicios.responder("/internas/productos/lote", lote_que_crea_todo)
    subir(client, "a.csv", b"nit,razon_social,nombre_contacto,telefono,correo,direccion\n1,a,b,c,d@e,f\n", "PROVEEDORES")
    subir(client, "b.csv", b"codigo,nombre,descripcion,categoria,unidad_medida,precio\nP,A,,Bebidas,U,1\n")

    listado = client.get("/importaciones?por_pagina=1").get_json()
    assert listado["meta"] == {"pagina": 1, "por_pagina": 1, "total": 2}
    assert listado["datos"][0]["nombre_archivo"] == "b.csv"
    assert "errores" not in listado["datos"][0]

    filtrado = client.get("/importaciones?tipo=PROVEEDORES").get_json()
    assert [i["nombre_archivo"] for i in filtrado["datos"]] == ["a.csv"]

    assert client.get("/importaciones?tipo=OTRO").status_code == 422


def test_consulta_una_importacion_con_sus_errores(client, servicios):
    subir(client, "p.csv", b"codigo,nombre,descripcion,categoria,unidad_medida,precio\n,A,,B,U,1\n")

    respuesta = client.get("/importaciones/1")

    assert respuesta.status_code == 200
    assert respuesta.get_json()["errores"] == [
        {"numero_fila": 2, "campo": "codigo", "mensaje": "El campo codigo es obligatorio."}]
    assert client.get("/importaciones/99").get_json()["error"]["mensaje"] == "La importación no existe."
    assert client.get("/importaciones/abc").status_code == 404


# ---------- Bloques de 1 000 filas, plazo y clave de la carga inicial (issue #10) ----------

ENCABEZADO_PROVEEDORES = b"nit,razon_social,nombre_contacto,telefono,correo,direccion\n"


def proveedores_csv(cantidad: int) -> bytes:
    filas = "".join(f"{n},Dist {n},Ana,300,a{n}@x.co,Cra {n}\n" for n in range(1, cantidad + 1))
    return ENCABEZADO_PROVEEDORES + filas.encode()


def test_las_filas_se_envian_en_bloques_de_mil(client, servicios):
    def lote(llamada):
        filas = llamada["json"]["filas"]
        # El segundo bloque rechaza su primera fila.
        rechazos = [{"fila": 1, "motivo": "Ya existe un proveedor con ese NIT."}] if filas[0]["nit"] == "1001" else []
        return {"creados": len(filas) - len(rechazos), "rechazados": rechazos}

    servicios.responder("/internas/proveedores/lote", lote)

    respuesta = subir(client, "prov.csv", proveedores_csv(2500), tipo="PROVEEDORES")

    envios = servicios.llamadas_a("/internas/proveedores/lote")
    assert [len(envio["json"]["filas"]) for envio in envios] == [1000, 1000, 500]
    datos = respuesta.get_json()
    assert (datos["estado"], datos["filas_totales"], datos["filas_validas"]) == ("CON_ERRORES", 2500, 2499)
    # La fila 1 del segundo bloque es el proveedor 1001, que está en la fila 1002 del archivo (la 1 es el encabezado).
    assert datos["errores"] == [{"numero_fila": 1002, "campo": None, "mensaje": "Ya existe un proveedor con ese NIT."}]


def test_si_falla_un_bloque_se_cuentan_los_ya_creados(client, servicios):
    def lote(llamada):
        if llamada["json"]["filas"][0]["nit"] == "1001":
            return Respuesta(500)
        return {"creados": len(llamada["json"]["filas"]), "rechazados": []}

    servicios.responder("/internas/proveedores/lote", lote)

    datos = subir(client, "prov.csv", proveedores_csv(1500), tipo="PROVEEDORES").get_json()

    assert (datos["estado"], datos["filas_validas"]) == ("FALLIDA", 1000)
    assert "Revise si se cargaron datos" in datos["errores"][0]["mensaje"]


def test_la_clave_de_la_carga_inicial_sale_del_contenido_y_el_plazo_de_las_filas(app, client, servicios):
    preparar_stock(servicios)
    servicios.responder("/internas/saldos/carga-inicial", lote_que_crea_todo)
    archivo = b"codigo_producto,codigo_bodega,cantidad,codigo_lote,fecha_vencimiento\nCAF-500,B-CENTRO,5,,\n"
    otro = b"codigo_producto,codigo_bodega,cantidad,codigo_lote,fecha_vencimiento\nCAF-500,B-CENTRO,6,,\n"

    subir(client, "stock.csv", archivo, tipo="STOCK_INICIAL")
    subir(client, "stock-copia.csv", archivo, tipo="STOCK_INICIAL")
    subir(client, "stock.csv", otro, tipo="STOCK_INICIAL")

    envios = servicios.llamadas_a("/internas/saldos/carga-inicial")
    claves = [envio["headers"]["Idempotency-Key"] for envio in envios]
    # El mismo archivo subido otra vez lleva la misma clave: ms-inventario no vuelve a sumar los saldos.
    assert claves[0] == claves[1] != claves[2]
    assert claves[0].startswith("carga-inicial-") and len(claves[0]) <= 200
    # Plazo: CALL_TIMEOUT_SECONDS más 10 ms por fila.
    assert envios[0]["timeout"] == pytest.approx(app.config["CALL_TIMEOUT_SECONDS"] + 0.01)


def test_las_bodegas_se_leen_de_todas_las_paginas(client, servicios):
    bodegas = [{"id_bodega": n, "codigo": f"B-{n}", "nombre": f"Bodega {n}"} for n in range(1, 151)]
    servicios.responder("/productos", lambda llamada: paginado([{"id_producto": 10, "codigo": "CAF-500"}], llamada))
    servicios.responder("/bodegas", lambda llamada: paginado(bodegas, llamada))
    servicios.responder("/internas/saldos/carga-inicial", lote_que_crea_todo)

    respuesta = subir(client, "stock.csv", b"codigo_producto,codigo_bodega,cantidad,codigo_lote,fecha_vencimiento\n"
                                           b"CAF-500,B-150,5,,\n", tipo="STOCK_INICIAL")

    assert respuesta.get_json()["estado"] == "PROCESADA"
    assert len(servicios.llamadas_a("/bodegas")) == 2
    assert servicios.llamadas_a("/internas/saldos/carga-inicial")[0]["json"]["filas"][0]["id_bodega"] == 150
