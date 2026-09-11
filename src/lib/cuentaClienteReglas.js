import { HORAS_PURGA_NO_VERIFICADAS } from "./cuentasCliente.js";

/**
 * Reglas de la cuenta de cliente que comparten más de un controller (cuenta
 * y panel admin). Viven acá para que la ventana de 24 h y su purga no se
 * redefinan en cada punta con criterios que se desfasen.
 */

export const MS_PURGA_NO_VERIFICADAS = HORAS_PURGA_NO_VERIFICADAS * 60 * 60 * 1000;

/**
 * Antes de mover una cuenta a `email`, borra la fila que ya lo tiene SOLO si
 * es un registro abandonado: nunca verificada (`verificadaEn` NULL), fuera de
 * su ventana de 24 h y sin pedidos (FK `NoAction` de `Orden`). Esa fila ya es
 * "inexistente" para login y recuperación; sin esto el `update` del email
 * chocaría con el UNIQUE (409) contra una cuenta muerta que la purga todavía
 * no alcanzó. `cliente` es `prisma` o el `tx` de la transacción que escribe.
 */
export async function purgarVencidaConEmail(cliente, email) {
  await cliente.cuentaCliente.deleteMany({
    where: {
      email,
      emailVerificado: false,
      verificadaEn: null,
      createdAt: { lt: new Date(Date.now() - MS_PURGA_NO_VERIFICADAS) },
      ordenes: { none: {} },
    },
  });
}
