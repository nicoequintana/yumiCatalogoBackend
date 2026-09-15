BEGIN TRY

BEGIN TRAN;

-- Combos: un conjunto de productos con descuento condicionado a comprar el
-- conjunto entero. El precio se deriva de los precios de LISTA (lib/combos.js).
--
-- CreateTable
CREATE TABLE [dbo].[Combo] (
    [id] INT NOT NULL IDENTITY(1,1),
    [nombre] NVARCHAR(120) NOT NULL,
    [frase] NVARCHAR(140) NOT NULL,
    [porcentaje] INT NOT NULL,
    [activo] BIT NOT NULL CONSTRAINT [Combo_activo_df] DEFAULT 0,
    [vigencia] VARCHAR(20) NOT NULL CONSTRAINT [Combo_vigencia_df] DEFAULT 'SIEMPRE',
    [heroUrl] NVARCHAR(1000),
    [heroCloudinaryPublicId] NVARCHAR(1000),
    [heroCloudinaryResourceType] NVARCHAR(1000),
    [vistas] INT NOT NULL CONSTRAINT [Combo_vistas_df] DEFAULT 0,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [Combo_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [updatedAt] DATETIME2 NOT NULL,
    CONSTRAINT [Combo_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[ComboItem] (
    [id] INT NOT NULL IDENTITY(1,1),
    [comboId] INT NOT NULL,
    [productId] INT NOT NULL,
    [cantidad] INT NOT NULL,
    CONSTRAINT [ComboItem_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [ComboItem_comboId_productId_key] UNIQUE NONCLUSTERED ([comboId],[productId])
);

-- CreateTable
CREATE TABLE [dbo].[CampaniaCombo] (
    [campaniaId] INT NOT NULL,
    [comboId] INT NOT NULL,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [CampaniaCombo_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [CampaniaCombo_pkey] PRIMARY KEY CLUSTERED ([campaniaId],[comboId])
);

-- CreateIndex
CREATE NONCLUSTERED INDEX [Combo_activo_vigencia_createdAt_idx] ON [dbo].[Combo]([activo], [vigencia], [createdAt]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [ComboItem_productId_idx] ON [dbo].[ComboItem]([productId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [CampaniaCombo_comboId_idx] ON [dbo].[CampaniaCombo]([comboId]);

-- AddForeignKey
ALTER TABLE [dbo].[ComboItem] ADD CONSTRAINT [ComboItem_comboId_fkey] FOREIGN KEY ([comboId]) REFERENCES [dbo].[Combo]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
-- NO ACTION: borrar un producto que está en un combo se bloquea desde el
-- controller (409, con el nombre del combo) ANTES de llegar acá. Mismo
-- criterio que `Product.etiqueta`.
ALTER TABLE [dbo].[ComboItem] ADD CONSTRAINT [ComboItem_productId_fkey] FOREIGN KEY ([productId]) REFERENCES [dbo].[Product]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[CampaniaCombo] ADD CONSTRAINT [CampaniaCombo_campaniaId_fkey] FOREIGN KEY ([campaniaId]) REFERENCES [dbo].[Campania]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
-- Las dos FK de esta tabla son CASCADE y SQL Server lo acepta: `Campania` y
-- `Combo` son dos raíces sin FK entre sí, mismo caso que `CampaniaPromocion`.
ALTER TABLE [dbo].[CampaniaCombo] ADD CONSTRAINT [CampaniaCombo_comboId_fkey] FOREIGN KEY ([comboId]) REFERENCES [dbo].[Combo]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable
-- Snapshots del combo en cada fila de ItemOrden. NULL = "esta línea no vino de
-- un combo" — el histórico entero queda así, y es la verdad para él.
ALTER TABLE [dbo].[ItemOrden] ADD
    [comboId] INT,
    [comboNombre] NVARCHAR(120),
    [comboCantidad] INT,
    [comboPorcentaje] INT;

-- CreateIndex
CREATE NONCLUSTERED INDEX [ItemOrden_comboId_idx] ON [dbo].[ItemOrden]([comboId]);

-- AlterTable
-- Sin FK, mismo criterio que campaniaId/promocionId: una FK abriría un
-- segundo camino de cascada desde Product y SQL Server la rechaza (error 1785).
ALTER TABLE [dbo].[EventoTrafico] ADD [comboId] INT;

COMMIT TRAN;

END TRY
BEGIN CATCH

IF @@TRANCOUNT > 0
BEGIN
    ROLLBACK TRAN;
END;
THROW

END CATCH
