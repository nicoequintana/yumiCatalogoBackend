BEGIN TRY

BEGIN TRAN;

-- AlterTable
ALTER TABLE [dbo].[Product] ADD [sku] NVARCHAR(1000),
[visibleEnCatalogo] BIT NOT NULL CONSTRAINT [Product_visibleEnCatalogo_df] DEFAULT 0;

-- CreateIndex
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

-- Backfill: productos existentes quedan visibles (no se ocultan al desplegar este cambio)
-- y SKU para productos existentes, misma regla que generarSku()
-- (YIMA-{primeras 6 letras/números en mayúscula, sin espacios}-{id}).
-- Envuelto en EXEC(dynamic SQL) porque el driver de Prisma para SQL Server
-- ejecuta todo migration.sql como un único batch (no soporta separadores
-- `GO`): sin EXEC, el compilador de T-SQL resuelve los nombres de columna
-- de este UPDATE al parsear el batch completo, ANTES de que el ALTER TABLE
-- de arriba se ejecute en runtime, y falla con "Invalid column name".
EXEC(N'
UPDATE [dbo].[Product] SET [visibleEnCatalogo] = 1;

UPDATE [dbo].[Product]
SET [sku] = CONCAT(
  ''YIMA-'',
  UPPER(
    LEFT(
      (
        SELECT STRING_AGG(c, '''')
        FROM (
          SELECT SUBSTRING([nombre], n, 1) AS c
          FROM (SELECT TOP (LEN([nombre])) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS n FROM sys.objects) nums
          WHERE SUBSTRING([nombre], n, 1) LIKE ''[A-Za-z0-9]''
        ) letras
      ),
      6
    )
  ),
  ''-'',
  CAST([id] AS VARCHAR(20))
)
WHERE [sku] IS NULL;
');
