BEGIN TRY

BEGIN TRAN;

-- CreateTable
CREATE TABLE [dbo].[Cliente] (
    [id] INT NOT NULL IDENTITY(1,1),
    [dni] NVARCHAR(1000) NOT NULL,
    [nombre] NVARCHAR(1000) NOT NULL,
    [telefono] NVARCHAR(1000) NOT NULL,
    [email] NVARCHAR(1000),
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [Cliente_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [updatedAt] DATETIME2 NOT NULL,
    CONSTRAINT [Cliente_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [Cliente_dni_key] UNIQUE NONCLUSTERED ([dni])
);

-- CreateTable
CREATE TABLE [dbo].[Orden] (
    [id] INT NOT NULL IDENTITY(1,1),
    [clienteId] INT NOT NULL,
    [estado] VARCHAR(20) NOT NULL CONSTRAINT [Orden_estado_df] DEFAULT 'PENDIENTE',
    [notas] NVARCHAR(max),
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [Orden_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [updatedAt] DATETIME2 NOT NULL,
    CONSTRAINT [Orden_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[ItemOrden] (
    [id] INT NOT NULL IDENTITY(1,1),
    [ordenId] INT NOT NULL,
    [productId] INT NOT NULL,
    [nombreProducto] NVARCHAR(1000) NOT NULL,
    [precioUnitario] DECIMAL(10,2) NOT NULL,
    [cantidad] INT NOT NULL,
    CONSTRAINT [ItemOrden_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateIndex
CREATE NONCLUSTERED INDEX [Orden_clienteId_idx] ON [dbo].[Orden]([clienteId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [Orden_estado_createdAt_idx] ON [dbo].[Orden]([estado], [createdAt]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [ItemOrden_ordenId_idx] ON [dbo].[ItemOrden]([ordenId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [ItemOrden_productId_idx] ON [dbo].[ItemOrden]([productId]);

-- AddForeignKey
ALTER TABLE [dbo].[Orden] ADD CONSTRAINT [Orden_clienteId_fkey] FOREIGN KEY ([clienteId]) REFERENCES [dbo].[Cliente]([id]) ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[ItemOrden] ADD CONSTRAINT [ItemOrden_ordenId_fkey] FOREIGN KEY ([ordenId]) REFERENCES [dbo].[Orden]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[ItemOrden] ADD CONSTRAINT [ItemOrden_productId_fkey] FOREIGN KEY ([productId]) REFERENCES [dbo].[Product]([id]) ON DELETE NO ACTION ON UPDATE CASCADE;

COMMIT TRAN;

END TRY
BEGIN CATCH

IF @@TRANCOUNT > 0
BEGIN
    ROLLBACK TRAN;
END;
THROW

END CATCH
