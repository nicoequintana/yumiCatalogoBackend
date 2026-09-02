import { describe, expect, it } from "vitest";
import {
  ORDEN_RESTAURACION,
  DEPENDENCIAS,
  nombreDeArchivo,
  serializarFila,
  enmascararConexion,
} from "./respaldo.js";

describe("ORDEN_RESTAURACION", () => {
  // EL TEST QUE IMPORTA. Restaurar `ItemOrden` antes que `Orden` falla por
  // clave foránea, y restaurar a medias es peor que no restaurar: quedan
  // órdenes sin sus líneas. Este test deriva la respuesta del grafo de
  // dependencias en vez de comparar contra una lista escrita a mano, así que
  // sigue siendo válido cuando alguien agregue una tabla.
  it("coloca cada tabla después de todas aquellas de las que depende", () => {
    for (const [tabla, padres] of Object.entries(DEPENDENCIAS)) {
      const posicion = ORDEN_RESTAURACION.indexOf(tabla);
      expect(posicion, `${tabla} falta en ORDEN_RESTAURACION`).toBeGreaterThan(-1);

      for (const padre of padres) {
        const posicionPadre = ORDEN_RESTAURACION.indexOf(padre);
        expect(
          posicionPadre,
          `${padre} (padre de ${tabla}) falta en ORDEN_RESTAURACION`,
        ).toBeGreaterThan(-1);
        expect(
          posicionPadre,
          `${tabla} se restaura antes que ${padre}, del que depende`,
        ).toBeLessThan(posicion);
      }
    }
  });

  it("declara una dependencia por cada tabla que tenga padres", () => {
    for (const tabla of Object.keys(DEPENDENCIAS)) {
      expect(ORDEN_RESTAURACION).toContain(tabla);
    }
  });

  it("no repite ninguna tabla", () => {
    expect(new Set(ORDEN_RESTAURACION).size).toBe(ORDEN_RESTAURACION.length);
  });
});

describe("serializarFila", () => {
  // Un `Decimal` de Prisma serializado con JSON.stringify sale como objeto
  // (`{s,e,d}`), no como número: el backup guardaría basura irrecuperable en
  // las columnas de plata. Mismo criterio que `mapProducto`, que emite string.
  it("convierte un Decimal de Prisma a string", () => {
    const decimalFalso = { toString: () => "45000", s: 1, e: 4, d: [45000] };
    Object.defineProperty(decimalFalso, "constructor", { value: { name: "Decimal" } });

    const fila = serializarFila({ precio: decimalFalso });

    expect(fila.precio).toBe("45000");
  });

  it("convierte una fecha a ISO 8601", () => {
    const fila = serializarFila({ createdAt: new Date("2026-09-02T15:30:00.000Z") });
    expect(fila.createdAt).toBe("2026-09-02T15:30:00.000Z");
  });

  it("preserva null sin convertirlo", () => {
    const fila = serializarFila({ costo: null, etiqueta: null });
    expect(fila.costo).toBeNull();
    expect(fila.etiqueta).toBeNull();
  });

  it("deja intactos strings, números y booleanos", () => {
    const fila = serializarFila({ nombre: "Botella", stock: 7, destacado: true });
    expect(fila).toEqual({ nombre: "Botella", stock: 7, destacado: true });
  });
});

describe("nombreDeArchivo", () => {
  // Sin `:` — Windows no admite ese carácter en un nombre de archivo, y el
  // backup tiene que poder bajarse a cualquier máquina para restaurarlo.
  it("no usa caracteres inválidos en Windows", () => {
    const nombre = nombreDeArchivo(new Date("2026-09-02T15:30:45.000Z"));
    expect(nombre).not.toMatch(/[:*?"<>|]/);
  });

  it("ordena alfabéticamente igual que cronológicamente", () => {
    const viejo = nombreDeArchivo(new Date("2026-09-02T09:00:00.000Z"));
    const nuevo = nombreDeArchivo(new Date("2026-09-02T15:00:00.000Z"));
    expect([nuevo, viejo].sort()).toEqual([viejo, nuevo]);
  });

  it("incluye la fecha completa hasta el segundo", () => {
    expect(nombreDeArchivo(new Date("2026-09-02T15:30:45.000Z"))).toBe(
      "yima-backup-2026-09-02T15-30-45Z.json",
    );
  });
});

describe("enmascararConexion", () => {
  // BUG REAL, encontrado al probar el script de restauración: la primera
  // versión enmascaraba el formato `user:pass@host` de PostgreSQL/MySQL, pero
  // este proyecto usa SQL Server, cuyo connection string lleva `;password=...`.
  // El script imprimía la contraseña de la base EN CLARO, y esa salida termina
  // en los logs del contenedor.
  it("oculta la password del connection string de SQL Server", () => {
    const salida = enmascararConexion(
      "sqlserver://localhost:14330;database=aura;user=sa;password=SuperSecreto123;encrypt=true",
    );

    expect(salida).not.toContain("SuperSecreto123");
    expect(salida).toContain("password=***");
  });

  it("conserva host, puerto y base para que se pueda verificar el destino", () => {
    const salida = enmascararConexion(
      "sqlserver://localhost:14330;database=aura;user=sa;password=x;encrypt=true",
    );

    expect(salida).toContain("localhost:14330");
    expect(salida).toContain("database=aura");
  });

  it("oculta también el formato user:pass@host de otros motores", () => {
    const salida = enmascararConexion("postgresql://admin:Secreto99@db.interno:5432/yima");

    expect(salida).not.toContain("Secreto99");
    expect(salida).toContain("db.interno:5432");
  });

  it("no rompe con una cadena vacía o ausente", () => {
    expect(enmascararConexion("")).toBe("(sin DATABASE_URL)");
    expect(enmascararConexion(undefined)).toBe("(sin DATABASE_URL)");
  });

  it("es insensible a mayúsculas en el nombre del parámetro", () => {
    expect(enmascararConexion("sqlserver://h;Password=Secreto1")).not.toContain("Secreto1");
    expect(enmascararConexion("sqlserver://h;PWD=Secreto2")).not.toContain("Secreto2");
  });
});
