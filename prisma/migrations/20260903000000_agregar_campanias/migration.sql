BEGIN TRY

BEGIN TRAN;

-- Campania: el motor temporal del catálogo.
--
-- Hasta ahora YIMA no tenía ninguna noción de "cuándo": un producto estaba
-- publicado o no, y todo lo que cambiaba, cambiaba a mano y en el momento.
-- Esta tabla es lo que permite programar por adelantado una experiencia
-- comercial (Doodle, modal, CTA) con fecha de inicio y de fin.
--
-- NO lleva columna de estado temporal (PROGRAMADA/ACTIVA/FINALIZADA) a
-- propósito. Ese estado se deriva de `desde`/`hasta` en `src/lib/campanias.js`.
-- Persistirlo sería una columna que se desincroniza sola al pasar la
-- medianoche, sin ninguna escritura que la delate.
--
-- CreateTable
CREATE TABLE [dbo].[Campania] (
    [id] INT NOT NULL IDENTITY(1,1),
    [nombre] NVARCHAR(120) NOT NULL,
    [descripcion] NVARCHAR(1000),
    -- `tipo` y `estado` son VARCHAR y no enums porque SQL Server vía Prisma no
    -- los tiene. Los valores válidos los valida `src/lib/campanias.js`, igual
    -- que con `Orden.estado`.
    [tipo] VARCHAR(20) NOT NULL,
    [estado] VARCHAR(20) NOT NULL,
    -- Los dos extremos del período se guardan como la medianoche ARGENTINA de
    -- su día. El fin es INCLUSIVO, y esa extensión la resuelve el código: una
    -- campaña que termina el 20 vale hasta las 23:59:59 del 20 hora de Buenos
    -- Aires, que en UTC ya es el 21.
    [desde] DATETIME2 NOT NULL,
    [hasta] DATETIME2 NOT NULL,
    [prioridad] INT NOT NULL CONSTRAINT [Campania_prioridad_df] DEFAULT 0,
    -- Doodle: mismo trío de columnas que `Categoria.imagenUrl` y por el mismo
    -- motivo (poder borrar el archivo remoto al reemplazarlo o quitarlo).
    [doodleUrl] NVARCHAR(1000),
    [doodleCloudinaryPublicId] NVARCHAR(1000),
    [doodleCloudinaryResourceType] NVARCHAR(1000),
    [doodleEnCatalogo] BIT NOT NULL CONSTRAINT [Campania_doodleEnCatalogo_df] DEFAULT 1,
    [doodleEnAdmin] BIT NOT NULL CONSTRAINT [Campania_doodleEnAdmin_df] DEFAULT 0,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [Campania_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [updatedAt] DATETIME2 NOT NULL,
    CONSTRAINT [Campania_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateIndex
-- La consulta de vigencia es exactamente
-- `where estado = 'HABILITADA' and desde <= hoy and hasta >= hoy`, y corre en
-- cada carga de página del catálogo público (`GET /api/campanias/activas`).
CREATE NONCLUSTERED INDEX [Campania_estado_desde_hasta_idx] ON [dbo].[Campania]([estado], [desde], [hasta]);

-- Sin semilla, y eso es deliberado: una tabla vacía significa "no hay ninguna
-- campaña", y el sitio tiene que comportarse exactamente como antes de esta
-- migración —logo normal, sin modal, sin efectos—. Es lo contrario del caso de
-- `Anuncio`, donde la tabla vacía habría hecho desaparecer una cinta que el
-- código anterior ya mostraba.

COMMIT TRAN;

END TRY
BEGIN CATCH

IF @@TRANCOUNT > 0
BEGIN
    ROLLBACK TRAN;
END;
THROW

END CATCH
