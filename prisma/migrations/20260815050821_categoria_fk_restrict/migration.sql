BEGIN TRY

BEGIN TRAN;

-- DropForeignKey
ALTER TABLE [dbo].[Product] DROP CONSTRAINT [Product_categoriaId_fkey];

-- AddForeignKey
ALTER TABLE [dbo].[Product] ADD CONSTRAINT [Product_categoriaId_fkey] FOREIGN KEY ([categoriaId]) REFERENCES [dbo].[Categoria]([id]) ON DELETE NO ACTION ON UPDATE CASCADE;

COMMIT TRAN;

END TRY
BEGIN CATCH

IF @@TRANCOUNT > 0
BEGIN
    ROLLBACK TRAN;
END;
THROW

END CATCH
