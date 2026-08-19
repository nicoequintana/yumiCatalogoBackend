BEGIN TRY

BEGIN TRAN;

-- AlterTable
ALTER TABLE [dbo].[Especificacion] ALTER COLUMN [nombre] NVARCHAR(1000) NOT NULL;
ALTER TABLE [dbo].[Especificacion] ALTER COLUMN [valor] NVARCHAR(1000) NOT NULL;

-- CreateTable
CREATE TABLE [dbo].[AuditLog] (
    [id] INT NOT NULL IDENTITY(1,1),
    [usuarioId] INT,
    [usuarioEmail] NVARCHAR(1000) NOT NULL,
    [accion] VARCHAR(50) NOT NULL,
    [entidad] VARCHAR(50) NOT NULL,
    [entidadId] INT,
    [detalle] NVARCHAR(max),
    [ruta] NVARCHAR(1000) NOT NULL,
    [metodo] VARCHAR(10) NOT NULL,
    [ip] NVARCHAR(1000),
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [AuditLog_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [AuditLog_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateIndex
CREATE NONCLUSTERED INDEX [AuditLog_createdAt_idx] ON [dbo].[AuditLog]([createdAt]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [AuditLog_entidad_createdAt_idx] ON [dbo].[AuditLog]([entidad], [createdAt]);

COMMIT TRAN;

END TRY
BEGIN CATCH

IF @@TRANCOUNT > 0
BEGIN
    ROLLBACK TRAN;
END;
THROW

END CATCH
