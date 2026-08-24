/**
 * `robots.txt`, servido por el backend en vez de ser un estático del frontend.
 *
 * El motivo es la directiva `Sitemap:`: tiene que apuntar a una URL absoluta
 * del dominio público, y un archivo estático la dejaría hardcodeada. Acá sale
 * de `FRONTEND_URL`, la misma variable que usa el sitemap para armar sus
 * `<loc>` — así las dos no pueden divergir.
 *
 * OJO con `Disallow` vs `noindex`: son mutuamente excluyentes. Una ruta
 * bloqueada acá NUNCA se rastrea, así que el crawler tampoco lee su
 * `<meta name="robots" content="noindex">` — y si alguien la linkea, se
 * indexa igual, sin descripción y sin forma de sacarla. Por eso:
 *   - `/catalogo/admin` va con Disallow: no queremos ni que entre.
 *   - `/carrito`, `/checkout`, `/favoritos` NO van acá: necesitamos que el
 *     crawler entre y lea el `noindex` que emite la SPA.
 */
export function servirRobots(_req, res) {
  const frontendUrl = process.env.FRONTEND_URL ?? "http://localhost:5173";

  const cuerpo = `User-agent: *
Allow: /
Disallow: /catalogo/admin

Sitemap: ${frontendUrl}/sitemap.xml
`;

  res.status(200).type("text/plain").send(cuerpo);
}
