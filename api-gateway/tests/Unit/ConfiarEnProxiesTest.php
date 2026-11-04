<?php

namespace Tests\Unit;

use App\Http\Middleware\ConfiarEnProxies;
use InvalidArgumentException;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

/**
 * El analizador puro de TRUSTED_PROXIES: lista de IP (v4 o v6) o CIDR separados por comas; las entradas vacías y
 * los espacios se ignoran; confiar en todos y las entradas que no son IP ni CIDR fallan con un error claro.
 */
class ConfiarEnProxiesTest extends TestCase
{
    /** @return array<string, array{mixed, list<string>}> */
    public static function validos(): array
    {
        return [
            'vacía' => ['', []],
            'nula (variable ausente)' => [null, []],
            'solo espacios' => ['   ', []],
            'solo comas y espacios' => [' , ,, ', []],
            'una IPv4' => ['10.1.2.3', ['10.1.2.3']],
            'una IPv6' => ['2001:db8::1', ['2001:db8::1']],
            'CIDR IPv4' => ['10.0.0.0/8', ['10.0.0.0/8']],
            'CIDR IPv6' => ['fd00::/8', ['fd00::/8']],
            'CIDR /32 y /128' => ['10.1.2.3/32,::1/128', ['10.1.2.3/32', '::1/128']],
            'varias con espacios y entradas vacías' => [' 10.0.0.0/8 , , 192.168.0.1 ,', ['10.0.0.0/8', '192.168.0.1']],
        ];
    }

    /** @param  list<string>  $esperado */
    #[DataProvider('validos')]
    public function test_acepta_ips_y_cidr_e_ignora_vacios_y_espacios(mixed $valor, array $esperado): void
    {
        $this->assertSame($esperado, ConfiarEnProxies::analizar($valor));
    }

    /** @return array<string, array{string}> */
    public static function confiarEnTodos(): array
    {
        return [
            'comodín' => ['*'],
            'comodín con espacios' => [' * '],
            'CIDR y comodín' => ['10.0.0.0/8,*'],
            'doble comodín' => ['**'],
            'REMOTE_ADDR' => ['REMOTE_ADDR'],
            'todo IPv4' => ['0.0.0.0/0'],
            'todo IPv6' => ['::/0'],
        ];
    }

    #[DataProvider('confiarEnTodos')]
    public function test_rechaza_confiar_en_todos_con_un_error_claro(string $valor): void
    {
        $this->expectException(InvalidArgumentException::class);
        $this->expectExceptionMessage('TRUSTED_PROXIES no admite «*» ni otra forma de confiar en todos los proxies');

        ConfiarEnProxies::analizar($valor);
    }

    /** @return array<string, array{string, string}> valor => entrada que se nombra en el error */
    public static function invalidos(): array
    {
        return [
            'texto' => ['no-es-una-ip', 'no-es-una-ip'],
            'nombre de host' => ['10.0.0.1,ingress.interno', 'ingress.interno'],
            'IPv4 fuera de rango' => ['10.0.0.256', '10.0.0.256'],
            'prefijo IPv4 mayor que 32' => ['10.0.0.0/33', '10.0.0.0/33'],
            'prefijo IPv6 mayor que 128' => ['fd00::/129', 'fd00::/129'],
            'prefijo vacío' => ['10.0.0.0/', '10.0.0.0/'],
            'prefijo no numérico' => ['10.0.0.0/ocho', '10.0.0.0/ocho'],
            'dos barras' => ['10.0.0.0/8/8', '10.0.0.0/8/8'],
            'alias de Symfony' => ['PRIVATE_SUBNETS', 'PRIVATE_SUBNETS'],
        ];
    }

    #[DataProvider('invalidos')]
    public function test_una_entrada_que_no_es_ip_ni_cidr_falla_con_un_error_claro(string $valor, string $entrada): void
    {
        $this->expectException(InvalidArgumentException::class);
        $this->expectExceptionMessage("TRUSTED_PROXIES contiene «{$entrada}», que no es una IP ni un CIDR");

        ConfiarEnProxies::analizar($valor);
    }
}
