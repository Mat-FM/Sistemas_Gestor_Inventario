<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>@yield('titulo', 'Inventario') · El Montañero</title>
    <meta name="theme-color" content="#1a2c24">
    <link rel="icon" type="image/svg+xml" href="{{ asset('favicon.svg') }}">
    <link rel="preload" as="font" type="font/woff2" crossorigin href="{{ asset('vendor/fuentes/hanken-grotesk-latin-wght-normal.woff2') }}">
    <link rel="preload" as="font" type="font/woff2" crossorigin href="{{ asset('vendor/fuentes/fraunces-latin-wght-normal.woff2') }}">
    <link rel="stylesheet" href="{{ asset('vendor/bootstrap/bootstrap.min.css') }}">
    <link rel="stylesheet" href="{{ asset('vendor/bootstrap-icons/bootstrap-icons.min.css') }}">
    <link rel="stylesheet" href="{{ asset('css/app.css') }}">
</head>
<body class="@yield('clase-cuerpo')">
@yield('cuerpo')
<script src="{{ asset('vendor/bootstrap/bootstrap.bundle.min.js') }}"></script>
<script src="{{ asset('js/app.js') }}"></script>
</body>
</html>
