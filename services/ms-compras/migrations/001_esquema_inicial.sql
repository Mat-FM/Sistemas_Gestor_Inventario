-- ms-compras: esquema inicial (Entrega 2, sección 3.7 y Figura 6).
-- Las columnas id_proveedor, id_producto, id_bodega*, id_lote, id_movimiento e id_usuario
-- son referencias a datos de otros servicios: se guardan solo los identificadores, sin
-- claves foráneas (RNF02).

CREATE SEQUENCE numero_orden_seq START 1;

CREATE TABLE orden_compra (
    id_orden           SERIAL PRIMARY KEY,
    numero             VARCHAR(20)    NOT NULL UNIQUE,
    estado             VARCHAR(20)    NOT NULL DEFAULT 'CREADA'
                       CHECK (estado IN ('CREADA', 'ENVIADA', 'RECIBIDA_PARCIAL', 'RECIBIDA', 'ANULADA')),
    id_proveedor       INTEGER        NOT NULL,  -- ref. a ms-proveedores
    id_bodega_destino  INTEGER        NOT NULL,  -- ref. a ms-inventario
    id_usuario         INTEGER        NOT NULL,  -- ref. al API Gateway
    fecha_creacion     TIMESTAMPTZ    NOT NULL DEFAULT now(),
    fecha_esperada     DATE           NOT NULL,
    total              NUMERIC(14, 2) NOT NULL DEFAULT 0
);

CREATE INDEX idx_orden_compra_estado    ON orden_compra (estado);
CREATE INDEX idx_orden_compra_proveedor ON orden_compra (id_proveedor);
CREATE INDEX idx_orden_compra_bodega    ON orden_compra (id_bodega_destino);
CREATE INDEX idx_orden_compra_fecha     ON orden_compra (fecha_creacion);

CREATE TABLE detalle_orden (
    id_detalle         SERIAL PRIMARY KEY,
    id_orden           INTEGER        NOT NULL REFERENCES orden_compra (id_orden) ON DELETE CASCADE,
    id_producto        INTEGER        NOT NULL,  -- ref. a ms-catalogo
    cantidad_pedida    INTEGER        NOT NULL CHECK (cantidad_pedida > 0),
    cantidad_recibida  INTEGER        NOT NULL DEFAULT 0 CHECK (cantidad_recibida >= 0),
    precio_unitario    NUMERIC(14, 2) NOT NULL CHECK (precio_unitario >= 0),
    CONSTRAINT uq_detalle_producto UNIQUE (id_orden, id_producto),
    CONSTRAINT ck_recibida_no_supera CHECK (cantidad_recibida <= cantidad_pedida)
);

CREATE TABLE recepcion (
    id_recepcion       SERIAL PRIMARY KEY,
    id_detalle         INTEGER        NOT NULL REFERENCES detalle_orden (id_detalle),
    cantidad           INTEGER        NOT NULL CHECK (cantidad > 0),
    codigo_lote        VARCHAR(50),
    fecha_vencimiento  DATE,
    fecha              TIMESTAMPTZ    NOT NULL DEFAULT now(),
    id_usuario         INTEGER        NOT NULL,  -- ref. al API Gateway
    id_movimiento      INTEGER        NOT NULL,  -- ref. a ms-inventario
    clave_idempotencia VARCHAR(100)   NOT NULL,
    -- Una misma petición (misma clave) registra cada línea una sola vez (RNF17).
    CONSTRAINT uq_recepcion_clave_linea UNIQUE (clave_idempotencia, id_detalle)
);

CREATE INDEX idx_recepcion_detalle ON recepcion (id_detalle);

CREATE TABLE devolucion_proveedor (
    id_devolucion      SERIAL PRIMARY KEY,
    id_orden           INTEGER        REFERENCES orden_compra (id_orden),  -- opcional (RF13)
    id_proveedor       INTEGER        NOT NULL,  -- ref. a ms-proveedores
    id_producto        INTEGER        NOT NULL,  -- ref. a ms-catalogo
    id_bodega          INTEGER        NOT NULL,  -- ref. a ms-inventario
    id_lote            INTEGER,                  -- ref. a ms-inventario
    cantidad           INTEGER        NOT NULL CHECK (cantidad > 0),
    motivo             VARCHAR(255)   NOT NULL,
    fecha              TIMESTAMPTZ    NOT NULL DEFAULT now(),
    id_usuario         INTEGER        NOT NULL,  -- ref. al API Gateway
    id_movimiento      INTEGER        NOT NULL,  -- ref. a ms-inventario
    clave_idempotencia VARCHAR(100)   NOT NULL UNIQUE
);

CREATE INDEX idx_devolucion_proveedor ON devolucion_proveedor (id_proveedor);
CREATE INDEX idx_devolucion_fecha     ON devolucion_proveedor (fecha);

-- Respuestas ya enviadas por clave de idempotencia: si la misma petición llega otra vez,
-- se devuelve la respuesta original sin repetir la operación (RNF17).
CREATE TABLE clave_idempotencia (
    clave              VARCHAR(100)   NOT NULL,
    operacion          VARCHAR(100)   NOT NULL,
    codigo_http        INTEGER        NOT NULL,
    respuesta          JSONB          NOT NULL,
    fecha              TIMESTAMPTZ    NOT NULL DEFAULT now(),
    PRIMARY KEY (clave, operacion)
);
