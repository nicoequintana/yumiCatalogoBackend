BEGIN TRY

BEGIN TRAN;

-- AlterTable
ALTER TABLE [dbo].[Product] ADD [destacado] BIT NOT NULL CONSTRAINT [Product_destacado_df] DEFAULT 0,
[disponibilidad] VARCHAR(20) NOT NULL CONSTRAINT [Product_disponibilidad_df] DEFAULT 'DISPONIBLE',
[orden] INT NOT NULL CONSTRAINT [Product_orden_df] DEFAULT 0;

-- CreateIndex
CREATE NONCLUSTERED INDEX [Product_visibleEnCatalogo_orden_idx] ON [dbo].[Product]([visibleEnCatalogo], [orden]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [Product_destacado_idx] ON [dbo].[Product]([destacado]);

COMMIT TRAN;

END TRY
BEGIN CATCH

IF @@TRANCOUNT > 0
BEGIN
    ROLLBACK TRAN;
END;
THROW

END CATCH
