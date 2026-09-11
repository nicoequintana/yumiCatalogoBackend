BEGIN TRY

BEGIN TRAN;

-- AlterTable
ALTER TABLE [dbo].[Orden] ADD [cuentaClienteId] INT;

-- CreateTable
CREATE TABLE [dbo].[CuentaCliente] (
    [id] INT NOT NULL IDENTITY(1,1),
    [email] NVARCHAR(1000) NOT NULL,
    [passwordHash] NVARCHAR(1000),
    [origenRegistro] VARCHAR(20) NOT NULL,
    [emailVerificado] BIT NOT NULL CONSTRAINT [CuentaCliente_emailVerificado_df] DEFAULT 0,
    [tokenVersion] INT NOT NULL CONSTRAINT [CuentaCliente_tokenVersion_df] DEFAULT 0,
    [intentosFallidos] INT NOT NULL CONSTRAINT [CuentaCliente_intentosFallidos_df] DEFAULT 0,
    [bloqueadoHasta] DATETIME2,
    [nombre] NVARCHAR(1000),
    [telefono] NVARCHAR(1000),
    [dni] VARCHAR(8),
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [CuentaCliente_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [updatedAt] DATETIME2 NOT NULL,
    CONSTRAINT [CuentaCliente_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [CuentaCliente_email_key] UNIQUE NONCLUSTERED ([email])
);

-- CreateTable
CREATE TABLE [dbo].[IdentidadGoogle] (
    [cuentaClienteId] INT NOT NULL,
    [sub] NVARCHAR(1000) NOT NULL,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [IdentidadGoogle_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [IdentidadGoogle_cuentaClienteId_key] UNIQUE NONCLUSTERED ([cuentaClienteId]),
    CONSTRAINT [IdentidadGoogle_sub_key] UNIQUE NONCLUSTERED ([sub])
);

-- CreateTable
CREATE TABLE [dbo].[ClaveIdempotencia] (
    [cuentaClienteId] INT NOT NULL,
    [clave] VARCHAR(64) NOT NULL,
    [ordenId] INT NOT NULL,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [ClaveIdempotencia_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [ClaveIdempotencia_ordenId_key] UNIQUE NONCLUSTERED ([ordenId]),
    CONSTRAINT [ClaveIdempotencia_cuentaClienteId_clave_key] UNIQUE NONCLUSTERED ([cuentaClienteId],[clave])
);

-- CreateTable
CREATE TABLE [dbo].[DispositivoConocido] (
    [id] INT NOT NULL IDENTITY(1,1),
    [cuentaClienteId] INT NOT NULL,
    [tokenHash] VARCHAR(64) NOT NULL,
    [expiraEn] DATETIME2 NOT NULL,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [DispositivoConocido_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [DispositivoConocido_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [DispositivoConocido_tokenHash_key] UNIQUE NONCLUSTERED ([tokenHash])
);

-- CreateTable
CREATE TABLE [dbo].[TokenCuenta] (
    [id] INT NOT NULL IDENTITY(1,1),
    [cuentaClienteId] INT NOT NULL,
    [tipo] VARCHAR(20) NOT NULL,
    [tokenHash] VARCHAR(64) NOT NULL,
    [emailNuevo] NVARCHAR(1000),
    [intentos] INT NOT NULL CONSTRAINT [TokenCuenta_intentos_df] DEFAULT 0,
    [expiraEn] DATETIME2 NOT NULL,
    [usadoEn] DATETIME2,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [TokenCuenta_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [TokenCuenta_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [TokenCuenta_tokenHash_key] UNIQUE NONCLUSTERED ([tokenHash])
);

-- CreateIndex
CREATE NONCLUSTERED INDEX [CuentaCliente_dni_idx] ON [dbo].[CuentaCliente]([dni]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [CuentaCliente_emailVerificado_createdAt_idx] ON [dbo].[CuentaCliente]([emailVerificado], [createdAt]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [DispositivoConocido_cuentaClienteId_idx] ON [dbo].[DispositivoConocido]([cuentaClienteId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [DispositivoConocido_expiraEn_idx] ON [dbo].[DispositivoConocido]([expiraEn]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [TokenCuenta_cuentaClienteId_tipo_idx] ON [dbo].[TokenCuenta]([cuentaClienteId], [tipo]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [TokenCuenta_expiraEn_idx] ON [dbo].[TokenCuenta]([expiraEn]);

-- AddForeignKey
ALTER TABLE [dbo].[IdentidadGoogle] ADD CONSTRAINT [IdentidadGoogle_cuentaClienteId_fkey] FOREIGN KEY ([cuentaClienteId]) REFERENCES [dbo].[CuentaCliente]([id]) ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[ClaveIdempotencia] ADD CONSTRAINT [ClaveIdempotencia_cuentaClienteId_fkey] FOREIGN KEY ([cuentaClienteId]) REFERENCES [dbo].[CuentaCliente]([id]) ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[ClaveIdempotencia] ADD CONSTRAINT [ClaveIdempotencia_ordenId_fkey] FOREIGN KEY ([ordenId]) REFERENCES [dbo].[Orden]([id]) ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[DispositivoConocido] ADD CONSTRAINT [DispositivoConocido_cuentaClienteId_fkey] FOREIGN KEY ([cuentaClienteId]) REFERENCES [dbo].[CuentaCliente]([id]) ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[TokenCuenta] ADD CONSTRAINT [TokenCuenta_cuentaClienteId_fkey] FOREIGN KEY ([cuentaClienteId]) REFERENCES [dbo].[CuentaCliente]([id]) ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[Orden] ADD CONSTRAINT [Orden_cuentaClienteId_fkey] FOREIGN KEY ([cuentaClienteId]) REFERENCES [dbo].[CuentaCliente]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

COMMIT TRAN;

END TRY
BEGIN CATCH

IF @@TRANCOUNT > 0
BEGIN
    ROLLBACK TRAN;
END;
THROW

END CATCH
