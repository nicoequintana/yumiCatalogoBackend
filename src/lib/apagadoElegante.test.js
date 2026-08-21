import { describe, expect, it, vi } from "vitest";
import { registrarApagadoElegante } from "./apagadoElegante.js";

function crearProcesoFalso() {
  const handlers = {};
  return {
    on: (senal, handler) => {
      handlers[senal] = handler;
    },
    emitir: (senal) => handlers[senal]?.(),
    tiene: (senal) => typeof handlers[senal] === "function",
  };
}

function crearDependencias({ closeImpl, disconnectImpl } = {}) {
  const server = {
    close: closeImpl ?? ((cb) => cb()),
  };
  const prisma = { $disconnect: disconnectImpl ?? vi.fn().mockResolvedValue(undefined) };
  const exit = vi.fn();
  const log = vi.fn();
  const proceso = crearProcesoFalso();
  return { server, prisma, exit, log, proceso };
}

describe("registrarApagadoElegante", () => {
  it("registra handlers para SIGTERM y SIGINT", () => {
    const deps = crearDependencias();

    registrarApagadoElegante(deps);

    expect(deps.proceso.tiene("SIGTERM")).toBe(true);
    expect(deps.proceso.tiene("SIGINT")).toBe(true);
  });

  it("cierra el servidor, desconecta Prisma y sale con 0", async () => {
    const closeSpy = vi.fn((cb) => cb());
    const deps = crearDependencias({ closeImpl: closeSpy });

    const apagar = registrarApagadoElegante(deps);
    await apagar("SIGTERM");

    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(deps.prisma.$disconnect).toHaveBeenCalledTimes(1);
    expect(deps.exit).toHaveBeenCalledWith(0);
  });

  it("desconecta Prisma DESPUÉS de cerrar el servidor, no antes", async () => {
    const orden = [];
    const deps = crearDependencias({
      closeImpl: (cb) => {
        orden.push("close");
        cb();
      },
      disconnectImpl: vi.fn(async () => {
        orden.push("disconnect");
      }),
    });

    const apagar = registrarApagadoElegante(deps);
    await apagar("SIGTERM");

    expect(orden).toEqual(["close", "disconnect"]);
  });

  it("es idempotente: una segunda señal no reintenta el apagado", async () => {
    const closeSpy = vi.fn((cb) => cb());
    const deps = crearDependencias({ closeImpl: closeSpy });

    const apagar = registrarApagadoElegante(deps);
    await apagar("SIGTERM");
    await apagar("SIGTERM");

    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(deps.exit).toHaveBeenCalledTimes(1);
  });

  it("fuerza la salida si el cierre se cuelga más allá del tiempo límite", async () => {
    vi.useFakeTimers();
    // Un `server.close` que nunca llama a su callback simula una conexión
    // keep-alive (o un stream de video) que no termina nunca.
    const deps = crearDependencias({ closeImpl: () => {} });

    const apagar = registrarApagadoElegante({ ...deps, timeoutMs: 10_000 });
    apagar("SIGTERM");
    await vi.advanceTimersByTimeAsync(10_000);

    expect(deps.exit).toHaveBeenCalledWith(1);
    vi.useRealTimers();
  });

  it("sale con código 1 si Prisma falla al desconectarse (nunca deja el proceso colgado)", async () => {
    const deps = crearDependencias({
      disconnectImpl: vi.fn().mockRejectedValue(new Error("pool roto")),
    });

    const apagar = registrarApagadoElegante(deps);
    await apagar("SIGTERM");

    expect(deps.exit).toHaveBeenCalledWith(1);
  });

  it("tolera que el servidor ya estuviera cerrado (ERR_SERVER_NOT_RUNNING no es una falla)", async () => {
    const err = new Error("Server is not running.");
    err.code = "ERR_SERVER_NOT_RUNNING";
    const deps = crearDependencias({ closeImpl: (cb) => cb(err) });

    const apagar = registrarApagadoElegante(deps);
    await apagar("SIGTERM");

    expect(deps.prisma.$disconnect).toHaveBeenCalledTimes(1);
    expect(deps.exit).toHaveBeenCalledWith(0);
  });

  it("el handler de SIGTERM del proceso dispara el apagado", async () => {
    const closeSpy = vi.fn((cb) => cb());
    const deps = crearDependencias({ closeImpl: closeSpy });

    registrarApagadoElegante(deps);
    deps.proceso.emitir("SIGTERM");
    await vi.waitFor(() => expect(deps.exit).toHaveBeenCalledWith(0));

    expect(closeSpy).toHaveBeenCalledTimes(1);
  });
});
