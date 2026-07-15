# Azure Deployment Guide

Everything runs on Azure: App Service (app), Azure Database for PostgreSQL
Flexible Server (data), Key Vault (secrets), Managed Identity (access).

## 1. Resource group

```bash
az group create --name rg-chief-of-comms --location eastus2
```

## 2. Azure Database for PostgreSQL Flexible Server

```bash
az postgres flexible-server create \
  --resource-group rg-chief-of-comms \
  --name pg-chief-of-comms \
  --sku-name Standard_B1ms --tier Burstable \
  --version 16 \
  --database-name chief_of_comms \
  --admin-user cocadmin
```

Set `DATABASE_URL` to the connection string it prints (require SSL):

```
postgresql://cocadmin:<password>@pg-chief-of-comms.postgres.database.azure.com:5432/chief_of_comms?sslmode=require
```

Run migrations from CI or locally against it:

```bash
DATABASE_URL="<azure url>" npx prisma migrate deploy
```

## 3. Key Vault (token-encryption key + secrets)

```bash
az keyvault create --resource-group rg-chief-of-comms --name kv-chief-of-comms
az keyvault secret set --vault-name kv-chief-of-comms \
  --name token-encryption-key --value "$(openssl rand -base64 32)"
```

## 4. App Service

```bash
az appservice plan create --resource-group rg-chief-of-comms \
  --name plan-chief-of-comms --sku B1 --is-linux
az webapp create --resource-group rg-chief-of-comms \
  --plan plan-chief-of-comms --name chief-of-comms \
  --runtime "NODE:20-lts"
```

### Managed Identity → Key Vault

```bash
az webapp identity assign --resource-group rg-chief-of-comms --name chief-of-comms
az keyvault set-policy --name kv-chief-of-comms \
  --object-id <principalId from previous command> \
  --secret-permissions get
```

### App settings

```bash
az webapp config appsettings set --resource-group rg-chief-of-comms --name chief-of-comms --settings \
  APP_BASE_URL=https://chief-of-comms.azurewebsites.net \
  DATABASE_URL="<azure postgres url>" \
  AUTH_SECRET="<openssl rand -base64 32>" \
  AUTH_TRUST_HOST=true \
  AZURE_KEY_VAULT_URL=https://kv-chief-of-comms.vault.azure.net \
  TOKEN_ENCRYPTION_KEY_SECRET_NAME=token-encryption-key \
  AUTH_GOOGLE_ID=... AUTH_GOOGLE_SECRET=... \
  AUTH_MICROSOFT_ENTRA_ID_ID=... AUTH_MICROSOFT_ENTRA_ID_SECRET=... \
  AUTH_MICROSOFT_ENTRA_ID_ISSUER=https://login.microsoftonline.com/common/v2.0 \
  GMAIL_CLIENT_ID=... GMAIL_CLIENT_SECRET=... \
  OUTLOOK_CLIENT_ID=... OUTLOOK_CLIENT_SECRET=... \
  LINKEDIN_CLIENT_ID=... LINKEDIN_CLIENT_SECRET=... \
  X_CLIENT_ID=... X_CLIENT_SECRET=...
```

> Consider Key Vault references (`@Microsoft.KeyVault(SecretUri=...)`) for all
> provider secrets instead of plain app settings.

### Deploy

```bash
npm run build
az webapp deploy --resource-group rg-chief-of-comms --name chief-of-comms --src-path <zip>
```

## 5. Update every provider redirect URI

After deploying, add the production redirect URIs (replace localhost) in each
provider console — see [provider-setup.md](provider-setup.md).
