-- El banner de la home por promoción. Ocho columnas que espejan a Campania.
-- Todas nullable (o con default) para que la migración no toque las filas
-- existentes: una promoción vieja queda con bannerEnHome = 0 y sin banner,
-- que es exactamente el estado "no publica nada".
ALTER TABLE [dbo].[Promocion] ADD [bannerEnHome] BIT NOT NULL CONSTRAINT [Promocion_bannerEnHome_df] DEFAULT 0;
ALTER TABLE [dbo].[Promocion] ADD [bannerTitulo] NVARCHAR(120);
ALTER TABLE [dbo].[Promocion] ADD [bannerTexto] NVARCHAR(200);
ALTER TABLE [dbo].[Promocion] ADD [bannerCtaTexto] NVARCHAR(60);
ALTER TABLE [dbo].[Promocion] ADD [bannerColor] VARCHAR(20);
ALTER TABLE [dbo].[Promocion] ADD [bannerArteUrl] NVARCHAR(1000);
ALTER TABLE [dbo].[Promocion] ADD [bannerArteCloudinaryPublicId] NVARCHAR(1000);
ALTER TABLE [dbo].[Promocion] ADD [bannerArteCloudinaryResourceType] NVARCHAR(1000);
