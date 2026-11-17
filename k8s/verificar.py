#!/usr/bin/env python3
"""Revisión estática de los manifiestos de k8s/ (RNF04, RNF05, RNF09). No necesita un clúster ni Docker.

Uso (desde la raíz del repositorio):  kubectl kustomize k8s | python3 k8s/verificar.py
Requiere PyYAML (pip install pyyaml). Sale con código 1 y lista los problemas si encuentra alguno.

Vigila lo que puede desfasarse sin que nada más lo note: un Service que no apunta a ningún pod, un Secret que ninguna plantilla
define, un contenedor sin recursos (el HPA no podría medir el procesador), un servicio publicado hacia fuera sin pasar por el
Ingress, o un puerto distinto al que expone la imagen.
"""
import os
import re
import sys

import yaml

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PUBLICOS = {"web-client", "api-gateway"}  # RNF09: lo único que sale del clúster
ETIQUETA = "app.kubernetes.io/name"


def cargar(texto):
    return [d for d in yaml.safe_load_all(texto) if d]


def exponen(servicio):
    """El puerto que declara EXPOSE el Dockerfile del servicio."""
    ruta = "web-client" if servicio == "web-client" else ("api-gateway" if servicio == "api-gateway" else f"services/{servicio}")
    with open(os.path.join(RAIZ, ruta, "Dockerfile"), encoding="utf-8") as f:
        m = re.search(r"^EXPOSE\s+(\d+)", f.read(), re.M)
    return int(m.group(1)) if m else None


def main():
    objetos = cargar(sys.stdin.read())
    with open(os.path.join(RAIZ, "k8s/base/secretos.example.yaml"), encoding="utf-8") as f:
        secretos = {d["metadata"]["name"]: set(d["stringData"]) for d in cargar(f.read())}
    por_tipo = {}
    for o in objetos:
        por_tipo.setdefault(o["kind"], {})[o["metadata"]["name"]] = o
    problemas = []

    def mal(texto):
        problemas.append(texto)

    cargas = {**por_tipo.get("Deployment", {}), **por_tipo.get("StatefulSet", {})}
    configmaps = {n: set(c.get("data", {})) for n, c in por_tipo.get("ConfigMap", {}).items()}

    # 1. Contenedores: recursos, sondas y seguridad
    for nombre, o in cargas.items():
        pod = o["spec"]["template"]["spec"]
        for c in pod["containers"]:
            if not c.get("resources", {}).get("requests", {}).get("cpu"):
                mal(f"{nombre}/{c['name']}: sin resources.requests.cpu (el HPA no puede medir el procesador)")
            if not c.get("resources", {}).get("limits", {}).get("memory"):
                mal(f"{nombre}/{c['name']}: sin límite de memoria")
            if not c.get("readinessProbe") or not c.get("livenessProbe"):
                mal(f"{nombre}/{c['name']}: faltan las sondas de disponibilidad y de vida")
        if o["kind"] == "Deployment":
            seg = pod.get("securityContext", {})
            if seg.get("runAsNonRoot") is not True:
                mal(f"{nombre}: el pod no declara runAsNonRoot")
            for c in pod["containers"]:
                s = c.get("securityContext", {})
                if s.get("allowPrivilegeEscalation") is not False or "ALL" not in s.get("capabilities", {}).get("drop", []):
                    mal(f"{nombre}/{c['name']}: debe impedir la escalada de privilegios y quitar todas las capacidades")
                if c["image"].endswith(":latest") is False and ":" not in c["image"]:
                    mal(f"{nombre}/{c['name']}: la imagen no lleva etiqueta")

    # 2. Services: apuntan a pods que existen, por puerto con nombre
    for nombre, s in por_tipo.get("Service", {}).items():
        if s["spec"].get("type", "ClusterIP") != "ClusterIP":
            mal(f"Service {nombre}: es {s['spec']['type']}; solo se publica hacia fuera a través del Ingress (RNF09)")
        destino = s["spec"]["selector"][ETIQUETA]
        carga = cargas.get(destino)
        if not carga:
            mal(f"Service {nombre}: ningún Deployment ni StatefulSet se llama {destino}")
            continue
        puertos = {p["name"]: p["containerPort"] for c in carga["spec"]["template"]["spec"]["containers"] for p in c["ports"]}
        for p in s["spec"]["ports"]:
            if p["targetPort"] not in puertos:
                mal(f"Service {nombre}: targetPort {p['targetPort']} no existe en el contenedor")
            elif nombre in PUBLICOS | {n for n in cargas if n.startswith("ms-")}:
                esperado = exponen(nombre)
                if esperado and puertos[p["targetPort"]] != esperado:
                    mal(f"{nombre}: el contenedor escucha en {puertos[p['targetPort']]} pero su imagen expone {esperado}")
                if p["port"] != esperado:
                    mal(f"Service {nombre}: expone el puerto {p['port']} y los demás servicios lo llaman en {esperado}")

    # 3. Secretos y ConfigMap que se referencian existen en la plantilla / en la base
    def referencias(plantilla):
        for c in plantilla["spec"]["containers"] + plantilla["spec"].get("initContainers", []):
            for e in c.get("env", []):
                vf = e.get("valueFrom", {})
                if "secretKeyRef" in vf:
                    yield "secret", vf["secretKeyRef"], e["name"]
                if "configMapKeyRef" in vf:
                    yield "configmap", vf["configMapKeyRef"], e["name"]

    plantillas = [(n, o["spec"]["template"]) for n, o in {**cargas, **por_tipo.get("Job", {})}.items()]
    with open(os.path.join(RAIZ, "k8s/base/sembrar-administrador.yaml"), encoding="utf-8") as f:
        plantillas += [(d["metadata"]["name"], d["spec"]["template"]) for d in cargar(f.read())]
    for nombre, t in plantillas:
        for tipo, ref, variable in referencias(t):
            if tipo == "secret":
                if ref["name"] not in secretos:
                    mal(f"{nombre}: {variable} usa el Secret {ref['name']}, que secretos.example.yaml no define")
                elif ref["key"] not in secretos[ref["name"]]:
                    mal(f"{nombre}: el Secret {ref['name']} no tiene la clave {ref['key']}")
            elif ref["name"] not in configmaps or ref["key"] not in configmaps[ref["name"]]:
                mal(f"{nombre}: {variable} usa el ConfigMap {ref['name']}/{ref['key']}, que no existe")

    # 4. Cada base de datos que un pod usa existe y cada pod con base lleva su etiqueta de acceso
    servicios = set(por_tipo.get("Service", {}))
    for nombre, t in plantillas:
        etiqueta_db = t["metadata"]["labels"].get("db")
        for c in t["spec"]["containers"]:
            for e in c.get("env", []):
                if e["name"] == "DB_HOST":
                    if e["value"] not in servicios:
                        mal(f"{nombre}: DB_HOST={e['value']} no es un Service")
                    if etiqueta_db != e["value"]:
                        mal(f"{nombre}: usa {e['value']} pero su etiqueta db es {etiqueta_db} (la NetworkPolicy lo dejaría sin acceso)")

    # 5. Escalado (RNF05): HPA solo para el Gateway y ms-inventario, de 1 a 4 al 70 %; compras y notificaciones, una sola copia
    for nombre, h in por_tipo.get("HorizontalPodAutoscaler", {}).items():
        s = h["spec"]
        objetivo = s["scaleTargetRef"]["name"]
        if objetivo not in por_tipo.get("Deployment", {}):
            mal(f"HPA {nombre}: apunta a {objetivo}, que no es un Deployment")
        if (s["minReplicas"], s["maxReplicas"]) != (1, 4):
            mal(f"HPA {nombre}: debe ir de 1 a 4 copias")
        if s["metrics"][0]["resource"]["target"]["averageUtilization"] != 70:
            mal(f"HPA {nombre}: el umbral de procesador debe ser 70 %")
    if set(por_tipo.get("HorizontalPodAutoscaler", {})) != {"api-gateway", "ms-inventario"}:
        mal("Solo el Gateway y ms-inventario escalan (RNF05)")
    for nombre in ("ms-compras", "ms-notificaciones"):
        if por_tipo["Deployment"][nombre]["spec"]["replicas"] != 1:
            mal(f"{nombre}: debe tener una sola copia (migra al arrancar y/o programa su revisión dentro del proceso)")

    # 6. RNF09: el Ingress solo publica el cliente web y el Gateway; todo lo demás queda cerrado por NetworkPolicy
    publicados = {r["backend"]["service"]["name"] for i in por_tipo.get("Ingress", {}).values() for regla in i["spec"]["rules"] for r in regla["http"]["paths"]}
    if publicados != PUBLICOS:
        mal(f"El Ingress publica {sorted(publicados)}; solo deben ser {sorted(PUBLICOS)}")
    politicas = por_tipo.get("NetworkPolicy", {})
    if "denegar-entrada-por-defecto" not in politicas:
        mal("Falta la política que deniega por defecto toda entrada")
    protegidos = {p["spec"]["podSelector"].get("matchLabels", {}).get(ETIQUETA) for p in politicas.values()}
    for nombre in cargas:
        if nombre not in protegidos:
            mal(f"{nombre}: ninguna NetworkPolicy declara quién puede llamarlo")

    if problemas:
        print(f"{len(problemas)} problema(s) en los manifiestos de k8s/:")
        for p in problemas:
            print(" -", p)
        sys.exit(1)
    print(f"Manifiestos correctos: {len(objetos)} objetos, {len(cargas)} cargas, {len(por_tipo.get('Service', {}))} Services, "
          f"{len(politicas)} NetworkPolicy, {len(por_tipo.get('HorizontalPodAutoscaler', {}))} HPA.")


if __name__ == "__main__":
    main()
