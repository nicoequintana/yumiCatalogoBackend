BEGIN TRY

BEGIN TRAN;

-- AlterTable
ALTER TABLE [dbo].[Product] ADD [fraseComercial] NVARCHAR(1000),
[porQueLoVasAQuerer] NVARCHAR(max),
[tePasaEsto] NVARCHAR(max);

-- CreateTable
CREATE TABLE [dbo].[ProductoLista] (
    [id] INT NOT NULL IDENTITY(1,1),
    [tipo] VARCHAR(20) NOT NULL,
    [texto] NVARCHAR(1000) NOT NULL,
    [orden] INT NOT NULL CONSTRAINT [ProductoLista_orden_df] DEFAULT 0,
    [productId] INT NOT NULL,
    CONSTRAINT [ProductoLista_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[Especificacion] (
    [id] INT NOT NULL IDENTITY(1,1),
    [nombre] NVARCHAR(200) NOT NULL,
    [valor] NVARCHAR(500) NOT NULL,
    [orden] INT NOT NULL CONSTRAINT [Especificacion_orden_df] DEFAULT 0,
    [productId] INT NOT NULL,
    CONSTRAINT [Especificacion_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateIndex
CREATE NONCLUSTERED INDEX [ProductoLista_productId_tipo_idx] ON [dbo].[ProductoLista]([productId], [tipo]);

-- AddForeignKey
ALTER TABLE [dbo].[ProductoLista] ADD CONSTRAINT [ProductoLista_productId_fkey] FOREIGN KEY ([productId]) REFERENCES [dbo].[Product]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[Especificacion] ADD CONSTRAINT [Especificacion_productId_fkey] FOREIGN KEY ([productId]) REFERENCES [dbo].[Product]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT TRAN;

END TRY
BEGIN CATCH

IF @@TRANCOUNT > 0
BEGIN
    ROLLBACK TRAN;
END;
THROW

END CATCH
