BEGIN TRY

BEGIN TRAN;

-- Etiquetas como entidad. Antes `Product.etiqueta` era un NVARCHAR(1000) de
-- texto libre y la lista "oficial" vivia hardcodeada en dos repos.
--
-- GUARDA PREVIA. Si algun valor actual no entra en NVARCHAR(40), la migracion
-- corta aca con un mensaje que lo dice, en vez de truncar. Truncar seria
-- perder dato sin aviso, que es exactamente lo que este proyecto no hace.
IF EXISTS (SELECT 1 FROM [dbo].[Product] WHERE LEN(LTRIM(RTRIM([etiqueta]))) > 40)
BEGIN
    THROW 51000, 'Hay etiquetas de mas de 40 caracteres. Acortalas antes de migrar.', 1;
END;

-- CreateTable
CREATE TABLE [dbo].[Etiqueta] (
    [id] INT NOT NULL IDENTITY(1,1),
    [nombre] NVARCHAR(40) NOT NULL,
    [color] VARCHAR(20),
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [Etiqueta_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [updatedAt] DATETIME2 NOT NULL,
    CONSTRAINT [Etiqueta_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [Etiqueta_nombre_key] UNIQUE NONCLUSTERED ([nombre])
);

-- Semilla 1: los valores que YA existen en el catalogo. La collation es
-- case-insensitive, asi que el DISTINCT ya colapsa "Nuevo"/"nuevo" en una sola
-- fila, que es justamente el objetivo.
--
-- Va dentro de EXEC porque SQL Server compila el lote entero antes de ejecutar
-- la primera sentencia, y un INSERT que nombra una tabla creada arriba en el
-- mismo lote falla al parsearse con "Invalid object name".
EXEC('INSERT INTO [dbo].[Etiqueta] ([nombre], [color], [updatedAt])
      SELECT DISTINCT LTRIM(RTRIM([etiqueta])), NULL, CURRENT_TIMESTAMP
      FROM [dbo].[Product]
      WHERE [etiqueta] IS NOT NULL AND LTRIM(RTRIM([etiqueta])) <> '''';');

-- Semilla 2: las cinco canonicas que hasta ahora vivian hardcodeadas en
-- `SeccionesFormulario.jsx` (SUGERENCIAS_ETIQUETA) y en
-- `plantillaProductos.js` (ETIQUETAS_SUGERIDAS). Solo las que no quedaron ya
-- insertadas arriba.
--
-- No es un extra: el formulario pasa de texto libre a <select>, y sobre una
-- base sin etiquetas cargadas el desplegable quedaria vacio el dia uno.
--
-- TODAS van con color NULL. Cero regresion visual: el chip sigue pintandose
-- exactamente como hoy hasta que alguien elija un color desde el panel.
EXEC('INSERT INTO [dbo].[Etiqueta] ([nombre], [color], [updatedAt])
      SELECT [nombre], NULL, CURRENT_TIMESTAMP
      FROM (VALUES (''Exclusivo''), (''Nuevo''), (''Best Seller''), (''Trending''), (''Popular'')) AS s([nombre])
      WHERE NOT EXISTS (SELECT 1 FROM [dbo].[Etiqueta] e WHERE e.[nombre] = s.[nombre]);');

-- AlterTable: la FK nueva.
ALTER TABLE [dbo].[Product] ADD [etiquetaId] INT;

-- Reconexion: cada producto apunta a la fila cuyo nombre normalizado coincide.
EXEC('UPDATE p
      SET p.[etiquetaId] = e.[id]
      FROM [dbo].[Product] p
      INNER JOIN [dbo].[Etiqueta] e ON e.[nombre] = LTRIM(RTRIM(p.[etiqueta]))
      WHERE p.[etiqueta] IS NOT NULL;');

-- AddForeignKey. NO_ACTION igual que Product -> Categoria: el borrado de una
-- etiqueta en uso ya se bloquea en el controller con un 400 que dice cuantos
-- productos la usan.
ALTER TABLE [dbo].[Product]
  ADD CONSTRAINT [Product_etiquetaId_fkey] FOREIGN KEY ([etiquetaId])
  REFERENCES [dbo].[Etiqueta]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- CreateIndex
CREATE NONCLUSTERED INDEX [Product_etiquetaId_idx] ON [dbo].[Product]([etiquetaId]);

-- DropColumn: recien ahora, con los datos ya reconectados.
ALTER TABLE [dbo].[Product] DROP COLUMN [etiqueta];

COMMIT TRAN;

END TRY
BEGIN CATCH

IF @@TRANCOUNT > 0
BEGIN
    ROLLBACK TRAN;
END;
THROW

END CATCH
