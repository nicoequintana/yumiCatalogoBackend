BEGIN TRY

BEGIN TRAN;

-- Promociones (Tanda 3): QUÉ productos tienen QUÉ descuento.
--
-- La separación es el eje del módulo: acá NO hay fechas. Una promoción sin
-- programación no se aplica a nadie, y la misma promoción puede programarse
-- muchas veces sin duplicarse.
--
-- CreateTable
CREATE TABLE [dbo].[Promocion] (
    [id] INT NOT NULL IDENTITY(1,1),
    [nombre] NVARCHAR(120) NOT NULL,
    [descripcion] NVARCHAR(1000),
    -- Administrativo: archivar una promo que ya no se usa sin perderla. NO
    -- tiene nada que ver con la vigencia temporal.
    [activa] BIT NOT NULL CONSTRAINT [Promocion_activa_df] DEFAULT 1,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [Promocion_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [updatedAt] DATETIME2 NOT NULL,
    CONSTRAINT [Promocion_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[PromocionItem] (
    [id] INT NOT NULL IDENTITY(1,1),
    [promocionId] INT NOT NULL,
    [productId] INT NOT NULL,
    -- Entero entre 5 y 50. Los límites viven en `lib/precioEfectivo.js`: la
    -- columna no los puede expresar y un CHECK acá sería una segunda
    -- definición que se desincroniza.
    [porcentaje] INT NOT NULL,
    -- La granularidad del conflicto. `false` = perdió para ESTE producto y no
    -- se reactiva sola cuando termina la ganadora.
    [habilitado] BIT NOT NULL CONSTRAINT [PromocionItem_habilitado_df] DEFAULT 1,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [PromocionItem_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [updatedAt] DATETIME2 NOT NULL,
    CONSTRAINT [PromocionItem_pkey] PRIMARY KEY CLUSTERED ([id]),
    -- Un producto no puede estar dos veces en la misma promoción: cuál de los
    -- dos porcentajes gana no tendría respuesta.
    CONSTRAINT [PromocionItem_promocionId_productId_key] UNIQUE NONCLUSTERED ([promocionId],[productId])
);

-- CreateTable
CREATE TABLE [dbo].[ProgramacionPromocion] (
    [id] INT NOT NULL IDENTITY(1,1),
    [promocionId] INT NOT NULL,
    -- Medianoche ARGENTINA de su día, con el fin inclusivo. Mismo criterio que
    -- `Campania.desde`/`hasta`.
    [desde] DATETIME2 NOT NULL,
    [hasta] DATETIME2 NOT NULL,
    [habilitada] BIT NOT NULL CONSTRAINT [ProgramacionPromocion_habilitada_df] DEFAULT 1,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [ProgramacionPromocion_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [updatedAt] DATETIME2 NOT NULL,
    CONSTRAINT [ProgramacionPromocion_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
-- Promoción DENTRO de una campaña: la vigencia la hereda de la campaña. De acá
-- sale que apagar una campaña apague TODAS sus promociones de una.
CREATE TABLE [dbo].[CampaniaPromocion] (
    [campaniaId] INT NOT NULL,
    [promocionId] INT NOT NULL,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [CampaniaPromocion_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [CampaniaPromocion_pkey] PRIMARY KEY CLUSTERED ([campaniaId],[promocionId])
);

-- CreateIndex
-- La resolución del precio entra por productId, no por promoción: es la
-- consulta que corre en cada listado del catálogo.
CREATE NONCLUSTERED INDEX [PromocionItem_productId_idx] ON [dbo].[PromocionItem]([productId]);

-- CreateIndex
-- Exactamente la consulta de vigencia de una programación individual.
CREATE NONCLUSTERED INDEX [ProgramacionPromocion_habilitada_desde_hasta_idx] ON [dbo].[ProgramacionPromocion]([habilitada], [desde], [hasta]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [CampaniaPromocion_promocionId_idx] ON [dbo].[CampaniaPromocion]([promocionId]);

-- AddForeignKey
ALTER TABLE [dbo].[PromocionItem] ADD CONSTRAINT [PromocionItem_promocionId_fkey] FOREIGN KEY ([promocionId]) REFERENCES [dbo].[Promocion]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
-- Borrar un producto se lleva sus líneas de promoción. Es DISTINTO de
-- `ItemOrden`, que usa SetNull porque una venta pasada tiene que sobrevivir al
-- producto: una promoción sobre un producto que ya no existe no significa nada.
ALTER TABLE [dbo].[PromocionItem] ADD CONSTRAINT [PromocionItem_productId_fkey] FOREIGN KEY ([productId]) REFERENCES [dbo].[Product]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[ProgramacionPromocion] ADD CONSTRAINT [ProgramacionPromocion_promocionId_fkey] FOREIGN KEY ([promocionId]) REFERENCES [dbo].[Promocion]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[CampaniaPromocion] ADD CONSTRAINT [CampaniaPromocion_campaniaId_fkey] FOREIGN KEY ([campaniaId]) REFERENCES [dbo].[Campania]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
-- Las dos FK de esta tabla son CASCADE y SQL Server lo acepta: su restricción
-- es sobre múltiples caminos de cascada desde un MISMO origen, y acá los dos
-- padres —`Campania` y `Promocion`— son raíces sin relación entre sí. Borrar
-- cualquiera de las dos se lleva la asociación, que es lo correcto: una
-- asociación a algo que ya no existe no significa nada.
ALTER TABLE [dbo].[CampaniaPromocion] ADD CONSTRAINT [CampaniaPromocion_promocionId_fkey] FOREIGN KEY ([promocionId]) REFERENCES [dbo].[Promocion]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable
-- Lo que el producto valía SIN promoción, y el porcentaje aplicado.
-- `precioUnitario` sigue guardando lo que el cliente PAGÓ. Estas dos existen
-- para poder contestar "¿cuánta plata regalé en la campaña?": sin ellas ese
-- dato no queda en ningún lado, porque el precio de lista puede cambiar.
--
-- Nullable, y el null significa "esta línea no tuvo descuento" — la verdad para
-- todo el histórico. NO significa "descuento cero", que no puede existir: el
-- mínimo es 5 %.
ALTER TABLE [dbo].[ItemOrden] ADD
    [precioListaUnitario] DECIMAL(10,0),
    [descuentoPorcentaje] INT;

COMMIT TRAN;

END TRY
BEGIN CATCH

IF @@TRANCOUNT > 0
BEGIN
    ROLLBACK TRAN;
END;
THROW

END CATCH
