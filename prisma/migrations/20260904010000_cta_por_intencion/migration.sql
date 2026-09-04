BEGIN TRY

BEGIN TRAN;

-- El CTA del modal pasa a guardar la INTENCIÓN, no la ruta (Tanda 5, paso 2).
--
-- `modalCtaDestino` guardaba el CÓMO: una ruta escrita a mano y validada contra
-- una whitelist de regex sincronizada con `frontend/src/App.jsx`. Tenía tres
-- modos de falla mudos: la ruta de categoría no verificaba que la categoría
-- existiera ni sobrevivía a un rename, `/coleccion?etiqueta=x` pasaba la
-- validación aunque ninguna pantalla lee ese parámetro, y quien opera el panel
-- tenía que tipear una URL.
--
-- Ahora se guarda el QUÉ y la ruta la arma el backend al leer.
--
-- AlterTable
ALTER TABLE [dbo].[Campania] ADD
    -- CAMPANIA | CATALOGO | CATEGORIA | PRODUCTO — la lista ejecutable vive en
    -- `lib/campanias.js`, igual que las de `tipo` y `estado`.
    [modalCtaTipo] VARCHAR(20),
    -- SIN FK, y es deliberado: SQL Server trata `ON DELETE SET NULL` como una
    -- acción de cascada, así que una FK `Product -> Campania` abriría un segundo
    -- camino hasta `CampaniaProducto` y fallaría con el error 1785. El
    -- razonamiento completo está en
    -- `20260904000000_agregar_vitrina_campania/migration.sql`. Un id que quedó
    -- colgado se degrada en la LECTURA (`resolverDestinoCta` manda a /coleccion).
    [modalCtaReferenciaId] INT;

-- Backfill ANTES del DROP: al revés se perdería la única señal de qué campañas
-- tenían botón.
--
-- Va todo a CATALOGO —el destino más conservador— y no se intenta reconstruir la
-- intención original a partir de la ruta: adivinar la categoría de un slug sería
-- inventar un dato que nadie confirmó.
--
-- ⚠️ Esto es SOLO para la base de DESARROLLO. En producción la tabla `Campania`
-- todavía no existió nunca con datos: `20260903000000_agregar_campanias` y las
-- que le siguen no se publicaron (la última migración en `origin-backend/main`
-- es `20260902130000_agregar_permiso_borrado_usuario`), así que allá este UPDATE
-- corre sobre cero filas y no toca nada.
--
-- ⚠️ Va dentro de un `EXEC` y no suelto: Prisma manda el archivo entero como UN
-- batch, y SQL Server lo COMPILA completo antes de ejecutar una sola línea. Un
-- UPDATE suelto sobre `modalCtaTipo` falla en compilación con
-- "Invalid column name 'modalCtaTipo'" —la columna todavía no existe cuando el
-- parser la mira— aunque el ALTER de arriba la agregue. El `EXEC` difiere la
-- compilación hasta que le toca correr.
EXEC('UPDATE [dbo].[Campania] SET [modalCtaTipo] = ''CATALOGO'' WHERE [modalCtaDestino] IS NOT NULL;');

-- AlterTable
-- Ningún índice, default ni check constraint toca la columna (verificado contra
-- `sys.indexes`, `sys.default_constraints` y `sys.check_constraints`), así que
-- el DROP no necesita borrar nada antes.
ALTER TABLE [dbo].[Campania] DROP COLUMN [modalCtaDestino];

COMMIT TRAN;

END TRY
BEGIN CATCH

IF @@TRANCOUNT > 0
BEGIN
    ROLLBACK TRAN;
END;
THROW

END CATCH
