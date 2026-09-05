BEGIN TRY

BEGIN TRAN;

-- El slide del carrusel de la home: arte propio y color de fondo.
--
-- Las cinco columnas son nullable o traen DEFAULT porque el Dockerfile corre
-- `prisma migrate deploy` en cada arranque: un NOT NULL sin default rompe el
-- despliegue sobre las filas que ya existen.
--
-- `bannerArte*` es un recurso SEPARADO del Doodle y con su propio trio de
-- columnas, mismo patron que `Categoria.imagenUrl`. Son dos piezas distintas:
-- el Doodle es cuadrado y reemplaza el logo, el arte del banner es apaisado
-- (2,9:1 en movil, 3,6:1 en escritorio) y llena el slide.
--
-- ⚠️ Hereda la trampa del Doodle: `duplicar` copia el `cloudinaryPublicId` POR
-- REFERENCIA, asi que dos campanias pueden apuntar al mismo archivo. El borrado
-- tiene que preguntar si alguien mas lo referencia antes de borrarlo.
--
-- `bannerColor` es nullable y NO trae default en la base: el default vive en
-- `lib/campanias.js` (COLOR_SLIDE_POR_DEFECTO) para que la lista de valores y
-- su default tengan una sola casa. Una campania sin color sale en terracota.
--
-- Sin indice nuevo: el slide se resuelve sobre las mismas filas que ya trae
-- `Campania_estado_desde_hasta_idx`.
--
-- AlterTable
ALTER TABLE [dbo].[Campania] ADD
    [bannerArteUrl] NVARCHAR(1000),
    [bannerArteCloudinaryPublicId] NVARCHAR(1000),
    [bannerArteCloudinaryResourceType] NVARCHAR(1000),
    [bannerColor] VARCHAR(20);

-- El icono de la categoria en los accesos circulares de la home.
--
-- Guarda el NOMBRE de un simbolo de Material Symbols (ej. "chair"), que el
-- proyecto ya usa en todos lados: sin dependencia nueva y sin archivo que
-- subir. Nullable a proposito: una categoria sin icono cae a su inicial, asi
-- que una categoria recien creada nunca rompe la fila.
--
-- No se usa `imagenUrl` para esto: a 56 px una foto de producto es un recorte
-- irreconocible. Los circulos de ML son iconos planos por lo mismo.
--
-- AlterTable
ALTER TABLE [dbo].[Categoria] ADD
    [icono] VARCHAR(40);

COMMIT TRAN;

END TRY
BEGIN CATCH

IF @@TRANCOUNT > 0
BEGIN
    ROLLBACK TRAN;
END;
THROW

END CATCH
