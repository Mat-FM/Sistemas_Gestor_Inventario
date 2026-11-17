// Variables de entorno de las pruebas. Se cargan antes que cualquier módulo del servicio.
// Usan una base de datos aparte (compras_test) que las pruebas vacían al empezar.
process.env.NODE_ENV = 'test';
process.env.DB_HOST = process.env.DB_HOST || '127.0.0.1';
process.env.DB_PORT = process.env.DB_PORT || '5434';
process.env.DB_NAME = process.env.DB_TEST_NAME || 'compras_test';
process.env.DB_USER = process.env.DB_USER || 'compras';
process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'change_me';
// El simulador de inventario y notificaciones se levanta en este puerto dentro de las pruebas.
process.env.MS_INVENTARIO_URL = 'http://127.0.0.1:3099';
process.env.MS_NOTIFICACIONES_URL = 'http://127.0.0.1:3099';
process.env.CALL_TIMEOUT_MS = '1000';
