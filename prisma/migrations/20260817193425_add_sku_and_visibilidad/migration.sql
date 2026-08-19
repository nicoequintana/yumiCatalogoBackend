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
        SELECT STRING_AGG(c, '''') WITHIN GROUP (ORDER BY n)
        FROM (
          SELECT n, SUBSTRING([nombre], n, 1) AS c
          -- NOTA: sys.objects se usa como fuente barata de filas para generar la secuencia 1..LEN([nombre]).
          -- Su cantidad de filas depende de la instancia (tipicamente cientos en una instalacion nueva) y
          -- no esta garantizada. [nombre] no tiene largo maximo forzado en el schema, por lo que un nombre
          -- inusualmente largo podria no estar cubierto en su totalidad. Como abajo solo se toma LEFT(...,6),
          -- esto solo afecta el resultado si el nombre tiene menos de 6 caracteres alfanumericos dentro del
          -- rango cubierto por sys.objects (caso de baja probabilidad). Backfill de una sola vez ya aplicado:
          -- se documenta la limitacion en vez de rediseñar el mecanismo.
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
