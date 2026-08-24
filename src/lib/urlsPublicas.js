/**
 * URLs públicas del sitio (frontend / backend), leídas del entorno con
 * default y SIEMPRE sin barra final.
 *
 * El proyecto ya se comió este problema una vez: `notificacionesOrden.service.js`
 * documenta que en EasyPanel es fácil cargar `FRONTEND_URL` con una barra
 * final, y que un link con `//` en el medio queda feo y rompe en algunos
 * clientes de correo. Ese archivo lo resuelve con su propio `replace` local,
 * a propósito fuera de este módulo (es el camino de los mails transaccionales,
 * con su propia superficie de riesgo — no se toca acá).
 *
 * Lo que cambia ahora es QUÉ depende de esta normalización: de `FRONTEND_URL`
 * y `BACKEND_PUBLIC_URL` salen el `<link rel="canonical">` del HTML para
 * crawlers, la `url` del `Offer` en el JSON-LD, cada `<loc>` del sitemap y la
 * directiva `Sitemap:` de `robots.txt`. Sin normalizar, una variable cargada
 * con barra final produce `https://dominio.com//producto/123-x` en los
 * cuatro — y como una tarea posterior hace que la SPA emita su propio
 * `<link rel="canonical">` SIN barra final (constante hardcodeada), los dos
 * canonical del mismo producto quedarían distintos: Google recibe dos
 * señales contradictorias sobre cuál es la URL buena, reparte la autoridad
 * entre las dos y ninguna rankea. Sin error, sin test rojo, sin nada que se
 * vea — exactamente la falla silenciosa que esta feature de SEO existe para
 * evitar.
 *
 * Una variable vacía cuenta como no seteada, mismo criterio que `lib/env.js`
 * para las variables obligatorias del arranque.
 */

function sinBarraFinal(url) {
  return url.replace(/\/+$/, "");
}

export function urlFrontend() {
  return sinBarraFinal(process.env.FRONTEND_URL || "http://localhost:5173");
}

export function urlBackend() {
  return sinBarraFinal(process.env.BACKEND_PUBLIC_URL || "http://localhost:4000");
}
