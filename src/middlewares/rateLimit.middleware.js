import { rateLimit } from "express-rate-limit";

// Fábrica reutilizable de limitadores de velocidad. Cada call site define su
// propia ventana/máximo (ej. login vs. futuras órdenes en Sprint 4), pero
// todos comparten el mismo shape de respuesta de error y configuración base.
//
// LIMITACIÓN CONOCIDA: el store por defecto de express-rate-limit es en
// memoria (por proceso de Node). Hoy el proyecto deploya un único contenedor
// en EasyPanel (ver CLAUDE.md), así que esto es correcto. Si en el futuro el
// deploy escala horizontalmente a múltiples instancias, el conteo dejaría de
// ser compartido entre procesos y el límite se resetearía por instancia. No
// se resuelve acá (requeriría un store externo tipo Redis) por ser
// over-engineering para el deploy actual de un solo contenedor.
export function crearLimitadorDeVelocidad({ windowMs, max, message = "Demasiadas solicitudes, probá de nuevo más tarde." }) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req, res) => {
      res.status(429).json({ error: message });
    },
  });
}
