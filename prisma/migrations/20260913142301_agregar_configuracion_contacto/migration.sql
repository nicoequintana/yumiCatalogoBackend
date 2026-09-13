BEGIN TRY

BEGIN TRAN;

-- CreateTable
CREATE TABLE [dbo].[ConfiguracionContacto] (
    [id] INT NOT NULL CONSTRAINT [ConfiguracionContacto_id_df] DEFAULT 1,
    [whatsappNumero] VARCHAR(20),
    [whatsappHoraDesde] INT,
    [whatsappHoraHasta] INT,
    [whatsappDias] VARCHAR(20),
    [email] NVARCHAR(255),
    [instagramUrl] NVARCHAR(300),
    [facebookUrl] NVARCHAR(300),
    [tiktokUrl] NVARCHAR(300),
    [direccion] NVARCHAR(300),
    [updatedAt] DATETIME2 NOT NULL,
    CONSTRAINT [ConfiguracionContacto_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- Semilla de la fila única (id=1), todo NULL. Sin esto, `prisma.upsert` la
-- crearía igual en el primer `PUT /config/contacto`, pero el primer `GET`
-- después de deployar haría un `findUnique` que vuelve `null` — el
-- controller lo tolera (fallback a env), pero sembrarla ahora deja la tabla
-- en el mismo estado con el que se la piensa: una fila, siempre.
--
-- `EXEC`, mismo motivo que `20260823120000_agregar_anuncios`: SQL Server
-- compila el lote entero antes de ejecutar la primera sentencia, y un INSERT
-- contra una tabla creada arriba en el mismo lote falla con "Invalid object
-- name" si no se difiere la compilación.
EXEC('INSERT INTO [dbo].[ConfiguracionContacto] ([id], [updatedAt]) VALUES (1, CURRENT_TIMESTAMP);');

COMMIT TRAN;

END TRY
BEGIN CATCH

IF @@TRANCOUNT > 0
BEGIN
    ROLLBACK TRAN;
END;
THROW

END CATCH
