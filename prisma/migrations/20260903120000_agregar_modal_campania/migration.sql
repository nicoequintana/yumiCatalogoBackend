BEGIN TRY

BEGIN TRAN;

-- Modal estacional de campaña (Tanda 2).
--
-- Seis columnas sobre `Campania`, TODAS nullable o con default: el Dockerfile
-- corre `prisma migrate deploy` en cada arranque, así que una columna NOT NULL
-- sin default rompería el despliegue sobre las filas que ya existen.
--
-- `modalActivo` arranca en 0 a propósito: las campañas ya cargadas no pueden
-- empezar a mostrarle un cartel a nadie por el solo hecho de aplicar esta
-- migración. El modal es una interrupción; se prende a mano.
--
-- AlterTable
ALTER TABLE [dbo].[Campania] ADD
    [modalActivo] BIT NOT NULL CONSTRAINT [Campania_modalActivo_df] DEFAULT 0,
    [modalTitulo] NVARCHAR(120),
    [modalTexto] NVARCHAR(1000),
    [modalCtaTexto] NVARCHAR(60),
    -- Ruta interna del sitio. La valida el controller contra las rutas reales:
    -- un destino roto en un cartel que ve todo el mundo es peor que no tener
    -- cartel.
    [modalCtaDestino] NVARCHAR(200),
    -- El día al que apunta el contador. SEPARADO de `hasta`: la campaña de
    -- Navidad corre del 25/11 al 25/12 y cuenta hacia el 25/12; que a veces
    -- coincidan no los vuelve el mismo dato.
    [modalFechaObjetivo] DATETIME2;

-- Sin índice nuevo: el modal se resuelve sobre las MISMAS filas que ya trae la
-- consulta de vigencia (`Campania_estado_desde_hasta_idx`), no con una consulta
-- aparte. Un índice sobre `modalActivo` sería una tabla más que mantener para
-- una lectura que no existe.

COMMIT TRAN;

END TRY
BEGIN CATCH

IF @@TRANCOUNT > 0
BEGIN
    ROLLBACK TRAN;
END;
THROW

END CATCH
