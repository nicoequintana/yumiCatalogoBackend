BEGIN TRY

BEGIN TRAN;

-- El banner de la home: la franja que sobrevive al cierre del cartel.
--
-- Las cuatro columnas son nullable o traen DEFAULT porque el Dockerfile corre
-- `prisma migrate deploy` en cada arranque: un NOT NULL sin default rompe el
-- despliegue sobre las filas que ya existen.
--
-- `bannerEnHome` arranca en 0 a propósito. Prender el banner es una decisión
-- por campaña, y ninguna de las que ya están cargadas la tomó: encenderlas
-- todas de golpe pondría una franja en la home sin que nadie la haya escrito.
--
-- Sin índice nuevo: el banner se resuelve sobre las mismas filas que ya trae
-- `Campania_estado_desde_hasta_idx`.
--
-- AlterTable
ALTER TABLE [dbo].[Campania] ADD
    [bannerEnHome] BIT NOT NULL CONSTRAINT [Campania_bannerEnHome_df] DEFAULT 0,
    [bannerTitulo] NVARCHAR(120),
    [bannerTexto] NVARCHAR(200),
    [bannerCtaTexto] NVARCHAR(60);

COMMIT TRAN;

END TRY
BEGIN CATCH

IF @@TRANCOUNT > 0
BEGIN
    ROLLBACK TRAN;
END;
THROW

END CATCH
