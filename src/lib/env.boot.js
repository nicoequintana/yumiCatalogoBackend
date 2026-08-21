// Disparador de la validación de entorno, con efecto al importarse.
//
// POR QUÉ ES UN ARCHIVO APARTE de `env.js`: en ESM, TODOS los imports de un
// módulo se evalúan antes que su primera línea ejecutable. Si `server.js`
// llamara a `validarEntorno()` como sentencia normal, para cuando corriera ya
// se habrían evaluado los routers → controllers → `lib/prisma.js`, que
// construye el adapter de SQL Server con `process.env.DATABASE_URL` al
// importarse. Con la variable faltante, eso revienta primero y con un error
// del driver en vez del listado claro de qué falta configurar.
//
// Importando ESTE módulo como segundo import de `server.js` (después de
// `dotenv/config`, que puebla `process.env`, y antes de cualquier router), la
// validación gana la carrera.
//
// El efecto vive acá y no en `env.js` para que `env.js` siga siendo importable
// sin consecuencias: sus funciones se testean, y los 40+ archivos de test del
// backend importan rutas y controllers sin un entorno completo — una
// validación que cortara el proceso al importarse los tumbaría a todos.
import { validarEntorno } from "./env.js";

validarEntorno();
