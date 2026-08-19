BEGIN TRY

BEGIN TRAN;

-- AlterTable
ALTER TABLE [dbo].[Product] DROP CONSTRAINT [Product_disponibilidad_df];
ALTER TABLE [dbo].[Product] DROP COLUMN [disponibilidad];
ALTER TABLE [dbo].[Product] ADD [stock] INT NOT NULL CONSTRAINT [Product_stock_df] DEFAULT 0;

COMMIT TRAN;

END TRY
BEGIN CATCH

IF @@TRANCOUNT > 0
BEGIN
    ROLLBACK TRAN;
END;
THROW

END CATCH
