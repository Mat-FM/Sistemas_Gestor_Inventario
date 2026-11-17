-- ms-notificaciones: esquema inicial (Entrega 2, sección 3.8 y Figura 7).
-- Las tres entidades no se relacionan entre sí. id_producto, id_bodega e id_usuario son
-- referencias a datos de otros servicios: se guardan solo los identificadores, sin claves
-- foráneas (RNF02).

CREATE TABLE notificacion (
    id_notificacion    SERIAL PRIMARY KEY,
    tipo               VARCHAR(20)   NOT NULL
                       CHECK (tipo IN ('STOCK_BAJO', 'VENCIMIENTO', 'ORDEN_RECIBIDA')),
    mensaje            VARCHAR(500)  NOT NULL,
    id_producto        INTEGER,                 -- ref. a ms-catalogo
    id_bodega          INTEGER,                 -- ref. a ms-inventario
    rol_destinatario   VARCHAR(20)   NOT NULL DEFAULT 'ADMINISTRADOR'
                       CHECK (rol_destinatario IN ('ADMINISTRADOR', 'OPERADOR_BODEGA', 'VENDEDOR', 'CONTADOR')),
    leida              BOOLEAN       NOT NULL DEFAULT FALSE,
    correo_enviado     BOOLEAN       NOT NULL DEFAULT FALSE,
    fecha              TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE INDEX idx_notificacion_rol_fecha ON notificacion (rol_destinatario, fecha DESC);

-- Si ya existe una alerta sin leer del mismo tipo y producto para el rol, no se crea otra
-- (Entrega 2, sección 4.9). Las que no traen producto (ORDEN_RECIBIDA) no se agrupan.
CREATE UNIQUE INDEX uq_notificacion_sin_leer
    ON notificacion (tipo, id_producto, rol_destinatario)
    WHERE NOT leida AND id_producto IS NOT NULL;

CREATE TABLE preferencia (
    id_preferencia     SERIAL PRIMARY KEY,
    id_usuario         INTEGER       NOT NULL UNIQUE,  -- ref. al API Gateway
    -- Rol que llegó en X-User-Rol: sirve para saber a quién enviar cada correo.
    rol                VARCHAR(20)   NOT NULL
                       CHECK (rol IN ('ADMINISTRADOR', 'OPERADOR_BODEGA', 'VENDEDOR', 'CONTADOR')),
    correo             VARCHAR(150),
    recibir_correo     BOOLEAN       NOT NULL DEFAULT FALSE,
    CONSTRAINT ck_correo_si_recibe CHECK (NOT recibir_correo OR correo IS NOT NULL)
);

CREATE INDEX idx_preferencia_rol ON preferencia (rol) WHERE recibir_correo;

-- Un solo registro: la columna id_configuracion solo admite el valor 1.
CREATE TABLE configuracion (
    id_configuracion              INTEGER   PRIMARY KEY DEFAULT 1 CHECK (id_configuracion = 1),
    dias_anticipacion_vencimiento INTEGER   NOT NULL CHECK (dias_anticipacion_vencimiento BETWEEN 1 AND 365),
    hora_revision_diaria          TIME      NOT NULL
);

INSERT INTO configuracion (id_configuracion, dias_anticipacion_vencimiento, hora_revision_diaria)
VALUES (1, 30, '06:00');
