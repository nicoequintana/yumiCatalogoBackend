BEGIN TRY

BEGIN TRAN;

-- Se elimina `Product.orden`, el "orden manual de merchandising".
--
-- Nunca se usó: al momento de esta migración, los 80 productos de producción
-- tenían TODOS `orden = 0`, así que el criterio efectivo del listado ya era el
-- desempate (`createdAt` descendente). Por eso el default del listado pasa a
-- `recientes` sin que cambie nada de lo que se ve en la tienda.
--
-- Es IRREVERSIBLE: si algún día se quiere volver, hay que rehacer la columna y
-- recargar los valores a mano (no quedan guardados en ninguna parte).

-- DropIndex
-- El índice nombraba la columna, así que se baja antes de borrarla.
DROP INDEX [Product_visibleEnCatalogo_orden_idx] ON [dbo].[Product];

-- AlterTable
-- La constraint del DEFAULT se borra por nombre antes que la columna: SQL
-- Server no deja eliminar una columna que todavía tiene un default asociado.
ALTER TABLE [dbo].[Product] DROP CONSTRAINT [Product_orden_df];
ALTER TABLE [dbo].[Product] DROP COLUMN [orden];

-- CreateIndex
-- Reemplazo: la consulta del listado público filtra por `visibleEnCatalogo` y
-- ordena por `createdAt`.
CREATE NONCLUSTERED INDEX [Product_visibleEnCatalogo_createdAt_idx] ON [dbo].[Product]([visibleEnCatalogo], [createdAt]);

COMMIT TRAN;

END TRY
BEGIN CATCH

IF @@TRANCOUNT > 0
BEGIN
    ROLLBACK TRAN;
END;
THROW

END CATCH
