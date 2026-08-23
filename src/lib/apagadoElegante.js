// Apagado elegante (graceful shutdown) del servidor HTTP.
//
// POR QUÉ EXISTE: EasyPanel manda SIGTERM al contenedor en CADA redeploy. Sin
// handler, Node se muere en el acto: las requests en vuelo se cortan a mitad
// de respuesta (el cliente ve un error de red, no un error de la app) y las
// transacciones abiertas contra SQL Server quedan colgando hasta que el motor
// las limpia por timeout. Con checkout de invitado y descuento de stock dentro
// de una transacción, eso es exactamente lo que no se quiere interrumpir.
//
// La secuencia es: dejar de aceptar conexiones nuevas → esperar a que las que
// están en curso terminen → cerrar el pool de Prisma → salir.

const TIMEOUT_APAGADO_MS = 10_000;

/**
 * Registra los handlers de SIGTERM/SIGINT que apagan el proceso ordenadamente.
 *
 * Todo lo externo se inyecta para poder testear el apagado sin levantar un
 * servidor real ni matar el proceso de test.
 *
 * @param {object} opciones
 * @param {{ close: (cb: (err?: Error) => void) => void }} opciones.server servidor HTTP de Express
 * @param {{ $disconnect: () => Promise<void> }} opciones.prisma cliente de Prisma
 * @param {number} [opciones.timeoutMs=10000] tope duro antes de forzar la salida
 * @param {(codigo: number) => void} [opciones.exit=process.exit]
 * @param {(mensaje: string) => void} [opciones.log=console.log]
 * @param {{ on: Function }} [opciones.proceso=process]
 * @returns {(senal: string) => Promise<void>} el handler, expuesto para testearlo
 */
export function registrarApagadoElegante({
  server,
  prisma,
  timeoutMs = TIMEOUT_APAGADO_MS,
  exit = process.exit,
  log = console.log,
  proceso = process,
}) {
  let apagando = false;

  async function apagar(senal) {
    // Kubernetes/EasyPanel pueden mandar la señal más de una vez, y un
    // segundo SIGTERM no debe reiniciar el timer ni volver a cerrar el pool.
    if (apagando) return;
    apagando = true;

    log(`Recibido ${senal}: cerrando el servidor…`);

    // TOPE DURO: si una conexión keep-alive o un stream de video largo no
    // termina nunca, `server.close()` jamás llama a su callback y el
    // contenedor se quedaría colgado hasta que el orquestador lo mate a la
    // fuerza (SIGKILL). Preferimos salir nosotros, a tiempo y con un log que
    // explique por qué, antes que un kill silencioso.
    //
    // `unref()` para que este timer no sea, él mismo, la razón por la que el
    // event loop sigue vivo cuando todo lo demás ya cerró.
    const temporizador = setTimeout(() => {
      log("El apagado elegante superó el tiempo límite: se fuerza la salida.");
      exit(1);
    }, timeoutMs);
    temporizador.unref?.();

    try {
      await cerrarServidor(server);
      await prisma.$disconnect();
      clearTimeout(temporizador);
      log("Servidor cerrado correctamente.");
      exit(0);
    } catch (err) {
      clearTimeout(temporizador);
      // Nunca dejar que un fallo del apagado se convierta en un proceso
      // zombi: se registra y se sale con código de error.
      log(`Error durante el apagado: ${err?.message ?? err}`);
      exit(1);
    }
  }

  proceso.on("SIGTERM", () => apagar("SIGTERM"));
  proceso.on("SIGINT", () => apagar("SIGINT"));

  return apagar;
}

/**
 * Promisifica `server.close()`. Node invoca el callback con un error si el
 * servidor ya estaba cerrado; ese caso no es una falla del apagado, así que
 * se resuelve igual.
 */
function cerrarServidor(server) {
  return new Promise((resolve, reject) => {
    server.close((err) => {
      if (err && err.code !== "ERR_SERVER_NOT_RUNNING") return reject(err);
      resolve();
    });
  });
}
