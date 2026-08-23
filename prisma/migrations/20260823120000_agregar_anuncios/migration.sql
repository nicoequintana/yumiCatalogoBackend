BEGIN TRY

BEGIN TRAN;

-- Anuncio: los mensajes de la cinta del catálogo público (`BarraAnuncios`).
--
-- Antes eran una constante en el bundle del frontend, así que cambiar el copy
-- exigía un deploy. Ahora se editan desde Configuración › Anuncios en el panel.
--
-- CreateTable
CREATE TABLE [dbo].[Anuncio] (
    [id] INT NOT NULL IDENTITY(1,1),
    [texto] NVARCHAR(200) NOT NULL,
    [activo] BIT NOT NULL CONSTRAINT [Anuncio_activo_df] DEFAULT 1,
    [orden] INT NOT NULL CONSTRAINT [Anuncio_orden_df] DEFAULT 0,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [Anuncio_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [updatedAt] DATETIME2 NOT NULL,
    CONSTRAINT [Anuncio_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateIndex
-- La consulta pública es exactamente `where activo = 1 order by orden`.
CREATE NONCLUSTERED INDEX [Anuncio_activo_orden_idx] ON [dbo].[Anuncio]([activo], [orden]);

-- Semilla con los tres mensajes que hasta ahora vivían hardcodeados en
-- `frontend/src/components/BarraAnuncios.jsx`.
--
-- **No es un extra: sin esto la cinta desaparece del sitio al deployar.** El
-- componente pasa a leer de la API y una tabla vacía significa "no hay nada que
-- anunciar", así que la migración tiene que dejar la base en el estado que el
-- código anterior ya mostraba. Que el panel después los edite o borre es
-- justamente el objetivo de la feature.
--
-- Va dentro de un EXEC por el mismo motivo que el backfill de
-- `20260823000000_agregar_stock_descontado_orden`: SQL Server compila el lote
-- entero antes de ejecutar la primera sentencia, y un INSERT que nombra una
-- tabla creada arriba en el mismo lote falla al parsearse con "Invalid object
-- name". `EXEC` difiere esa compilación hasta que el CREATE TABLE ya corrió.
EXEC('INSERT INTO [dbo].[Anuncio] ([texto], [activo], [orden], [updatedAt]) VALUES
  (''Encontrá productos que no sabías que necesitabas'', 1, 0, CURRENT_TIMESTAMP),
  (''Envíos a todo el país, coordinamos por WhatsApp'', 1, 1, CURRENT_TIMESTAMP),
  (''Selección chica y elegida a mano'', 1, 2, CURRENT_TIMESTAMP);');

COMMIT TRAN;

END TRY
BEGIN CATCH

IF @@TRANCOUNT > 0
BEGIN
    ROLLBACK TRAN;
END;
THROW

END CATCH
