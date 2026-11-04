<?php

namespace App\Providers;

use App\Services\Jwt\JwtService;
use Illuminate\Support\ServiceProvider;

class AppServiceProvider extends ServiceProvider
{
    /**
     * Register any application services.
     */
    public function register(): void
    {
        // El cast a string convierte un secreto ausente en una InvalidArgumentException clara
        // (JwtService lo rechaza) y no en un TypeError.
        $this->app->singleton(JwtService::class, fn () => new JwtService(
            (string) config('gateway.jwt.secret'),
            (int) config('gateway.jwt.ttl_minutes'),
        ));
    }

    /**
     * Bootstrap any application services.
     */
    public function boot(): void
    {
        //
    }
}
