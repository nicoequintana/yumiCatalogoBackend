BEGIN TRY

BEGIN TRAN;

-- CreateTable
CREATE TABLE [dbo].[Product] (
    [id] INT NOT NULL IDENTITY(1,1),
    [nombre] NVARCHAR(1000) NOT NULL,
    [descripcion] NVARCHAR(max) NOT NULL,
    [precio] DECIMAL(10,2) NOT NULL,
    [etiqueta] NVARCHAR(1000),
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [Product_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [updatedAt] DATETIME2 NOT NULL,
    CONSTRAINT [Product_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[Caracteristica] (
    [id] INT NOT NULL IDENTITY(1,1),
    [texto] NVARCHAR(1000) NOT NULL,
    [productId] INT NOT NULL,
    CONSTRAINT [Caracteristica_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[Foto] (
    [id] INT NOT NULL IDENTITY(1,1),
    [url] NVARCHAR(1000) NOT NULL,
    [driveFileId] NVARCHAR(1000),
    [orden] INT NOT NULL,
    [productId] INT NOT NULL,
    CONSTRAINT [Foto_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[Video] (
    [id] INT NOT NULL IDENTITY(1,1),
    [url] NVARCHAR(1000) NOT NULL,
    [driveFileId] NVARCHAR(1000),
    [productId] INT NOT NULL,
    CONSTRAINT [Video_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [Video_productId_key] UNIQUE NONCLUSTERED ([productId])
);

-- AddForeignKey
ALTER TABLE [dbo].[Caracteristica] ADD CONSTRAINT [Caracteristica_productId_fkey] FOREIGN KEY ([productId]) REFERENCES [dbo].[Product]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[Foto] ADD CONSTRAINT [Foto_productId_fkey] FOREIGN KEY ([productId]) REFERENCES [dbo].[Product]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[Video] ADD CONSTRAINT [Video_productId_fkey] FOREIGN KEY ([productId]) REFERENCES [dbo].[Product]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT TRAN;

END TRY
BEGIN CATCH

IF @@TRANCOUNT > 0
BEGIN
    ROLLBACK TRAN;
END;
THROW

END CATCH
