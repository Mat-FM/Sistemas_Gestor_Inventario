"""ErrorImportacion: un error de una fila de la carga masiva, uno por fila y campo rechazado (Figura 8)."""

from app.extensions import db


class ErrorImportacion(db.Model):
    __tablename__ = "errores_importacion"

    id_error = db.Column(db.BigInteger().with_variant(db.Integer, "sqlite"), primary_key=True)
    id_importacion = db.Column(db.BigInteger, db.ForeignKey("importaciones.id_importacion"), nullable=False, index=True)
    # Número de la fila en el archivo.
    numero_fila = db.Column(db.Integer, nullable=False)
    # Columna del archivo. Vacío cuando el error es de la fila completa (por ejemplo, la rechazó el servicio destino).
    campo = db.Column(db.String(100), nullable=True)
    mensaje = db.Column(db.String(500), nullable=False)

    importacion = db.relationship("Importacion", back_populates="errores")
