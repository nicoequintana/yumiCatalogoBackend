BEGIN TRY

BEGIN TRAN;

-- CreateTable
CREATE TABLE [dbo].[ConfiguracionHome] (
    [id] INT NOT NULL CONSTRAINT [ConfiguracionHome_id_df] DEFAULT 1,
    [productoIconoId] INT,
    [updatedAt] DATETIME2 NOT NULL,
    CONSTRAINT [ConfiguracionHome_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- Semilla de la fila única (id=1), sin producto ícono elegido todavía. Mismo
-- motivo que `20260913142301_agregar_configuracion_contacto`: sin esto la
-- tabla queda vacía hasta el primer `PUT /config/home`, y el primer `GET`
-- después de deployar haría un `findUnique` que igual tolera `null` — pero
-- sembrarla ahora deja la tabla en el mismo estado con el que se la piensa:
-- una fila, siempre.
--
-- `EXEC`, mismo motivo que `20260823120000_agregar_anuncios`: SQL Server
-- compila el lote entero antes de ejecutar la primera sentencia, y un INSERT
-- contra una tabla creada arriba en el mismo lote falla con "Invalid object
-- name" si no se difiere la compilación.
EXEC('INSERT INTO [dbo].[ConfiguracionHome] ([id], [updatedAt]) VALUES (1, CURRENT_TIMESTAMP);');

COMMIT TRAN;

END TRY
BEGIN CATCH

IF @@TRANCOUNT > 0
BEGIN
    ROLLBACK TRAN;
END;
THROW

END CATCH
