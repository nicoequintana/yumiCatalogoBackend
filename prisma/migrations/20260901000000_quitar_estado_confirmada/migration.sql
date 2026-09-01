BEGIN TRY

BEGIN TRAN;

-- Se elimina el estado CONFIRMADA del flujo de órdenes.
--
-- La operación real no lo usa: quien acepta un pedido lo empieza a preparar en
-- el mismo movimiento, así que "Confirmada" y "En preparación" nombraban el
-- mismo momento. Las órdenes que estaban en CONFIRMADA pasan a EN_PREPARACION,
-- que es el estado que hereda su significado y su efecto de stock.
--
-- `Orden.estado` es VarChar(20), no un enum de base: la lista ejecutable vive
-- en src/lib/estadosOrden.js. Esta migración solo mueve filas.
--
-- NO se toca `stockDescontado`. Esas órdenes YA descontaron stock y su flag ya
-- vale 1; reescribirlo introduciría justamente el error que la columna existe
-- para evitar (un descuento o una devolución de más). Esa omisión es lo que
-- hace la migración correcta con cero filas afectadas o con quinientas.
--
-- IRREVERSIBLE: después de esto no hay forma de saber qué órdenes pasaron por
-- CONFIRMADA. El rastro queda en AuditLog ("PENDIENTE -> CONFIRMADA"), que no
-- se toca.

UPDATE [dbo].[Orden] SET [estado] = 'EN_PREPARACION' WHERE [estado] = 'CONFIRMADA';

COMMIT TRAN;

END TRY
BEGIN CATCH

IF @@TRANCOUNT > 0
BEGIN
    ROLLBACK TRAN;
END;
THROW

END CATCH
