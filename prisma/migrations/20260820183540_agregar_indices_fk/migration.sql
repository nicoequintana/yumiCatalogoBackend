BEGIN TRY

BEGIN TRAN;

-- CreateIndex
CREATE NONCLUSTERED INDEX [Product_categoriaId_idx] ON [dbo].[Product]([categoriaId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [Caracteristica_productId_idx] ON [dbo].[Caracteristica]([productId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [Especificacion_productId_orden_idx] ON [dbo].[Especificacion]([productId], [orden]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [Foto_productId_orden_idx] ON [dbo].[Foto]([productId], [orden]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [EventoTrafico_createdAt_idx] ON [dbo].[EventoTrafico]([createdAt]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [Orden_createdAt_idx] ON [dbo].[Orden]([createdAt]);

COMMIT TRAN;

END TRY
BEGIN CATCH

IF @@TRANCOUNT > 0
BEGIN
    ROLLBACK TRAN;
END;
THROW

END CATCH
