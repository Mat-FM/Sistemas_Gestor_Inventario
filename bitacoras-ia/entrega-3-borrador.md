# Bitácora de uso de IA — Entrega 3 (borrador para revisar)

> **Qué es este archivo.** Un borrador de la bitácora (RNF16) con el formato de la sección 5 de la Entrega 2: encabezado, registro de
> interacciones y reflexión final. Se redactó a partir del historial del repositorio (commits y pull requests) y de las sesiones de
> trabajo de Brayan con Claude Code. **Cada fila es un hecho verificable en el repositorio; el nivel de intervención y la reflexión son un
> juicio de quien usó la herramienta**, así que están propuestos y Brayan debe confirmarlos o cambiarlos con sus palabras antes de entregar.
> Las filas de Luis y de Mateo no se pueden escribir desde aquí: cada uno debe registrar las suyas (hay una plantilla al final).

## 1. Datos de la bitácora

| Campo | Valor |
|---|---|
| Proyecto | Sistema de Gestión de Inventarios – Distribuidora El Montañero S.A.S. |
| Equipo / Integrantes | Luis Alejandro Saraza Marín, Brayan David Collazos Escobedo, Mateo Falla Muñoz |
| Entrega N.° | 3 |
| Periodo cubierto | 27/10/2026 – 19/11/2026 *(confirmar la fecha de corte con el equipo)* |

## 2. Registro de interacciones — Brayan David Collazos Escobedo

Herramienta en todas las filas: **Claude (Claude Code)**. Los resultados citan lo que se pudo comprobar (pruebas, pull requests, ejecución real).

| Fecha | Tarea / actividad apoyada | Prompt utilizado (resumen) | Nivel de intervención humana (propuesto) | Resultado / aprendizaje |
|---|---|---|---|---|
| 03/11 – 04/11 | **API Gateway** en Laravel: autenticación con JWT, permisos por rol, límite de peticiones, proxy a los servicios (PR #1 a #3). | Implementar el Gateway según los contratos de la Entrega 2, con pruebas, y registrar cada decisión que el contrato no resuelve. | Medio | Se tomaron 33 decisiones documentadas donde el contrato era ambiguo. Quedó con 962 pruebas y cobertura del 98,5 % en la CI. Aprendizaje: el contrato es la fuente de verdad; cada tabla se tradujo a reglas con su prueba, y la revisión humana decidió los casos que el documento no cubría. |
| 04/11 – 16/11 | **ms-inventario** en Express y PostgreSQL: movimientos, lotes con FEFO, traslados, conteos, idempotencia (PR #8 y #9). | Plan de 16 tareas con revisión por tarea y revisión final de toda la rama; documentar cada decisión (libro D1–D34) y verificar con Docker real. | Medio | 3 095 pruebas, cobertura de ≈ 99 %, OpenAPI en `/docs` con pruebas que comparan el documento con las respuestas reales. La CI pasó a la primera. Aprendizaje: dividir el trabajo en tareas pequeñas con revisión evitó que errores se acumularan. |
| 16/11 | **Integración de los servicios de Mateo** (ms-catalogo, ms-proveedores y ms-reportes, PR #4 a #7) con el resto del sistema. | Comprobar que los microservicios de los demás integrantes funcionan con los servicios reales y no solo con sus pruebas. | Alto | Al probarlos con los servicios reales se halló que `ms-reportes` llamaba a `ms-inventario` sin las cabeceras de identidad y toda importación de stock fallaba. Se validó un parche de 8 líneas de extremo a extremo (PR #11) y Mateo lo integró (PR #13). Aprendizaje: las pruebas unitarias de cada servicio no detectan fallos de integración; hay que probar con los demás servicios. |
| 16/11 | **Verificación del PR de Luis** (ms-compras y ms-notificaciones; PR #12). | Verificar ese pull request contra los servicios reales y contra los contratos. | Alto | 38 comprobaciones de extremo a extremo y observaciones sin resolver (alertas de vencimiento por producto y no por lote, aviso de orden recibida por cada recepción parcial, entre otras) que se dejaron anotadas para el equipo. Aprendizaje: la IA ayuda a revisar, pero lo que se acepta lo decide una persona con evidencia. |
| 16/11 | **Cliente web** (Laravel, Blade, Bootstrap): inicio por rol, stock, movimientos, traslados, compras, reportes y alertas. | Diseñar una interfaz amigable solo con lo ya integrado; se mostraron maquetas, se eligió una opción y se fue ampliando a medida que se integraban los servicios. | Medio | 151 pruebas (hoy 189), cobertura del 89 % y recorrido en navegador a 360 y 1280 px contra la pila real. Se corrigieron fallos hallados al usarla: la hora salía en UTC, una contraseña temporal quedaba guardada en la sesión y una regla de `.gitignore` dejaba fuera Bootstrap. Aprendizaje: lo que parece correcto en pantalla se rompe al probarlo contra servicios reales. |
| 16/11 | **Dockerfile del cliente web, docker-compose completo y manifiestos de Kubernetes** (PR #14 y #15). | Contenerizar todo y desplegarlo con Kubernetes a partir de archivos del repositorio. | Medio | Quedaron los 7 servicios, 7 bases y el cliente web, y 57 objetos de Kubernetes, pero solo con revisión estática. Construir las imágenes en paralelo colgó Docker Desktop dos veces; se decidió construirlas de una en una. Aprendizaje: lo que no se ha ejecutado no está probado (ver las filas del 19/11). |
| 16/11 – 19/11 | **Conteos físicos (RF18) e importación masiva (RF16)** en el cliente web. | Continuar con lo que falta en las pantallas. | Medio | Verificadas en navegador: el conteo ajustó el saldo real y un operador de otra bodega recibe un 403 claro. Al subir un archivo de 2,9 MB se descubrió que PHP y el Gateway limitan a 2 MB; se agregó una página clara. Aprendizaje: probar los límites con archivos de verdad, no solo con datos de ejemplo. |
| 16/11 – 19/11 | **15 pruebas de rendimiento de ms-inventario con Locust** (RNF06, RNF11). | Definir y ejecutar 15 pruebas de carga normal, pico y estrés con el mismo esquema que las de Luis. | Medio | Las 15 sin errores y p95 de 5 a 7 ms en las ocho de consulta, medido en un equipo de desarrollo y sin el Gateway (documentado). La prueba de carga dejó 75 000 movimientos que revelaron que el kardex de `ms-reportes` sin filtros pasa de los 3 s del Gateway. Locust se eligió igualando a Luis, sin consultarlo antes (el README raíz dice k6). |
| 16/11 – 19/11 | **Análisis de código en la CI** (RNF13): ESLint, ruff y Pint; CI nueva para ms-proveedores y ms-reportes (PR #16). | Revisar la calidad y completar lo que falta; la IA propuso ESLint y ruff y **Brayan los aprobó** por ser herramientas nuevas. | Alto | Se corrigieron 6 hallazgos (3 en ms-inventario, 2 en ms-compras y 1 en ms-notificaciones), cada grupo en su commit, y se midió la cobertura de los servicios nuevos (95 % y 98 %) antes de poner el umbral. Aprendizaje: una herramienta nueva se consulta antes de añadirla y el cambio se explica en el pull request para quien lo revisa. |
| 19/11 | **Pruebas de funcionamiento de punta a punta** (`smoke-tests/`): 53 pruebas sobre todo el sistema en contenedores. | Analizar qué falta para completar el proyecto y probar que todos los microservicios funcionan. | Medio | Pasan 53 de 53. La prueba real encontró un defecto que ninguna prueba unitaria veía: la base de `ms-reportes` no tenía `healthcheck` y el compose completo no arrancaba. Aprendizaje: las primeras corridas fallaron por supuestos erróneos del propio guion (códigos de error, filtros), no del sistema; hay que distinguir un fallo del sistema de un fallo de la prueba. |
| 19/11 | **Kubernetes en un clúster local (kind)**: despliegue, Ingress, NetworkPolicy, autoescalado y persistencia. | Aprobar la instalación de kind y probar el despliegue real. | Medio | Al desplegar de verdad aparecieron dos defectos de los manifiestos: el contenedor de espera de las migraciones corría como root y Kubernetes lo rechazaba, y compras y notificaciones se reiniciaban al arrancar antes que su base. Ya corregidos. Comprobado: las 53 pruebas pasan en Kubernetes, las NetworkPolicy aíslan las bases (RNF02), el Gateway y ms-inventario escalan de 1 a 4 copias (RNF05) y los datos sobreviven al reinicio de una base. |

## 3. Reflexión final de la fase *(borrador: reescribir con tus palabras)*

En esta fase usamos la IA como implementadora de servicios con contratos ya definidos, como revisora de lo que hicieron los demás
integrantes y como apoyo para probar el sistema completo. Los contratos de la Entrega 2 fueron la referencia constante: lo que no
estaba en ellos se anotó como decisión para que alguien lo confirmara.

Lo que más se repitió fue que **lo generado parecía correcto hasta que se ejecutó contra algo real**: un fallo de integración entre
servicios que las pruebas de cada uno no veían, un `docker-compose` que no arrancaba, manifiestos de Kubernetes que el clúster rechazó y
un kardex que se vuelve lento con muchos datos. Por eso el criterio que se fue consolidando fue no dar por terminado nada sin
ejecutarlo: primero con pruebas unitarias, luego con los servicios reales y finalmente en Kubernetes. También conviene dejar escrito lo que
**no** se verificó (correo real, rendimiento por el Gateway), para no afirmarlo sin evidencia.

Otra regla fue que **el equipo decide lo que entra**: las herramientas nuevas se consultaron antes de instalarlas, los cambios que
tocaban código de otros integrantes se explicaron en el pull request y se evitó mezclar en un mismo commit servicios distintos.

## 4. Plantilla para Luis y Mateo

Cada uno debe registrar sus propias interacciones con herramientas de IA en esta fase (si usó alguna), con el mismo formato:

| Fecha | Integrante | Herramienta de IA | Tarea / actividad apoyada | Prompt utilizado (resumen) | Nivel de intervención humana | Resultado / aprendizaje |
|---|---|---|---|---|---|---|
| | Luis Alejandro Saraza Marín | | *(por ejemplo: ms-compras y ms-notificaciones, PR #12; pruebas de rendimiento de compras y notificaciones)* | | | |
| | Mateo Falla Muñoz | | *(por ejemplo: ms-catalogo, ms-proveedores y ms-reportes, PR #4 a #7 y #13)* | | | |

> *El nivel de intervención humana (Alto, Medio o Bajo) indica cuánto modificó el equipo lo que generó la IA.*

## 5. Evidencia en el repositorio

- Pull requests fusionados: #1 a #3 (Gateway), #8 y #9 (ms-inventario), #11 y #13 (integración de ms-reportes), #14 y #15 (cliente web, compose y Kubernetes), #16 (conteos, importaciones, rendimiento y análisis de código).
- Pruebas: `smoke-tests/verificar_sistema.py` (53 pruebas de todo el sistema), `performance-tests/brayan-collazos/` (15 de rendimiento) y las suites de cada servicio.
- Decisiones de `ms-inventario`: `services/ms-inventario/DECISIONES.md`.
