"""Importacion: una carga masiva de RF16 (Figura 8 de la Entrega 2)."""

from sqlalchemy import func

from app.extensions import db

TIPOS = ("PRODUCTOS", "PROVEEDORES", "STOCK_INICIAL")
ESTADOS = ("PROCESADA", "CON_ERRORES", "FALLIDA")


class Importacion(db.Model):
    __tablename__ = "importaciones"

    id_importacion = db.Column(db.BigInteger().with_variant(db.Integer, "sqlite"), primary_key=True)
    # Enum guardado como texto con una restricción CHECK: solo admite los valores de la lista.
    tipo = db.Column(db.Enum(*TIPOS, name="tipo_importacion", native_enum=False, create_constraint=True, length=20),
                     nullable=False)
    nombre_archivo = db.Column(db.String(255), nullable=False)
    estado = db.Column(db.Enum(*ESTADOS, name="estado_importacion", native_enum=False, create_constraint=True,
                               length=20), nullable=False)
    filas_totales = db.Column(db.Integer, nullable=False, default=0)
    filas_validas = db.Column(db.Integer, nullable=False, default=0)
    filas_con_error = db.Column(db.Integer, nullable=False, default=0)
    # Usuario del API Gateway que subió el archivo (cabecera X-User-Id). Solo el identificador, sin clave foránea (RNF02).
    id_usuario = db.Column(db.BigInteger, nullable=False)
    fecha = db.Column(db.DateTime(timezone=True), nullable=False, server_default=func.now())

    # Relación «registra» (1:N), ordenada por fila.
    errores = db.relationship("ErrorImportacion", back_populates="importacion",
                              order_by="[ErrorImportacion.numero_fila, ErrorImportacion.id_error]")
