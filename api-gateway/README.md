# api-gateway

Único punto de entrada del sistema. Lo programa el equipo en Laravel, sin Kong ni otros gateways de terceros (RNF09).

- **Framework:** Laravel (PHP) · **Base de datos:** MySQL (`Usuario`, `Rol`) · **Puerto en el clúster:** 8000
- **Requerimientos:** RF07, RF08, RNF07, RNF09, RNF19
- **Escalado:** pasa automáticamente de 1 a 4 copias cuando la CPU supera el 70 % (RNF05)

## Responsabilidades

- Enrutamiento hacia cada microservicio según la ruta.
- Inicio y cierre de sesión, cambio y restablecimiento de contraseña (la restablece el administrador con una temporal). JWT firmado, válido 60 minutos; contraseñas con bcrypt.
- Verificación del token y permisos por rol en cada petición (401 sin token válido, 403 sin permiso).
- Límite de peticiones: 100/min por usuario y 10 intentos de inicio de sesión/min por IP (429 con `Retry-After`).
- Identificador de petición (`X-Request-Id`) y registros JSON por petición.

Al reenviar, agrega las cabeceras `X-User-Id`, `X-User-Rol`, `X-User-Bodega` y `X-Request-Id`.
Roles: `ADMINISTRADOR`, `OPERADOR_BODEGA`, `VENDEDOR`, `CONTADOR`.

## Pendiente

La aplicación Laravel aún no está generada. Organizar el código en capas separadas de enrutamiento, seguridad y gestión de usuarios (RNF13).
