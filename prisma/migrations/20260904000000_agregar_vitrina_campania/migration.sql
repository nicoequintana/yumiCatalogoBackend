BEGIN TRY

BEGIN TRAN;

-- Vitrina de campaña (Tanda 5): QUÉ productos muestra una campaña.
--
-- Es una pregunta que las promociones NO contestan. Una promoción define un
-- descuento; la vitrina define una selección. "Navidad" quiere exhibir todos
-- los productos navideños tengan o no rebaja, y con sólo `CampaniaPromocion` la
-- única forma de listarlos sería inventarles un descuento.
--
-- Asociación PURA: sin porcentaje, sin orden y sin flag propio. Lo que se sepa
-- del producto se lee del producto, y la vigencia se lee de la campaña.
--
-- CreateTable
CREATE TABLE [dbo].[CampaniaProducto] (
    [campaniaId] INT NOT NULL,
    [productId] INT NOT NULL,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [CampaniaProducto_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    -- PK compuesta y sin `id` propio, igual que `CampaniaPromocion`: la
    -- identidad de la fila ES el par, y de paso impide asociar dos veces el
    -- mismo producto a la misma campaña.
    CONSTRAINT [CampaniaProducto_pkey] PRIMARY KEY CLUSTERED ([campaniaId],[productId])
);

-- CreateIndex
-- La PK ya cubre la consulta por campaña (es su primera columna). Este índice
-- es para la contraria: "¿en qué campañas aparece este producto?".
CREATE NONCLUSTERED INDEX [CampaniaProducto_productId_idx] ON [dbo].[CampaniaProducto]([productId]);

-- AddForeignKey
-- Borrar la campaña se lleva su vitrina: una selección de una campaña que ya no
-- existe no significa nada.
ALTER TABLE [dbo].[CampaniaProducto] ADD CONSTRAINT [CampaniaProducto_campaniaId_fkey] FOREIGN KEY ([campaniaId]) REFERENCES [dbo].[Campania]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
-- Las dos FK son CASCADE y SQL Server lo acepta por lo mismo que en
-- `CampaniaPromocion`: su restricción es sobre múltiples caminos de cascada
-- desde un MISMO origen, y acá `Product` y `Campania` son dos raíces sin FK
-- entre sí.
--
-- Es también el motivo por el que `Campania.modalCtaReferenciaId` NO va a
-- llevar FK: un `ON DELETE SET NULL` desde `Product` hacia `Campania` abriría un
-- segundo camino `Product → Campania → CampaniaProducto`, y la creación de esta
-- tabla fallaría con el error 1785.
ALTER TABLE [dbo].[CampaniaProducto] ADD CONSTRAINT [CampaniaProducto_productId_fkey] FOREIGN KEY ([productId]) REFERENCES [dbo].[Product]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT TRAN;

END TRY
BEGIN CATCH

IF @@TRANCOUNT > 0
BEGIN
    ROLLBACK TRAN;
END;
THROW

END CATCH
