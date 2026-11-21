# Pruebas de funcionamiento de todo el sistema

Verifican que los seis microservicios, el API Gateway y el cliente web funcionan **juntos**, en contenedores, con los flujos
reales de la distribuidora. Son distintas de las pruebas unitarias de cada servicio (que simulan a los demás) y de las de
rendimiento (`../performance-tests/`).

## Cómo correrlas

```bash
./smoke-tests/ejecutar.sh                 # construye, levanta, prueba y borra todo
./smoke-tests/ejecutar.sh --conservar     # deja la pila arriba para probar a mano
./smoke-tests/ejecutar.sh --sin-limites   # omite las pruebas de límite de peticiones
```

Necesita Docker, Python 3 y `curl`. El script:

- Usa un proyecto de compose aparte (`gi-prueba`), con puertos desde el 18100, solo en `127.0.0.1`, secretos al azar en una
  carpeta temporal y bases nuevas. **No usa tu `.env` ni toca otros contenedores.** Si algún puerto está ocupado, se detiene.
- Construye las imágenes **de una en una**: en paralelo cuelga Docker Desktop.
- Tarda unos 5 minutos (la mayor parte, las imágenes la primera vez).

`verificar_sistema.py` también se puede lanzar contra cualquier despliegue (por ejemplo Kubernetes con `kubectl port-forward`):

```bash
python3 smoke-tests/verificar_sistema.py --gateway http://127.0.0.1:8000 --web http://127.0.0.1:8080 \
  --admin-correo $ADMIN_EMAIL --admin-clave $ADMIN_PASSWORD --sin-docker
```

`--sin-docker` omite lo que necesita acceso a los contenedores (salud interna de los microservicios, registros y apagar servicios
para probar la resiliencia). Solo usa la biblioteca estándar de Python. **Escribe datos de prueba** (con un sufijo único por
corrida): no la corras sobre los datos de la demo.

## Qué comprueba

| Grupo | Requerimientos | Qué hace |
|---|---|---|
| 1. Salud y documentación | RNF08, RNF10 | `/health` y `/docs` de los seis microservicios (desde dentro de la red) y del Gateway; el cliente web responde |
| 2. Punto de entrada único | RNF09 | Nada se publica fuera de `127.0.0.1`; catálogo, proveedores y reportes no publican ningún puerto; `/internas` no se ve desde fuera |
| 3. Autenticación | RF08, RNF07 | La contraseña inicial obliga a cambiarla; JWT que vence a los 60 min; 401 sin token, con token falso o con clave errónea; forma común de los errores |
| 4. Usuarios y roles | RF07 | Crea operador, vendedor, contador y administrador; contraseña temporal obligatoria; 409 por correo repetido; 403 fuera de la matriz de permisos; inactivar cierra la sesión al instante |
| 5. Catálogo y proveedores | RF01, RF02, RF03, RF12 | Categorías de dos niveles, productos, búsqueda, baja sin borrar, proveedor con sus productos, duplicados |
| 6. Inventario | RF04, RF05, RF10, RF17, RNF17 | Entradas con lote, **idempotencia**, salida FEFO, `STOCK_INSUFICIENTE`, límite por bodega del operador, traslado en dos pasos, devolución, ajuste y kardex con autor |
| 7. Compras | RF06, RF13 | Orden → envío → recepción parcial y total con lote; no recibir de más; devolución a proveedor; orden anulada |
| 8. Alertas | RF09, RF17 | `STOCK_BAJO` sin duplicados, marcar como leída, preferencia de correo, revisión diaria de vencimientos |
| 9. Reportes | RF11, RF14, RF15 | Existencias, valorización, rotación, kardex, descargas CSV (con BOM y `;`) y PDF, panel de indicadores |
| 10. Importación | RF16 | Productos con filas erróneas (se informa cada una), stock inicial y que repetir el archivo no vuelve a sumar |
| 11. Conteo físico | RF18 | Programar, contar por partes, aprobar con ajuste del saldo, aprobación idempotente, 403 al operador |
| 12. Cliente web | RNF21 | Entra por el formulario y recorre 24 pantallas del administrador; el operador recibe 403 en administración |
| 13. Trazabilidad y resiliencia | RNF10, RNF18 | Un identificador de petición se sigue entre Gateway y servicios; con notificaciones caído se sigue registrando; con catálogo o proveedores caído el Gateway responde 503 (no 500) y todo se recupera al volver |
| 14. Caída de cada microservicio | RNF18 | Apaga **uno por uno** los seis microservicios y comprueba, con 13 operaciones y 4 pantallas web, que lo que no depende de él sigue funcionando, que lo que sí responde 503 rápido (nunca 500 ni una espera larga), que el panel de indicadores solo pierde lo que necesita al servicio caído y que todo vuelve a la normalidad |
| 15. Límites | RNF19 | 429 con `Retry-After` tras 100 peticiones por minuto por usuario y tras 10 inicios de sesión por minuto desde una IP |

Si un 429 interrumpe una petición, el guion espera el `Retry-After` y la repite: el límite de 100 por minuto es de cada usuario y
las pantallas del cliente web hacen varias llamadas cada una (por eso el recorrido del cliente web usa su propio administrador).

## Qué NO cubre

- **Kubernetes** (RNF04, RNF05): hace falta un clúster. Los manifiestos solo se revisan de forma estática (`k8s/verificar.py`).
- **Autoescalado y varias copias** (RNF05).
- **Correo real** (RF09): no hay servidor SMTP en la prueba; la alerta se crea y el envío se prueba con un doble en las pruebas unitarias.
- **Carga y rendimiento** (RNF06, RNF11): están en `../performance-tests/`.
- **El cortacircuitos** (5 fallos seguidos, 30 s sin llamar) y los reintentos con espera creciente.
