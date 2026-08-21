BEGIN TRY

BEGIN TRAN;

-- Drop the UNIQUE constraint first: SQL Server refuses ALTER COLUMN on a
-- column that has a dependent index/constraint (error 5074).
ALTER TABLE [dbo].[Product] DROP CONSTRAINT [Product_sku_key];

-- AlterTable
ALTER TABLE [dbo].[Product] ALTER COLUMN [sku] NVARCHAR(1000) NOT NULL;

-- Recreate the UNIQUE constraint now that the column is NOT NULL.
ALTER TABLE [dbo].[Product] ADD CONSTRAINT [Product_sku_key] UNIQUE NONCLUSTERED ([sku]);

COMMIT TRAN;

END TRY
BEGIN CATCH

IF @@TRANCOUNT > 0
BEGIN
    ROLLBACK TRAN;
END;
THROW

END CATCH
