BEGIN TRY

BEGIN TRAN;

-- Categoría: foto propia + selección para la home.
--
-- La sección "Explorá por categoría" de la home elegía sus tres categorías
-- sola (las de más productos publicados) y sacaba las fotos de un mapa
-- estático en el bundle del frontend. Ese mapa se desincronizaba en silencio:
-- renombrar una categoría le cambiaba el slug y su foto desaparecía sin que
-- nadie del lado del panel pudiera enterarse. Ahora las dos cosas —qué
-- categorías y con qué foto— las decide una persona desde Configuración ›
-- Categorías.
--
-- AlterTable
ALTER TABLE [dbo].[Categoria] ADD
    [imagenUrl] NVARCHAR(1000),
    [imagenCloudinaryPublicId] NVARCHAR(1000),
    [imagenCloudinaryResourceType] NVARCHAR(1000),
    [destacadaEnHome] BIT NOT NULL CONSTRAINT [Categoria_destacadaEnHome_df] DEFAULT 0,
    [ordenHome] INT NOT NULL CONSTRAINT [Categoria_ordenHome_df] DEFAULT 0;

-- CreateIndex
-- La consulta pública es exactamente `where destacadaEnHome = 1 order by
-- ordenHome`, igual que la de `Anuncio`.
CREATE NONCLUSTERED INDEX [Categoria_destacadaEnHome_ordenHome_idx] ON [dbo].[Categoria]([destacadaEnHome], [ordenHome]);

-- SIN semilla, a diferencia de la migración de `Anuncio`.
--
-- Ahí la semilla era obligatoria: la cinta pasaba a leer de la base y sin
-- filas desaparecía del sitio. Acá el silencio es el comportamiento correcto —
-- la feature es "yo elijo qué se muestra", y arrancar con una selección que
-- nadie eligió contradice eso. La sección queda oculta hasta que alguien
-- marque categorías desde el panel, que es exactamente lo que se pidió.
--
-- Consecuencia asumida: al deployar, la home pierde esa sección hasta que se
-- configure. Es visible y esperado, no una regresión silenciosa.

COMMIT TRAN;

END TRY
BEGIN CATCH

IF @@TRANCOUNT > 0
BEGIN
    ROLLBACK TRAN;
END;
THROW

END CATCH
