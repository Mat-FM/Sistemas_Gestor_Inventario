#!/usr/bin/env python3
"""Pruebas de funcionamiento de punta a punta del sistema completo.

Recorren el Gateway (la única entrada, RNF09) y, detrás de él, los seis microservicios y el cliente web, con los
flujos reales de la distribuidora: usuarios y roles, catálogo, proveedores, movimientos y traslados, compras,
alertas, reportes, importaciones y conteos. También comprueban salud y documentación (RNF08, RNF10), idempotencia
(RNF17), resiliencia (RNF18) y el límite de peticiones (RNF19).

Solo usa la biblioteca estándar de Python. Escribe datos de prueba (con un sufijo único por corrida): úsese en un
entorno de pruebas, no sobre los datos de la demo. Ver README.md.
"""
import argparse
import http.cookiejar
import json
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from base64 import urlsafe_b64decode
from collections import namedtuple
from datetime import datetime, timedelta, timezone

Respuesta = namedtuple("Respuesta", "estado datos texto cabeceras bytes")
RESULTADOS = []  # (grupo, nombre, estado, detalle)
E = {}  # lo que una prueba deja para las siguientes (identificadores, tokens)
GRUPO = [""]
ARGS = None


# ---------------------------------------------------------------- utilidades
class Fallo(AssertionError):
    pass


def exigir(condicion, mensaje):
    if not condicion:
        raise Fallo(mensaje)


def prueba(nombre, solo_con_docker=False):
    """Ejecuta la función al instante y anota el resultado; una falla no detiene las demás pruebas."""

    def decorador(funcion):
        if solo_con_docker and ARGS.sin_docker:
            RESULTADOS.append((GRUPO[0], nombre, "OMITIDA", "sin Docker (--sin-docker)"))
            return funcion
        try:
            detalle = funcion() or ""
            RESULTADOS.append((GRUPO[0], nombre, "OK", str(detalle)))
        except Fallo as e:
            RESULTADOS.append((GRUPO[0], nombre, "FALLA", str(e)))
        except Exception as e:  # un error inesperado también cuenta como falla, con su tipo
            RESULTADOS.append((GRUPO[0], nombre, "FALLA", f"{type(e).__name__}: {e}"))
        marca = {"OK": "  ✔", "FALLA": "  ✘", "OMITIDA": "  –"}[RESULTADOS[-1][2]]
        extra = f"  [{RESULTADOS[-1][3]}]" if RESULTADOS[-1][3] and RESULTADOS[-1][2] != "OK" else ""
        print(f"{marca} {nombre}{extra}", flush=True)
        return funcion

    return decorador


def grupo(nombre):
    GRUPO[0] = nombre
    print(f"\n== {nombre}", flush=True)


def llamar(metodo, ruta, token=None, cuerpo=None, clave=None, cabeceras=None, base=None, multipart=None, crudo=False, reintentar=True):
    """Una petición HTTP. Devuelve Respuesta aunque el estado sea de error (no lanza por 4xx/5xx). Con `reintentar`, un 429
    (el límite de 100 peticiones por minuto de cada usuario) espera el Retry-After y repite, para que el guion no dependa de su ritmo."""
    url = (base or ARGS.gateway) + ruta
    datos = None
    cab = {"Accept": "application/json", "X-Request-Id": f"prueba-{uuid.uuid4().hex[:12]}"}
    if token:
        cab["Authorization"] = f"Bearer {token}"
    if clave:
        cab["Idempotency-Key"] = clave
    if multipart is not None:
        limite = uuid.uuid4().hex
        partes = []
        for nombre_campo, valor in multipart["campos"].items():
            partes.append(f'--{limite}\r\nContent-Disposition: form-data; name="{nombre_campo}"\r\n\r\n{valor}\r\n'.encode())
        arch = multipart["archivo"]
        partes.append(
            (f'--{limite}\r\nContent-Disposition: form-data; name="archivo"; filename="{arch[0]}"\r\n'
             f"Content-Type: text/csv\r\n\r\n").encode() + arch[1] + b"\r\n")
        partes.append(f"--{limite}--\r\n".encode())
        datos = b"".join(partes)
        cab["Content-Type"] = f"multipart/form-data; boundary={limite}"
    elif cuerpo is not None:
        datos = json.dumps(cuerpo).encode()
        cab["Content-Type"] = "application/json"
    cab.update(cabeceras or {})
    peticion = urllib.request.Request(url, data=datos, method=metodo, headers=cab)
    try:
        r = urllib.request.urlopen(peticion, timeout=20)
        estado, bruto, cabs = r.status, r.read(), dict(r.headers)
    except urllib.error.HTTPError as e:
        estado, bruto, cabs = e.code, e.read(), dict(e.headers)
    texto = "" if crudo else bruto.decode("utf-8", "replace")
    try:
        parseado = json.loads(texto) if texto and not crudo else None
    except ValueError:
        parseado = None
    resultado = Respuesta(estado, parseado, texto, {k.lower(): v for k, v in cabs.items()}, bruto)
    if estado == 429 and reintentar and E.get("_reintentos_429", 0) < 40:
        E["_reintentos_429"] = E.get("_reintentos_429", 0) + 1
        time.sleep(min(int(resultado.cabeceras.get("retry-after", "10")), 65) + 1)
        return llamar(metodo, ruta, token, cuerpo, clave, cabeceras, base, multipart, crudo, reintentar)
    return resultado


def lista(r):
    """Los listados vienen como {datos: [...]} o como arreglo directo."""
    if isinstance(r.datos, dict):
        return r.datos.get("datos", [])
    return r.datos or []


def esperar(condicion, segundos=15, cada=0.5):
    fin = time.time() + segundos
    while time.time() < fin:
        valor = condicion()
        if valor:
            return valor
        time.sleep(cada)
    return None


def compose(*argumentos):
    comando = ARGS.compose.split() + list(argumentos)
    return subprocess.run(comando, capture_output=True, text=True, timeout=120)


def kubectl(*argumentos, tiempo=180):
    return subprocess.run(["kubectl", "-n", ARGS.k8s] + list(argumentos), capture_output=True, text=True, timeout=tiempo)


# Las pruebas que necesitan "estar dentro" del despliegue se escriben una vez y funcionan con Docker Compose o con Kubernetes (--k8s).
def ejecutar_en(servicio, *comando):
    if ARGS.k8s:
        return kubectl("exec", f"deploy/{servicio}", "--", *comando)
    return compose("exec", "-T", servicio, *comando)


def registros_de(servicio):
    if ARGS.k8s:
        # con varias copias (autoescalado) la petición pudo caer en cualquiera: se leen los registros de todas
        return kubectl("logs", "-l", f"app.kubernetes.io/name={servicio}", "--since=2m", "--max-log-requests=10", "--prefix=false").stdout
    return compose("logs", "--no-log-prefix", "--since", "2m", servicio).stdout


def parar(servicio):
    if ARGS.k8s:
        kubectl("scale", f"deploy/{servicio}", "--replicas=0")
        kubectl("wait", "--for=delete", "pod", "-l", f"app.kubernetes.io/name={servicio}", "--timeout=90s")
    else:
        compose("stop", servicio)


def arrancar(servicio):
    if ARGS.k8s:
        kubectl("scale", f"deploy/{servicio}", "--replicas=1")
        kubectl("rollout", "status", f"deploy/{servicio}", "--timeout=120s")
    else:
        compose("start", servicio)


def interno(servicio_puerto, ruta):
    """GET dentro de la red de contenedores (los microservicios no se publican, RNF09), lanzado desde el contenedor del Gateway."""
    codigo = ('$c=stream_context_create(["http"=>["ignore_errors"=>true,"timeout"=>5]]);'
              f'$b=@file_get_contents("http://{servicio_puerto}{ruta}",false,$c);'
              'echo ($http_response_header[0] ?? "sin respuesta"),"|",$b;')
    r = ejecutar_en("api-gateway", "php", "-r", codigo)
    estado_linea, _, cuerpo = r.stdout.partition("|")
    partes = estado_linea.split()
    return (int(partes[1]) if len(partes) > 1 and partes[1].isdigit() else 0), cuerpo


def jwt(token):
    carga = token.split(".")[1]
    return json.loads(urlsafe_b64decode(carga + "=" * (-len(carga) % 4)))


def sesion(correo, clave):
    return llamar("POST", "/api/auth/login", cuerpo={"correo": correo, "contrasena": clave})  # un 429 se espera y se repite


def hoy_utc():
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def en_dias(n):
    return (datetime.now(timezone.utc) + timedelta(days=n)).strftime("%Y-%m-%d")


def clave():
    return f"prueba-{uuid.uuid4()}"


def saldo(id_producto, id_bodega, token=None):
    r = llamar("GET", f"/api/saldos?id_producto={id_producto}&id_bodega={id_bodega}", token or E["admin"])
    filas = lista(r)
    return filas[0]["cantidad_disponible"] if filas else 0


# ---------------------------------------------------------------- pruebas
def salud_y_documentacion():
    grupo("1. Salud y documentación (RNF08, RNF10)")

    @prueba("El Gateway responde /health y /docs")
    def _():
        h = llamar("GET", "/health")
        exigir(h.estado == 200 and h.datos.get("estado") == "ok", f"/health dio {h.estado}: {h.texto[:80]}")
        exigir(llamar("GET", "/docs", crudo=True).estado == 200, "/docs no responde 200")

    internos = {"ms-catalogo": "ms-catalogo:8000", "ms-proveedores": "ms-proveedores:8000", "ms-inventario": "ms-inventario:3000",
                "ms-compras": "ms-compras:3000", "ms-notificaciones": "ms-notificaciones:5000", "ms-reportes": "ms-reportes:5000"}
    for nombre, direccion in internos.items():
        def comprobar(nombre=nombre, direccion=direccion):
            estado, cuerpo = interno(direccion, "/health")
            exigir(estado == 200, f"/health dio {estado}")
            exigir(nombre.replace("ms-", "") in cuerpo or "ok" in cuerpo, f"/health no dice quién es: {cuerpo[:80]}")
            estado_docs, _ = interno(direccion, "/docs")
            exigir(estado_docs in (200, 301, 302), f"/docs dio {estado_docs}")
            return "health y docs"

        prueba(f"{nombre}: /health y /docs desde dentro de la red", solo_con_docker=True)(comprobar)

    @prueba("El cliente web responde")
    def _():
        r = llamar("GET", "/login", base=ARGS.web, crudo=True)
        exigir(r.estado == 200 and b"<form" in r.bytes, f"/login dio {r.estado}")


def aislamiento():
    grupo("2. Un solo punto de entrada (RNF09)")

    @prueba("Solo el Gateway y el cliente web se ofrecen al usuario; todo escucha en 127.0.0.1", solo_con_docker=True)
    def _():
        if ARGS.k8s:
            svc = json.loads(kubectl("get", "svc", "-o", "json").stdout)["items"]
            expuestos = [x["metadata"]["name"] for x in svc if x["spec"].get("type", "ClusterIP") != "ClusterIP"]
            exigir(not expuestos, f"Services que no son ClusterIP: {expuestos}")
            ingress = json.loads(kubectl("get", "ingress", "-o", "json").stdout)["items"]
            destinos = {r["http"]["paths"][0]["backend"]["service"]["name"] for i in ingress for r in i["spec"]["rules"]}
            exigir(destinos == {"api-gateway", "web-client"}, f"el Ingress publica {sorted(destinos)} (solo debe publicar api-gateway y web-client)")
            return "todos los Service son ClusterIP; el Ingress solo enruta al Gateway y al cliente web"
        r = compose("ps", "--format", "json")
        servicios = {}
        for linea in r.stdout.splitlines():
            if linea.strip().startswith("{"):
                d = json.loads(linea)
                servicios[d["Service"]] = d.get("Publishers") or []
        for pub in servicios.values():
            for p in pub:
                exigir(p.get("URL") in ("127.0.0.1", "::1", "") or p.get("PublishedPort", 0) == 0, f"publicado fuera de 127.0.0.1: {p}")
        for oculto in ("ms-catalogo", "ms-proveedores", "ms-reportes"):
            exigir(not [p for p in servicios.get(oculto, []) if p.get("PublishedPort")], f"{oculto} publica un puerto")
        return f"{sum(1 for s in servicios.values() if any(p.get('PublishedPort') for p in s))} contenedores publican puertos (solo loopback)"

    @prueba("Una ruta que el Gateway no publica es 404 (por ejemplo /internas)")
    def _():
        t = llamar("POST", "/api/auth/login", cuerpo={"correo": "x", "contrasena": "y"})  # solo para tener un estado base
        exigir(t.estado in (401, 422, 429), f"login inválido dio {t.estado}")
        r = llamar("GET", "/api/internas/saldos/carga-inicial", E.get("admin"))
        exigir(r.estado in (401, 404), f"/internas respondió {r.estado}")


def autenticacion():
    grupo("3. Autenticación y seguridad (RF08, RNF07)")
    clave_inicial, clave_nueva = ARGS.admin_clave, ARGS.admin_clave_nueva

    @prueba("El administrador sembrado entra y su contraseña inicial obliga a cambiarla")
    def _():
        r = sesion(ARGS.admin_correo, clave_inicial)
        if r.estado == 401:  # corrida repetida: la clave ya se cambió
            r = sesion(ARGS.admin_correo, clave_nueva)
            exigir(r.estado == 200, f"login dio {r.estado}")
            E["admin"] = r.datos["token"]
            return "ya había cambiado su contraseña (corrida repetida)"
        exigir(r.estado == 200, f"login dio {r.estado}: {r.texto[:100]}")
        exigir(r.datos["usuario"]["debe_cambiar_contrasena"] is True, "la contraseña inicial no obliga a cambiarla")
        E["admin"] = r.datos["token"]
        bloqueo = llamar("GET", "/api/bodegas", E["admin"])
        exigir(bloqueo.estado in (403, 409, 428), f"con la contraseña pendiente, /bodegas dio {bloqueo.estado} (debía bloquear)")
        c = llamar("PUT", "/api/auth/contrasena", E["admin"], {"contrasena_actual": clave_inicial, "contrasena_nueva": clave_nueva})
        exigir(c.estado in (200, 204), f"cambiar contraseña dio {c.estado}: {c.texto[:100]}")
        r2 = sesion(ARGS.admin_correo, clave_nueva)
        exigir(r2.estado == 200 and not r2.datos["usuario"]["debe_cambiar_contrasena"], "tras cambiarla sigue pendiente")
        E["admin"] = r2.datos["token"]
        return "cambio de contraseña forzado verificado"

    @prueba("El token es un JWT firmado que vence en 60 minutos")
    def _():
        c = jwt(E["admin"])
        exigir(c["exp"] - c["iat"] == 3600, f"dura {c['exp'] - c['iat']} s")

    @prueba("Sin token, con token falso o con contraseña errónea: 401")
    def _():
        exigir(llamar("GET", "/api/bodegas").estado == 401, "sin token no dio 401")
        exigir(llamar("GET", "/api/bodegas", "abc.def.ghi").estado == 401, "token falso no dio 401")
        r = sesion(ARGS.admin_correo, "incorrecta")
        exigir(r.estado == 401 and r.datos["error"]["codigo"] == "CREDENCIALES_INVALIDAS", f"clave errónea dio {r.estado} {r.texto[:100]}")

    @prueba("Los errores tienen la forma común {error: {codigo, mensaje, detalles}}")
    def _():
        r = llamar("GET", "/api/productos/999999", E["admin"])
        exigir(r.estado == 404 and set(r.datos["error"]) >= {"codigo", "mensaje", "detalles"}, f"404 con forma {r.texto[:100]}")


def usuarios_y_roles():
    grupo("4. Usuarios y permisos por rol (RF07)")
    sufijo = E["sufijo"]

    @prueba("El administrador crea bodegas, un operador, un vendedor y un contador")
    def _():
        for n in (1, 2):
            r = llamar("POST", "/api/bodegas", E["admin"], {"codigo": f"B{n}{sufijo}", "nombre": f"Bodega {n} {sufijo}", "ciudad": "Manizales", "direccion": f"Calle {n}"})
            exigir(r.estado == 201, f"crear bodega {n} dio {r.estado}: {r.texto[:100]}")
            E[f"bodega{n}"] = r.datos["id_bodega"]
        roles = {x["nombre"]: x["id_rol"] for x in lista(llamar("GET", "/api/roles", E["admin"]))}
        exigir({"OPERADOR_BODEGA", "VENDEDOR", "CONTADOR"} <= set(roles), f"roles: {list(roles)}")
        temporal = "Temporal2026"
        for clave_rol, rol, bodega in (("operador", "OPERADOR_BODEGA", E["bodega1"]), ("vendedor", "VENDEDOR", None), ("contador", "CONTADOR", None), ("adminweb", "ADMINISTRADOR", None), ("adminmatriz", "ADMINISTRADOR", None)):
            cuerpo = {"nombre": f"Prueba {clave_rol}", "correo": f"{clave_rol}.{sufijo}@prueba.test", "id_rol": roles[rol], "contrasena_temporal": temporal}
            if bodega:
                cuerpo["id_bodega"] = bodega
            r = llamar("POST", "/api/usuarios", E["admin"], cuerpo)
            exigir(r.estado == 201, f"crear {clave_rol} dio {r.estado}: {r.texto[:120]}")
            s = sesion(cuerpo["correo"], temporal)
            exigir(s.estado == 200 and s.datos["usuario"]["debe_cambiar_contrasena"], f"{clave_rol}: la contraseña temporal no obliga a cambiarla")
            c = llamar("PUT", "/api/auth/contrasena", s.datos["token"], {"contrasena_actual": temporal, "contrasena_nueva": "ClaveUsuario2026"})
            exigir(c.estado in (200, 204), f"{clave_rol}: cambiar contraseña dio {c.estado}")
            E[clave_rol] = sesion(cuerpo["correo"], "ClaveUsuario2026").datos["token"]
            E[f"id_{clave_rol}"] = r.datos["id_usuario"]

    @prueba("Un correo repetido es 409 CORREO_DUPLICADO")
    def _():
        roles = {x["nombre"]: x["id_rol"] for x in lista(llamar("GET", "/api/roles", E["admin"]))}
        r = llamar("POST", "/api/usuarios", E["admin"], {"nombre": "Otro", "correo": f"vendedor.{sufijo}@prueba.test", "id_rol": roles["VENDEDOR"], "contrasena_temporal": "Temporal2026"})
        exigir(r.estado == 409 and r.datos["error"]["codigo"] == "CORREO_DUPLICADO", f"dio {r.estado} {r.texto[:100]}")

    @prueba("Cada rol solo hace lo suyo: 403 fuera de su matriz de permisos")
    def _():
        exigir(llamar("POST", "/api/bodegas", E["operador"], {"codigo": "X", "nombre": "X", "ciudad": "X", "direccion": "X"}).estado == 403, "el operador creó una bodega")
        exigir(llamar("GET", "/api/usuarios", E["vendedor"]).estado == 403, "el vendedor listó usuarios")
        exigir(llamar("POST", "/api/movimientos", E["contador"], {"tipo": "ENTRADA", "id_producto": 1, "id_bodega": E["bodega1"], "cantidad": 1}, clave()).estado == 403, "el contador registró un movimiento")
        exigir(llamar("GET", "/api/movimientos", E["contador"]).estado == 200, "el contador no puede ver el kardex")
        exigir(llamar("GET", "/api/productos", E["vendedor"]).estado == 200, "el vendedor no puede consultar productos (RF12)")

    @prueba("Inactivar a un usuario cierra sus sesiones al instante")
    def _():
        r = llamar("POST", "/api/usuarios", E["admin"], {"nombre": "Temporal", "correo": f"baja.{sufijo}@prueba.test",
                   "id_rol": [x["id_rol"] for x in lista(llamar("GET", "/api/roles", E["admin"])) if x["nombre"] == "VENDEDOR"][0], "contrasena_temporal": "Temporal2026"})
        exigir(r.estado == 201, f"crear dio {r.estado}")
        s = sesion(f"baja.{sufijo}@prueba.test", "Temporal2026")
        llamar("PUT", "/api/auth/contrasena", s.datos["token"], {"contrasena_actual": "Temporal2026", "contrasena_nueva": "ClaveUsuario2026"})
        t = sesion(f"baja.{sufijo}@prueba.test", "ClaveUsuario2026").datos["token"]
        exigir(llamar("GET", "/api/productos", t).estado == 200, "no entra antes de inactivarlo")
        exigir(llamar("POST", f"/api/usuarios/{r.datos['id_usuario']}/inactivar", E["admin"], {}).estado in (200, 204), "no se pudo inactivar")
        exigir(llamar("GET", "/api/productos", t).estado == 401, "el token sigue valiendo tras inactivarlo")


def catalogo_y_proveedores():
    grupo("5. Catálogo y proveedores (RF01, RF02, RF03, RF12)")
    sufijo = E["sufijo"]

    @prueba("Categorías de dos niveles y tres productos")
    def _():
        padre = llamar("POST", "/api/categorias", E["admin"], {"nombre": f"Bebidas {sufijo}"})
        exigir(padre.estado == 201, f"categoría dio {padre.estado}: {padre.texto[:100]}")
        hija = llamar("POST", "/api/categorias", E["admin"], {"nombre": f"Jugos {sufijo}", "id_categoria_padre": padre.datos["id_categoria"]})
        exigir(hija.estado == 201, f"subcategoría dio {hija.estado}: {hija.texto[:100]}")
        E["categoria"] = hija.datos["id_categoria"]
        for n, (nombre, precio) in enumerate((("Café molido 500 g", 18500), ("Jugo de mora 1 L", 4200), ("Panela redonda", 3100)), 1):
            r = llamar("POST", "/api/productos", E["admin"], {"codigo": f"P{n}-{sufijo}", "nombre": f"{nombre} {sufijo}", "descripcion": "Producto de prueba",
                       "id_categoria": E["categoria"], "unidad_medida": "UNIDAD", "precio": precio})
            exigir(r.estado == 201, f"producto {n} dio {r.estado}: {r.texto[:120]}")
            E[f"p{n}"] = r.datos["id_producto"]

    @prueba("Un código de producto repetido es 409 CODIGO_DUPLICADO")
    def _():
        r = llamar("POST", "/api/productos", E["admin"], {"codigo": f"P1-{sufijo}", "nombre": "Repetido", "descripcion": "x", "id_categoria": E["categoria"], "unidad_medida": "UNIDAD", "precio": 1})
        exigir(r.estado == 409 and r.datos["error"]["codigo"] == "CODIGO_DUPLICADO", f"dio {r.estado} {r.texto[:100]}")

    @prueba("Se busca por nombre y por código, y se da de baja sin borrar")
    def _():
        exigir(any(p["id_producto"] == E["p2"] for p in lista(llamar("GET", f"/api/productos?nombre=mora", E["vendedor"]))), "no encontró por nombre")
        exigir(any(p["id_producto"] == E["p1"] for p in lista(llamar("GET", f"/api/productos?codigo=P1-{sufijo}", E["vendedor"]))), "no encontró por código")
        exigir(llamar("POST", f"/api/productos/{E['p3']}/inactivar", E["admin"], {}).estado in (200, 204), "no se pudo inactivar")
        exigir(llamar("GET", f"/api/productos/{E['p3']}", E["admin"]).datos["estado"] == "INACTIVO", "no quedó inactivo")
        exigir(llamar("POST", f"/api/productos/{E['p3']}/activar", E["admin"], {}).estado in (200, 204), "no se pudo reactivar")

    @prueba("Un proveedor con sus productos; un NIT repetido es 409")
    def _():
        cuerpo = {"nit": f"900{sufijo}1", "razon_social": f"Distribuciones Andinas {sufijo}", "nombre_contacto": "Marta Ríos", "telefono": "3101234567", "correo": f"ventas.{sufijo}@andinas.test", "direccion": "Av. Santander 10"}
        r = llamar("POST", "/api/proveedores", E["admin"], cuerpo)
        exigir(r.estado == 201, f"proveedor dio {r.estado}: {r.texto[:120]}")
        E["proveedor"] = r.datos["id_proveedor"]
        exigir(llamar("POST", f"/api/proveedores/{E['proveedor']}/productos", E["admin"], {"id_producto": E["p1"]}).estado in (200, 201, 204), "asociar producto falló")
        asociados = lista(llamar("GET", f"/api/proveedores/{E['proveedor']}/productos", E["admin"]))
        exigir(any(a.get("id_producto") == E["p1"] for a in asociados), f"el producto no aparece asociado: {asociados}")
        dup = llamar("POST", "/api/proveedores", E["admin"], cuerpo)
        exigir(dup.estado == 409, f"NIT repetido dio {dup.estado}")


def inventario():
    grupo("6. Inventario: movimientos, lotes, traslados, trazabilidad (RF04, RF05, RF10, RF17, RNF17)")
    b1, b2, p1, p2 = E["bodega1"], E["bodega2"], E["p1"], E["p2"]

    @prueba("Entrada con lote y vencimiento; el saldo sube")
    def _():
        r = llamar("POST", "/api/movimientos", E["operador"], {"tipo": "ENTRADA", "id_producto": p1, "id_bodega": b1, "cantidad": 100,
                   "lote": {"codigo_lote": f"L-{E['sufijo']}-A", "fecha_vencimiento": en_dias(40)}}, clave())
        exigir(r.estado == 201, f"entrada dio {r.estado}: {r.texto[:150]}")
        E["mov1"] = r.datos["id_movimiento"]
        exigir(saldo(p1, b1) == 100, f"el saldo es {saldo(p1, b1)} y debía ser 100")

    @prueba("Repetir la misma petición con la misma Idempotency-Key no duplica (RNF17)")
    def _():
        k = clave()
        cuerpo = {"tipo": "ENTRADA", "id_producto": p1, "id_bodega": b1, "cantidad": 10, "lote": {"codigo_lote": f"L-{E['sufijo']}-B", "fecha_vencimiento": en_dias(10)}}
        a = llamar("POST", "/api/movimientos", E["operador"], cuerpo, k)
        b = llamar("POST", "/api/movimientos", E["operador"], cuerpo, k)
        exigir(a.estado == 201 and b.estado == 200, f"estados {a.estado}/{b.estado} (esperado 201/200)")
        exigir(a.datos["id_movimiento"] == b.datos["id_movimiento"], "la repetición creó otro movimiento")
        exigir(saldo(p1, b1) == 110, f"el saldo es {saldo(p1, b1)} y debía ser 110 (sin duplicar)")
        sin = llamar("POST", "/api/movimientos", E["operador"], cuerpo)
        exigir(sin.estado == 400, f"sin Idempotency-Key dio {sin.estado} (esperado 400)")

    @prueba("La salida consume primero el lote que vence antes (FEFO) y sugiere de qué lotes sacar")
    def _():
        sugerencia = llamar("GET", f"/api/lotes/sugerencia-salida?id_producto={p1}&id_bodega={b1}&cantidad=15", E["operador"])
        exigir(sugerencia.estado == 200, f"sugerencia dio {sugerencia.estado}")
        r = llamar("POST", "/api/movimientos", E["operador"], {"tipo": "SALIDA", "id_producto": p1, "id_bodega": b1, "cantidad": 15}, clave())
        exigir(r.estado == 201, f"salida dio {r.estado}: {r.texto[:120]}")
        lotes = lista(llamar("GET", f"/api/lotes?id_producto={p1}&id_bodega={b1}", E["operador"]))
        por_codigo = {x["codigo_lote"]: x["cantidad_disponible"] for x in lotes}
        E["lote_a"] = [x["id_lote"] for x in lotes if x["codigo_lote"] == f"L-{E['sufijo']}-A"][0]
        exigir(por_codigo.get(f"L-{E['sufijo']}-B") == 0 and por_codigo.get(f"L-{E['sufijo']}-A") == 95, f"lotes tras la salida: {por_codigo} (esperado B=0 y A=95)")

    @prueba("Una salida mayor al stock es 409 STOCK_INSUFICIENTE con lo disponible")
    def _():
        r = llamar("POST", "/api/movimientos", E["operador"], {"tipo": "SALIDA", "id_producto": p1, "id_bodega": b1, "cantidad": 9999}, clave())
        exigir(r.estado == 409 and r.datos["error"]["codigo"] == "STOCK_INSUFICIENTE", f"dio {r.estado} {r.texto[:120]}")

    @prueba("Un operador no mueve mercancía de otra bodega (403)")
    def _():
        r = llamar("POST", "/api/movimientos", E["operador"], {"tipo": "ENTRADA", "id_producto": p1, "id_bodega": b2, "cantidad": 1}, clave())
        exigir(r.estado == 403, f"dio {r.estado}")

    @prueba("Traslado entre bodegas en dos pasos: envío y recepción")
    def _():
        t = llamar("POST", "/api/traslados", E["operador"], {"id_producto": p1, "id_bodega_origen": b1, "id_bodega_destino": b2, "cantidad": 20, "id_lote": E["lote_a"]}, clave())
        exigir(t.estado == 201, f"enviar dio {t.estado}: {t.texto[:120]}")
        exigir(saldo(p1, b1) == 75 and saldo(p1, b2) == 0, f"en tránsito: origen {saldo(p1, b1)} y destino {saldo(p1, b2)} (esperado 75/0)")
        k = clave()
        sin_permiso = llamar("POST", f"/api/traslados/{t.datos['id_traslado']}/recepcion", E["operador"], {}, k)
        exigir(sin_permiso.estado == 403, f"el operador de la bodega de origen recibió: {sin_permiso.estado} (esperado 403)")
        r = llamar("POST", f"/api/traslados/{t.datos['id_traslado']}/recepcion", E["admin"], {}, k)
        exigir(r.estado in (200, 201), f"recibir dio {r.estado}: {r.texto[:120]}")
        exigir(saldo(p1, b2) == 20, f"el destino quedó con {saldo(p1, b2)} (esperado 20)")
        again = llamar("POST", f"/api/traslados/{t.datos['id_traslado']}/recepcion", E["admin"], {}, k)
        exigir(again.estado == 200 and saldo(p1, b2) == 20, "repetir la recepción duplicó la mercancía")

    @prueba("Devolución de cliente y ajuste manual dejan su rastro")
    def _():
        d = llamar("POST", "/api/movimientos", E["admin"], {"tipo": "DEVOLUCION_CLIENTE", "id_producto": p1, "id_bodega": b1, "cantidad": 2, "motivo": "Empaque dañado"}, clave())
        exigir(d.estado == 201, f"devolución dio {d.estado}: {d.texto[:150]}")
        a = llamar("POST", "/api/movimientos", E["admin"], {"tipo": "AJUSTE", "id_producto": p1, "id_bodega": b1, "cantidad": -1, "motivo": "Merma"}, clave())
        exigir(a.estado == 201, f"ajuste dio {a.estado}: {a.texto[:150]}")
        exigir(saldo(p1, b1) == 76, f"saldo {saldo(p1, b1)} (esperado 76 = 75 + 2 - 1)")

    @prueba("El kardex dice quién, cuándo y qué (RF10) y se filtra por producto y tipo")
    def _():
        k = lista(llamar("GET", f"/api/movimientos?id_producto={p1}&id_bodega={b1}&por_pagina=100", E["contador"]))
        exigir(len(k) >= 6, f"el kardex trae {len(k)} movimientos")
        exigir(all(m.get("id_usuario") and m.get("fecha") and m.get("tipo") for m in k), "hay movimientos sin usuario, fecha o tipo")
        exigir(any(m["id_usuario"] == E["id_operador"] for m in k), "no se ve al operador como autor")
        solo = lista(llamar("GET", f"/api/movimientos?id_producto={p1}&tipo=AJUSTE", E["contador"]))
        exigir(solo and all(m["tipo"] == "AJUSTE" for m in solo), "el filtro por tipo no funciona")


def compras():
    grupo("7. Compras: órdenes, recepciones y devoluciones a proveedor (RF06, RF13)")
    b1, p1, p2 = E["bodega1"], E["p1"], E["p2"]

    @prueba("Crear, enviar y recibir una orden por partes; el stock sube y la orden cambia de estado")
    def _():
        o = llamar("POST", "/api/ordenes-compra", E["admin"], {"id_proveedor": E["proveedor"], "id_bodega_destino": b1, "fecha_esperada": en_dias(7),
                   "detalles": [{"id_producto": p2, "cantidad_pedida": 50, "precio_unitario": 2900}]})
        exigir(o.estado == 201, f"crear dio {o.estado}: {o.texto[:150]}")
        E["orden"], E["detalle"] = o.datos["id_orden"], o.datos["detalles"][0]["id_detalle"]
        exigir(llamar("PATCH", f"/api/ordenes-compra/{E['orden']}/estado", E["admin"], {"estado": "ENVIADA"}).estado == 200, "enviar la orden falló")
        r1 = llamar("POST", f"/api/ordenes-compra/{E['orden']}/recepciones", E["operador"], {"lineas": [{"id_detalle": E["detalle"], "cantidad": 30,
                    "codigo_lote": f"C-{E['sufijo']}-1", "fecha_vencimiento": en_dias(60)}]}, clave())
        exigir(r1.estado in (200, 201), f"recepción parcial dio {r1.estado}: {r1.texto[:150]}")
        exigir(llamar("GET", f"/api/ordenes-compra/{E['orden']}", E["admin"]).datos["estado"] == "RECIBIDA_PARCIAL", "la orden no quedó RECIBIDA_PARCIAL")
        r2 = llamar("POST", f"/api/ordenes-compra/{E['orden']}/recepciones", E["operador"], {"lineas": [{"id_detalle": E["detalle"], "cantidad": 20,
                    "codigo_lote": f"C-{E['sufijo']}-2", "fecha_vencimiento": en_dias(90)}]}, clave())
        exigir(r2.estado in (200, 201), f"segunda recepción dio {r2.estado}: {r2.texto[:150]}")
        exigir(llamar("GET", f"/api/ordenes-compra/{E['orden']}", E["admin"]).datos["estado"] == "RECIBIDA", "la orden no quedó RECIBIDA")
        exigir(saldo(p2, b1) == 50, f"el stock de p2 es {saldo(p2, b1)} (esperado 50)")

    @prueba("No se recibe más de lo pedido")
    def _():
        r = llamar("POST", f"/api/ordenes-compra/{E['orden']}/recepciones", E["admin"], {"lineas": [{"id_detalle": E["detalle"], "cantidad": 1}]}, clave())
        exigir(r.estado in (409, 422), f"recibir de más dio {r.estado}")

    @prueba("Devolución a proveedor: sale del inventario")
    def _():
        antes = saldo(p2, b1)
        r = llamar("POST", "/api/devoluciones-proveedor", E["admin"], {"id_proveedor": E["proveedor"], "id_producto": p2, "id_bodega": b1, "cantidad": 5,
                   "motivo": "Producto golpeado", "id_orden": E["orden"]}, clave())
        exigir(r.estado == 201, f"devolución dio {r.estado}: {r.texto[:150]}")
        exigir(saldo(p2, b1) == antes - 5, f"el stock pasó de {antes} a {saldo(p2, b1)}")

    @prueba("Una orden anulada no se puede recibir")
    def _():
        o = llamar("POST", "/api/ordenes-compra", E["admin"], {"id_proveedor": E["proveedor"], "id_bodega_destino": b1, "fecha_esperada": en_dias(7),
                   "detalles": [{"id_producto": p1, "cantidad_pedida": 5, "precio_unitario": 100}]})
        llamar("PATCH", f"/api/ordenes-compra/{o.datos['id_orden']}/estado", E["admin"], {"estado": "ANULADA"})
        r = llamar("POST", f"/api/ordenes-compra/{o.datos['id_orden']}/recepciones", E["admin"], {"lineas": [{"id_detalle": o.datos["detalles"][0]["id_detalle"], "cantidad": 1}]}, clave())
        exigir(r.estado in (409, 422), f"recibir una orden anulada dio {r.estado}")


def alertas():
    grupo("8. Alertas y notificaciones (RF09, RF17)")
    b1, p1 = E["bodega1"], E["p1"]

    @prueba("Una salida que deja el stock bajo el mínimo genera la alerta STOCK_BAJO (una sola)")
    def _():
        exigir(llamar("PUT", f"/api/umbrales/{p1}", E["admin"], {"cantidad_minima": 70}).estado in (200, 201), "no se pudo fijar el mínimo")
        exigir(llamar("POST", "/api/movimientos", E["operador"], {"tipo": "SALIDA", "id_producto": p1, "id_bodega": b1, "cantidad": 30}, clave()).estado == 201, "la salida falló")

        def buscar():
            return [n for n in lista(llamar("GET", "/api/notificaciones?leida=false&por_pagina=100", E["admin"])) if n.get("tipo") == "STOCK_BAJO" and n.get("id_producto") == p1]

        e = esperar(buscar, 15)
        exigir(e, "no apareció la alerta STOCK_BAJO en 15 s")
        E["alerta"] = e[0]
        llamar("POST", "/api/movimientos", E["operador"], {"tipo": "SALIDA", "id_producto": p1, "id_bodega": b1, "cantidad": 1}, clave())
        time.sleep(2)
        exigir(len(buscar()) == 1, f"hay {len(buscar())} alertas sin leer del mismo producto (deben deduplicarse)")

    @prueba("La alerta se marca como leída y cada usuario decide si recibe correo")
    def _():
        exigir(llamar("POST", f"/api/notificaciones/{E['alerta']['id_notificacion']}/leida", E["admin"], {}).estado in (200, 204), "marcar como leída falló")
        sin_leer = [n for n in lista(llamar("GET", "/api/notificaciones?leida=false&por_pagina=100", E["admin"])) if n["id_notificacion"] == E["alerta"]["id_notificacion"]]
        exigir(not sin_leer, "la alerta sigue sin leer")
        exigir(llamar("PUT", "/api/preferencias/mia", E["admin"], {"recibir_correo": False}).estado in (200, 204), "guardar preferencia falló")
        exigir(llamar("GET", "/api/preferencias/mia", E["admin"]).estado == 200, "leer preferencia falló")


    @prueba("La revisión diaria crea las alertas de VENCIMIENTO de los lotes por vencer", solo_con_docker=True)
    def _():
        exigir(llamar("PUT", "/api/configuracion-alertas", E["admin"], {"dias_anticipacion_vencimiento": 60, "hora_revision_diaria": "03:00"}).estado == 200, "no se pudo configurar")
        r = ejecutar_en("ms-notificaciones", "flask", "--app", "app:crear_app", "revision-diaria")
        exigir(r.returncode == 0, f"la revisión diaria falló: {r.stderr[-200:]}")
        venc = [n for n in lista(llamar("GET", "/api/notificaciones?por_pagina=100", E["admin"])) if n.get("tipo") == "VENCIMIENTO" and n.get("id_producto") == E["p1"]]
        exigir(venc, "no hay alerta de vencimiento del producto de la prueba (su lote vence en 40 días)")


def reportes():
    grupo("9. Reportes, panel e indicadores (RF11, RF14, RF15)")

    @prueba("Existencias y valorización reflejan lo registrado")
    def _():
        ex = llamar("GET", "/api/reportes/existencias", E["contador"])
        exigir(ex.estado == 200, f"existencias dio {ex.estado}: {ex.texto[:120]}")
        filas = [f for f in (ex.datos if isinstance(ex.datos, list) else lista(ex)) if f.get("id_producto") in (E["p1"], E["p2"])]
        exigir(filas, "los productos de la prueba no aparecen en existencias")
        v = llamar("GET", "/api/reportes/valorizacion", E["contador"])
        exigir(v.estado == 200 and float(v.datos["valor_total"]) > 0, f"valorización: {v.estado} {v.texto[:120]}")

    @prueba("Rotación y kardex de reportes responden")
    def _():
        r = llamar("GET", f"/api/reportes/rotacion?fecha_desde={en_dias(-30)}&fecha_hasta={en_dias(1)}", E["contador"])
        exigir(r.estado == 200, f"rotación dio {r.estado}: {r.texto[:120]}")
        k = llamar("GET", f"/api/reportes/kardex?id_producto={E['p1']}", E["contador"])
        exigir(k.estado == 200 and len(k.datos if isinstance(k.datos, list) else lista(k)) >= 6, f"kardex dio {k.estado}")

    @prueba("Descargas en CSV y PDF")
    def _():
        c = llamar("GET", "/api/reportes/existencias?formato=csv", E["contador"], cabeceras={"Accept": "*/*"})
        exigir(c.estado == 200 and "csv" in c.cabeceras.get("content-type", ""), f"CSV: {c.estado} {c.cabeceras.get('content-type')}")
        exigir(c.bytes.startswith(b"\xef\xbb\xbf") and b";" in c.bytes[:200], "el CSV no trae BOM ni ';' (Excel en español)")
        p = llamar("GET", "/api/reportes/valorizacion?formato=pdf", E["contador"], cabeceras={"Accept": "*/*"})
        exigir(p.estado == 200 and p.bytes.startswith(b"%PDF"), f"PDF: {p.estado} {p.bytes[:8]}")

    @prueba("El panel de indicadores reúne inventario, catálogo y compras (RF14)")
    def _():
        i = llamar("GET", "/api/indicadores", E["admin"])
        exigir(i.estado == 200, f"indicadores dio {i.estado}: {i.texto[:150]}")
        exigir({"valor_total", "productos_bajo_umbral"} <= set(i.datos), f"faltan indicadores: {list(i.datos)}")


def importaciones():
    grupo("10. Importación masiva (RF16)")
    s = E["sufijo"]
    bom = b"\xef\xbb\xbf"

    @prueba("Productos: se crean los válidos y se informa cada fila con error")
    def _():
        nombre = [c for c in lista(llamar("GET", "/api/categorias", E["admin"])) if c["id_categoria"] == E["categoria"]][0]["nombre"]
        csv = (bom + (f"codigo;nombre;descripcion;categoria;unidad_medida;precio\nIMP1-{s};Galletas de sal {s};Paquete;{nombre};UNIDAD;2500\n"
                      f"IMP2-{s};Sin precio {s};;{nombre};UNIDAD;abc\nIMP3-{s};Sin categoría {s};;NoExiste;UNIDAD;1000\n").encode())
        r = llamar("POST", "/api/importaciones", E["admin"], multipart={"campos": {"tipo": "PRODUCTOS"}, "archivo": (f"productos-{s}.csv", csv)})
        exigir(r.estado == 201, f"importar dio {r.estado}: {r.texto[:150]}")
        exigir(r.datos["estado"] == "CON_ERRORES" and (r.datos["filas_totales"], r.datos["filas_validas"], r.datos["filas_con_error"]) == (3, 1, 2), f"resultado inesperado: {r.texto[:250]}")
        filas = sorted(e["numero_fila"] for e in r.datos["errores"])
        exigir(filas == [3, 4], f"errores en las filas {filas} (esperado [3, 4])")
        E["importado"] = [p for p in lista(llamar("GET", f"/api/productos?codigo=IMP1-{s}", E["admin"]))][0]["id_producto"]

    @prueba("Stock inicial: llega a ms-inventario y repetir el mismo archivo no vuelve a sumar")
    def _():
        csv = bom + f"codigo_producto;codigo_bodega;cantidad;codigo_lote;fecha_vencimiento\nIMP1-{s};B1{s};40;L-IMP-{s};{en_dias(200)}\n".encode()
        r = llamar("POST", "/api/importaciones", E["admin"], multipart={"campos": {"tipo": "STOCK_INICIAL"}, "archivo": (f"stock-{s}.csv", csv)})
        exigir(r.estado == 201 and r.datos["estado"] == "PROCESADA", f"stock inicial dio {r.estado}: {r.texto[:250]}")
        exigir(saldo(E["importado"], E["bodega1"]) == 40, f"el saldo es {saldo(E['importado'], E['bodega1'])} (esperado 40)")
        llamar("POST", "/api/importaciones", E["admin"], multipart={"campos": {"tipo": "STOCK_INICIAL"}, "archivo": (f"stock-{s}.csv", csv)})
        exigir(saldo(E["importado"], E["bodega1"]) == 40, "el mismo archivo subido otra vez volvió a sumar el saldo")

    @prueba("El historial de importaciones y su detalle")
    def _():
        h = llamar("GET", "/api/importaciones", E["admin"])
        exigir(h.estado == 200 and len(lista(h)) >= 2, f"historial: {h.estado}")
        d = llamar("GET", f"/api/importaciones/{lista(h)[-1]['id_importacion']}", E["admin"])
        exigir(d.estado == 200 and "errores" in d.datos, "el detalle no trae sus errores")
        exigir(llamar("POST", "/api/importaciones", E["operador"], multipart={"campos": {"tipo": "PRODUCTOS"}, "archivo": ("x.csv", bom + b"codigo\n")}).estado == 403, "un operador importó")


def conteos():
    grupo("11. Conteo físico (RF18)")
    b1, p1 = E["bodega1"], E["p1"]

    @prueba("Programar, contar por partes y aprobar ajusta el inventario")
    def _():
        antes = saldo(p1, b1)
        c = llamar("POST", "/api/conteos", E["admin"], {"id_bodega": b1, "fecha_programada": hoy_utc()})
        exigir(c.estado == 201 and c.datos["estado"] == "PROGRAMADO", f"programar dio {c.estado}: {c.texto[:150]}")
        linea = [d for d in c.datos["detalles"] if d["id_producto"] == p1]
        exigir(linea and linea[0]["cantidad_sistema"] == antes, f"el conteo trae {linea} y el saldo es {antes}")
        ajeno = llamar("GET", f"/api/conteos/{c.datos['id_conteo']}", E["operador"])
        exigir(ajeno.estado == 200, "el operador de la bodega no ve su conteo")
        r = llamar("PUT", f"/api/conteos/{c.datos['id_conteo']}/detalles", E["operador"], {"detalles": [{"id_producto": p1, "cantidad_contada": antes - 3}]})
        exigir(r.estado == 200 and r.datos["estado"] == "EN_REVISION", f"registrar dio {r.estado}: {r.texto[:150]}")
        exigir(llamar("POST", f"/api/conteos/{c.datos['id_conteo']}/aprobacion", E["operador"], {}, clave()).estado == 403, "un operador aprobó")
        k = clave()
        a = llamar("POST", f"/api/conteos/{c.datos['id_conteo']}/aprobacion", E["admin"], {}, k)
        exigir(a.estado == 200 and a.datos["estado"] == "APROBADO", f"aprobar dio {a.estado}: {a.texto[:150]}")
        exigir(saldo(p1, b1) == antes - 3, f"el saldo quedó en {saldo(p1, b1)} (esperado {antes - 3})")
        llamar("POST", f"/api/conteos/{c.datos['id_conteo']}/aprobacion", E["admin"], {}, k)
        exigir(saldo(p1, b1) == antes - 3, "repetir la aprobación volvió a ajustar")
        tarde = llamar("PUT", f"/api/conteos/{c.datos['id_conteo']}/detalles", E["operador"], {"detalles": [{"id_producto": p1, "cantidad_contada": 1}]})
        exigir(tarde.estado == 409, f"contar un conteo aprobado dio {tarde.estado} (esperado 409)")


def cliente_web():
    grupo("12. Cliente web (RNF21)")
    jar = http.cookiejar.CookieJar()
    abrir = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))

    def pagina(ruta, datos=None):
        peticion = urllib.request.Request(ARGS.web + ruta, data=urllib.parse.urlencode(datos).encode() if datos else None)
        try:
            r = abrir.open(peticion, timeout=20)
            return r.status, r.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            return e.code, e.read().decode("utf-8", "replace")

    # Un administrador propio para el recorrido: cada pantalla hace varias llamadas al Gateway y todas cuentan contra el límite de
    # 100 por minuto del usuario; así el recorrido no se come el cupo del resto de las pruebas.
    @prueba("El administrador entra por el formulario y navega por todas las pantallas sin errores")
    def _():
        _, html = pagina("/login")
        token = re.search(r'name="_token" value="([^"]+)"', html).group(1)
        estado, inicio = pagina("/login", {"_token": token, "correo": f"adminweb.{E['sufijo']}@prueba.test", "contrasena": "ClaveUsuario2026"})
        exigir("Salir" in inicio, f"no entró: {estado}")
        rutas = ["/", "/stock", "/movimientos", "/movimientos/nuevo?tipo=ENTRADA", "/traslados", "/lotes", "/compras/ordenes", "/compras/devoluciones", "/conteos",
                 "/reportes", "/reportes/existencias", "/reportes/valorizacion", "/reportes/rotacion", "/reportes/kardex?producto=%d" % E["p1"], "/notificaciones",
                 "/administrar", "/productos", "/categorias", "/proveedores", "/bodegas", "/umbrales", "/usuarios", "/importaciones", "/administrar/alertas"]
        malas = []
        for ruta in rutas:
            estado, html = pagina(ruta)
            if estado != 200 or "Servicio no disponible" in html or "No pudimos" in html or "Whoops" in html:
                malas.append(f"{ruta} → {estado}")
        exigir(not malas, "pantallas con problemas: " + ", ".join(malas))
        return f"{len(rutas)} pantallas"

    @prueba("El operador solo ve lo suyo (403 en Administrar)")
    def _():
        jar2 = http.cookiejar.CookieJar()
        op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar2))
        html = op.open(ARGS.web + "/login", timeout=20).read().decode()
        token = re.search(r'name="_token" value="([^"]+)"', html).group(1)
        datos = urllib.parse.urlencode({"_token": token, "correo": f"operador.{E['sufijo']}@prueba.test", "contrasena": "ClaveUsuario2026"}).encode()
        op.open(urllib.request.Request(ARGS.web + "/login", data=datos), timeout=20)
        try:
            op.open(ARGS.web + "/usuarios", timeout=20)
            raise Fallo("el operador entró a /usuarios")
        except urllib.error.HTTPError as e:
            exigir(e.code == 403, f"/usuarios dio {e.code} (esperado 403)")


def resiliencia_y_trazabilidad():
    grupo("13. Trazabilidad y resiliencia (RNF10, RNF18)")

    @prueba("Cada petición lleva un identificador que se sigue en los registros de los servicios", solo_con_docker=True)
    def _():
        r = llamar("GET", f"/api/saldos?id_producto={E['p1']}", E["admin"])
        rid = r.cabeceras.get("x-request-id")
        exigir(rid, "el Gateway no devuelve X-Request-Id")
        time.sleep(1)
        encontrados = []
        for servicio in ("api-gateway", "ms-inventario"):
            logs = registros_de(servicio)
            if rid in logs:
                encontrados.append(servicio)
        exigir(set(encontrados) == {"api-gateway", "ms-inventario"}, f"el id {rid} se halló en {encontrados}")
        linea = [l for l in registros_de("ms-inventario").splitlines() if rid in l][0]
        exigir("ms-inventario" in linea and re.search(r'"?(level|nivel)"?', linea), f"el registro no trae servicio y nivel: {linea[:160]}")
        return rid

    @prueba("Con ms-notificaciones caído, registrar un movimiento sigue funcionando", solo_con_docker=True)
    def _():
        parar("ms-notificaciones")
        try:
            r = llamar("POST", "/api/movimientos", E["admin"], {"tipo": "ENTRADA", "id_producto": E["p1"], "id_bodega": E["bodega1"], "cantidad": 1}, clave())
            exigir(r.estado == 201, f"con notificaciones caído, el movimiento dio {r.estado}: {r.texto[:120]}")
        finally:
            arrancar("ms-notificaciones")

    @prueba("Con ms-catalogo caído, registrar un movimiento se rechaza con 503 y al volver todo recupera", solo_con_docker=True)
    def _():
        parar("ms-catalogo")
        try:
            r = llamar("POST", "/api/movimientos", E["admin"], {"tipo": "ENTRADA", "id_producto": E["p1"], "id_bodega": E["bodega1"], "cantidad": 1}, clave())
            exigir(r.estado == 503 and r.datos["error"]["codigo"] == "SERVICIO_NO_DISPONIBLE", f"dio {r.estado} {r.texto[:120]}")
            ok = llamar("GET", "/api/saldos", E["admin"])
            exigir(ok.estado == 200, "las consultas que no dependen del catálogo también fallan")
        finally:
            arrancar("ms-catalogo")
        vuelve = esperar(lambda: llamar("POST", "/api/movimientos", E["admin"], {"tipo": "ENTRADA", "id_producto": E["p1"], "id_bodega": E["bodega1"], "cantidad": 1}, clave()).estado == 201, 90, 3)
        exigir(vuelve, "tras volver ms-catalogo, el movimiento no se recuperó en 90 s")

    @prueba("El Gateway responde 503 (no 500) con un servicio caído en una ruta de ese servicio", solo_con_docker=True)
    def _():
        parar("ms-proveedores")
        try:
            r = llamar("GET", "/api/proveedores", E["admin"])
            exigir(r.estado == 503, f"con proveedores caído, /proveedores dio {r.estado}")
        finally:
            arrancar("ms-proveedores")
        exigir(esperar(lambda: llamar("GET", "/api/proveedores", E["admin"]).estado == 200, 60, 2), "proveedores no volvió")


def caidas():
    grupo("14. Si se cae un microservicio, el resto sigue funcionando (RNF18)")
    # De qué servicios depende cada operación (Tabla 2 de la Entrega 2 y lo observado). Con uno caído, las que dependen de él responden
    # 503 SERVICIO_NO_DISPONIBLE (rápido, nunca 500 ni colgada) y todas las demás siguen funcionando.
    b1, p1, prov = E["bodega1"], E["p1"], E["proveedor"]
    sondas = [  # nombre, método, ruta, cuerpo, dependencias
        ("usuarios (solo Gateway)", "GET", "/api/usuarios", None, set()),
        ("productos", "GET", "/api/productos?por_pagina=5", None, {"ms-catalogo"}),
        ("proveedores", "GET", "/api/proveedores", None, {"ms-proveedores"}),
        ("saldos", "GET", "/api/saldos", None, {"ms-inventario"}),
        ("kardex", "GET", "/api/movimientos?por_pagina=5", None, {"ms-inventario"}),
        ("bodegas", "GET", "/api/bodegas", None, {"ms-inventario"}),
        ("registrar entrada", "POST", "/api/movimientos", {"tipo": "ENTRADA", "id_producto": p1, "id_bodega": b1, "cantidad": 1}, {"ms-inventario", "ms-catalogo"}),
        ("órdenes de compra", "GET", "/api/ordenes-compra", None, {"ms-compras"}),
        ("crear orden", "POST", "/api/ordenes-compra", {"id_proveedor": prov, "id_bodega_destino": b1, "fecha_esperada": en_dias(9),
                                                      "detalles": [{"id_producto": p1, "cantidad_pedida": 1, "precio_unitario": 100}]}, {"ms-compras"}),
        ("alertas", "GET", "/api/notificaciones", None, {"ms-notificaciones"}),
        ("reporte de existencias", "GET", "/api/reportes/existencias", None, {"ms-reportes", "ms-inventario", "ms-catalogo"}),
        ("valorización", "GET", "/api/reportes/valorizacion", None, {"ms-reportes", "ms-inventario", "ms-catalogo"}),
        ("panel de indicadores", "GET", "/api/indicadores", None, {"ms-reportes"}),  # los demás servicios solo le quitan indicadores
    ]
    listo = {"ms-catalogo": "productos", "ms-proveedores": "proveedores", "ms-inventario": "saldos", "ms-compras": "órdenes de compra",
             "ms-notificaciones": "alertas", "ms-reportes": "reporte de existencias"}
    token = E["adminmatriz"]  # un administrador propio: cada usuario tiene su cupo de 100 peticiones por minuto y las pantallas web usan otro

    # Una sesión del cliente web para ver que las pantallas siguen en pie.
    jar = http.cookiejar.CookieJar()
    abrir = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    html = abrir.open(ARGS.web + "/login", timeout=20).read().decode()
    csrf = re.search(r'name="_token" value="([^"]+)"', html).group(1)
    abrir.open(urllib.request.Request(ARGS.web + "/login", data=urllib.parse.urlencode(
        {"_token": csrf, "correo": f"adminweb.{E['sufijo']}@prueba.test", "contrasena": "ClaveUsuario2026"}).encode()), timeout=20)

    def pagina(ruta):
        try:
            r = abrir.open(ARGS.web + ruta, timeout=25)
            return r.status, r.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            return e.code, e.read().decode("utf-8", "replace")

    def sonda(nombre):
        _, metodo, ruta, cuerpo, deps = [x for x in sondas if x[0] == nombre][0]
        ini = time.time()
        r = llamar(metodo, ruta, token, cuerpo, clave() if metodo == "POST" else None, reintentar=False)
        return r, time.time() - ini

    for servicio in ("ms-notificaciones", "ms-reportes", "ms-proveedores", "ms-catalogo", "ms-compras", "ms-inventario"):
        def comprobar(servicio=servicio):
            parar(servicio)
            try:
                time.sleep(2)
                fallas = []
                for nombre, metodo, ruta, cuerpo, deps in sondas:
                    r, seg = sonda(nombre)
                    esperado_503 = servicio in deps
                    if esperado_503 and not (r.estado == 503 and r.datos and r.datos["error"]["codigo"] == "SERVICIO_NO_DISPONIBLE"):
                        fallas.append(f"«{nombre}» debía dar 503 y dio {r.estado}")
                    elif not esperado_503 and r.estado not in (200, 201):
                        fallas.append(f"«{nombre}» debía seguir funcionando y dio {r.estado} {r.texto[:80]}")
                    if seg > 6:
                        fallas.append(f"«{nombre}» tardó {seg:.1f} s")
                exigir(not fallas, "; ".join(fallas))
                # El panel de indicadores no cae entero: solo pierde lo que necesita al servicio caído.
                if servicio in ("ms-catalogo", "ms-inventario", "ms-compras"):
                    r, _ = sonda("panel de indicadores")
                    perdidos = r.datos.get("no_disponibles", [])
                    exigir(r.estado == 200 and perdidos and len(perdidos) < 6, f"indicadores con {servicio} caído: {r.estado} no_disponibles={perdidos}")
                # Las pantallas del cliente web responden y conservan su menú y sus acciones (nunca un error 500).
                for ruta, marca in (("/", "Buen"), ("/stock", "Stock"), ("/movimientos", "Movimientos"), ("/compras/ordenes", "Compras")):
                    estado, cuerpo_html = pagina(ruta)
                    exigir(estado == 200 and marca in cuerpo_html, f"la pantalla {ruta} dio {estado} con {servicio} caído")
            finally:
                arrancar(servicio)
            exigir(esperar(lambda: sonda(listo[servicio])[0].estado == 200, 90, 3), f"{servicio} no se recuperó en 90 s")
            return "lo demás siguió funcionando y volvió a la normalidad"

        prueba(f"Con {servicio} caído, lo que no depende de él sigue funcionando y lo que sí responde 503", solo_con_docker=True)(comprobar)

    @prueba("Con ms-reportes caído, el inicio sigue mostrando alertas de stock y accesos (solo faltan los indicadores)", solo_con_docker=True)
    def _():
        parar("ms-reportes")
        try:
            estado, cuerpo_html = pagina("/")
            exigir(estado == 200 and "Entra mercancía" in cuerpo_html, f"el inicio dio {estado} o perdió sus accesos")
            exigir("No pudimos calcular los indicadores" in cuerpo_html, "el inicio no avisa que faltan los indicadores")
        finally:
            arrancar("ms-reportes")
        exigir(esperar(lambda: sonda("reporte de existencias")[0].estado == 200, 90, 3), "ms-reportes no se recuperó")


def limites():
    grupo("15. Límite de peticiones (RNF19)")

    @prueba("Más de 100 peticiones por minuto por usuario: 429 con Retry-After")
    def _():
        estados = [llamar("GET", "/api/productos?por_pagina=1", E["vendedor"], reintentar=False).estado for _ in range(105)]
        exigir(429 in estados, f"ninguna de 105 peticiones dio 429 ({set(estados)})")
        r = llamar("GET", "/api/productos?por_pagina=1", E["vendedor"], reintentar=False)
        exigir(r.estado == 429 and int(r.cabeceras.get("retry-after", 0)) > 0 and r.datos["error"]["codigo"] == "DEMASIADAS_PETICIONES", f"{r.estado} {r.cabeceras.get('retry-after')}")
        exigir(llamar("GET", "/api/productos?por_pagina=1", E["admin"]).estado == 200, "el límite de un usuario afectó a otro")

    @prueba("Más de 10 inicios de sesión por minuto desde la misma IP: 429 con Retry-After")
    def _():
        estados = [llamar("POST", "/api/auth/login", cuerpo={"correo": "nadie@prueba.test", "contrasena": "x"}, reintentar=False).estado for _ in range(12)]
        exigir(429 in estados, f"ninguno de 12 inicios dio 429 ({set(estados)})")


# ---------------------------------------------------------------- principal
def main():
    global ARGS
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("--gateway", default="http://127.0.0.1:8000", help="URL del Gateway")
    p.add_argument("--web", default="http://127.0.0.1:8080", help="URL del cliente web")
    p.add_argument("--admin-correo", default="admin@example.com")
    p.add_argument("--admin-clave", default="", help="contraseña inicial del administrador sembrado")
    p.add_argument("--admin-clave-nueva", default="ClaveNueva2026A", help="contraseña a la que se cambia (o que ya tiene)")
    p.add_argument("--compose", default="docker compose", help='comando de compose con su proyecto, p. ej. "docker compose -p gi-prueba --env-file x.env"')
    p.add_argument("--k8s", metavar="NAMESPACE", default="", help="el sistema está en Kubernetes (con kubectl apuntando al clúster) en ese espacio de nombres, en vez de en Docker Compose")
    p.add_argument("--sin-docker", action="store_true", help="omite las pruebas que necesitan Docker (red interna, registros, caídas)")
    p.add_argument("--sin-limites", action="store_true", help="omite las pruebas de límite de peticiones (gastan el cupo del minuto)")
    ARGS = p.parse_args()
    E["sufijo"] = str(int(time.time()))[-6:]
    inicio = time.time()
    print(f"Pruebas de funcionamiento · Gateway {ARGS.gateway} · cliente web {ARGS.web} · sufijo {E['sufijo']}")

    for etapa in (salud_y_documentacion, autenticacion, aislamiento, usuarios_y_roles, catalogo_y_proveedores, inventario, compras, alertas,
                  reportes, importaciones, conteos, cliente_web, resiliencia_y_trazabilidad, caidas) + (() if ARGS.sin_limites else (limites,)):
        try:
            etapa()
        except KeyError as e:  # una etapa anterior falló y no dejó lo que esta necesita
            RESULTADOS.append((GRUPO[0], f"(etapa interrumpida: falta {e})", "FALLA", "depende de una prueba anterior que falló"))
            print(f"  ✘ etapa interrumpida: falta {e}")

    total = len(RESULTADOS)
    por_estado = {k: sum(1 for r in RESULTADOS if r[2] == k) for k in ("OK", "FALLA", "OMITIDA")}
    print(f"\n{'=' * 70}\n{por_estado['OK']} de {total} pruebas OK · {por_estado['FALLA']} fallan · {por_estado['OMITIDA']} omitidas · {time.time() - inicio:.0f} s")
    for g, n, e, d in RESULTADOS:
        if e == "FALLA":
            print(f"  ✘ [{g}] {n}: {d}")
    sys.exit(1 if por_estado["FALLA"] else 0)


if __name__ == "__main__":
    main()
