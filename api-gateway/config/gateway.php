<?php

return [

    /*
    |--------------------------------------------------------------------------
    | Primer administrador
    |--------------------------------------------------------------------------
    |
    | Solo un administrador crea usuarios, así que sin este nadie podría entrar.
    | Lo crea el AdminSeeder con cambio de contraseña pendiente. Las variables
    | se leen aquí y en ningún otro sitio: el resto del código usa config().
    |
    */

    'admin' => [
        'correo' => env('ADMIN_EMAIL'),
        'contrasena' => env('ADMIN_PASSWORD'),
    ],

];
