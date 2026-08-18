BEGIN TRY

BEGIN TRAN;

-- CreateTable
CREATE TABLE [dbo].[EventoTrafico] (
    [id] INT NOT NULL IDENTITY(1,1),
    [tipo] VARCHAR(30) NOT NULL,
    [productId] INT,
    [referrer] NVARCHAR(1000),
    [userAgent] NVARCHAR(1000),
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [EventoTrafico_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [EventoTrafico_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[ErrorLog] (
    [id] INT NOT NULL IDENTITY(1,1),
    [mensaje] NVARCHAR(max) NOT NULL,
    [stack] NVARCHAR(max),
    [ruta] NVARCHAR(1000),
    [metodo] NVARCHAR(1000),
    [status] INT,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [ErrorLog_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [ErrorLog_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateIndex
CREATE NONCLUSTERED INDEX [EventoTrafico_tipo_createdAt_idx] ON [dbo].[EventoTrafico]([tipo], [createdAt]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [EventoTrafico_productId_tipo_idx] ON [dbo].[EventoTrafico]([productId], [tipo]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [ErrorLog_createdAt_idx] ON [dbo].[ErrorLog]([createdAt]);

-- AddForeignKey
ALTER TABLE [dbo].[EventoTrafico] ADD CONSTRAINT [EventoTrafico_productId_fkey] FOREIGN KEY ([productId]) REFERENCES [dbo].[Product]([id]) ON DELETE SET NULL ON UPDATE CASCADE;

COMMIT TRAN;

END TRY
BEGIN CATCH

IF @@TRANCOUNT > 0
BEGIN
    ROLLBACK TRAN;
END;
THROW

END CATCH
