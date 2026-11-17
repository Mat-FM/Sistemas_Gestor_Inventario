<?php

/*
|--------------------------------------------------------------------------
| Cómo se muestran las fechas
|--------------------------------------------------------------------------
|
| La API envía los instantes en UTC; Laravel conserva `app.timezone` en UTC y la pantalla los muestra en la hora de la
| distribuidora (Colombia, sin horario de verano).
|
*/

return [
    'zona_horaria' => env('APP_TIMEZONE', 'America/Bogota'),
];
