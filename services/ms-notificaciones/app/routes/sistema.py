"""/health (RNF10) y /docs (RNF08). No pasan por el Gateway."""
import json
from pathlib import Path

from flask import Blueprint, Response

from .. import db
from ..clients import inventario

rutas = Blueprint("sistema", __name__)

_ESPECIFICACION = json.loads(
    (Path(__file__).resolve().parent.parent.parent / "openapi.json").read_text(encoding="utf-8")
)

# Swagger UI desde un CDN con la versión fija: no hace falta instalar nada en el servicio.
_SWAGGER_UI = """<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <title>ms-notificaciones — API</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.17.14/swagger-ui.css">
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.17.14/swagger-ui-bundle.js"></script>
  <script>
    SwaggerUIBundle({ url: "/docs/openapi.json", dom_id: "#swagger-ui", validatorUrl: null });
  </script>
</body>
</html>"""


@rutas.get("/health")
def salud():
    dependencias = {"ms-inventario": inventario.cliente.cortacircuito.estado}
    try:
        with db.conexion() as con:
            con.execute("SELECT 1")
        return {"estado": "ok", "servicio": "ms-notificaciones", "base_de_datos": "ok", "cortacircuitos": dependencias}
    except Exception:
        cuerpo = {
            "estado": "error",
            "servicio": "ms-notificaciones",
            "base_de_datos": "sin conexión",
            "cortacircuitos": dependencias,
        }
        return cuerpo, 503


@rutas.get("/docs/openapi.json")
def especificacion():
    return _ESPECIFICACION


@rutas.get("/docs")
@rutas.get("/docs/")
def documentacion():
    return Response(_SWAGGER_UI, mimetype="text/html")
