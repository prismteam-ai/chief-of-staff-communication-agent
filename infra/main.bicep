// Chief of Communications — Azure infrastructure.
// Container App (single replica: background scheduler must not run twice),
// PostgreSQL Flexible Server, ACR pulled via managed identity.

@description('Base name for all resources')
param baseName string = 'chiefcomms'

param location string = resourceGroup().location

@description('Container image to run; placeholder until first ACR build')
param image string = 'mcr.microsoft.com/k8se/quickstart:latest'

@description('PostgreSQL admin password')
@secure()
param dbPassword string

@secure()
param authSecret string
@secure()
param tokenEncryptionKey string
@secure()
param entraClientSecret string
param entraClientId string
param entraIssuer string
param outlookClientId string
@secure()
param outlookClientSecret string
@secure()
param whatsappVerifyToken string = ''
@description('Public base URL; set after first deploy when FQDN is known')
param appBaseUrl string = ''

@description('MCP server container image')
param mcpImage string = 'mcr.microsoft.com/k8se/quickstart:latest'
@secure()
param mcpAuthToken string
@description('Email of the user the MCP server acts as')
param mcpUserEmail string = ''

var dbAdmin = 'chiefadmin'
var dbName = 'chief_of_comms'
var suffix = uniqueString(resourceGroup().id)

resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${baseName}-logs'
  location: location
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
  }
}

resource acr 'Microsoft.ContainerRegistry/registries@2023-11-01-preview' = {
  name: '${baseName}acr${suffix}'
  location: location
  sku: { name: 'Basic' }
  properties: {
    adminUserEnabled: false // pull via managed identity only
  }
}

resource pg 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: '${baseName}-pg-${suffix}'
  location: location
  sku: { name: 'Standard_B1ms', tier: 'Burstable' }
  properties: {
    version: '16'
    administratorLogin: dbAdmin
    administratorLoginPassword: dbPassword
    storage: { storageSizeGB: 32 }
    backup: { backupRetentionDays: 7, geoRedundantBackup: 'Disabled' }
    highAvailability: { mode: 'Disabled' }
  }
}

resource pgDb 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = {
  parent: pg
  name: dbName
}

// Container Apps have no stable outbound IPs on consumption; allow Azure-internal traffic.
resource pgFirewallAzure 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2024-08-01' = {
  parent: pg
  name: 'AllowAzureServices'
  properties: { startIpAddress: '0.0.0.0', endIpAddress: '0.0.0.0' }
}

resource env 'Microsoft.App/managedEnvironments@2024-10-02-preview' = {
  name: '${baseName}-env'
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logs.properties.customerId
        sharedKey: logs.listKeys().primarySharedKey
      }
    }
  }
}

var dbUrl = 'postgresql://${dbAdmin}:${uriComponent(dbPassword)}@${pg.properties.fullyQualifiedDomainName}:5432/${dbName}?sslmode=require'

resource app 'Microsoft.App/containerApps@2024-10-02-preview' = {
  name: '${baseName}-app'
  location: location
  identity: { type: 'SystemAssigned' }
  properties: {
    managedEnvironmentId: env.id
    configuration: {
      ingress: {
        external: true
        targetPort: 3000
        transport: 'auto'
      }
      registries: [
        {
          server: acr.properties.loginServer
          identity: 'system'
        }
      ]
      secrets: [
        { name: 'database-url', value: dbUrl }
        { name: 'auth-secret', value: authSecret }
        { name: 'token-encryption-key', value: tokenEncryptionKey }
        { name: 'entra-client-secret', value: entraClientSecret }
        { name: 'outlook-client-secret', value: outlookClientSecret }
        { name: 'whatsapp-verify-token', value: whatsappVerifyToken }
      ]
    }
    template: {
      containers: [
        {
          name: 'web'
          image: image
          resources: { cpu: json('0.5'), memory: '1Gi' }
          env: [
            { name: 'DATABASE_URL', secretRef: 'database-url' }
            { name: 'AUTH_SECRET', secretRef: 'auth-secret' }
            { name: 'TOKEN_ENCRYPTION_KEY', secretRef: 'token-encryption-key' }
            { name: 'AUTH_MICROSOFT_ENTRA_ID_SECRET', secretRef: 'entra-client-secret' }
            { name: 'OUTLOOK_CLIENT_SECRET', secretRef: 'outlook-client-secret' }
            { name: 'WHATSAPP_WEBHOOK_VERIFY_TOKEN', secretRef: 'whatsapp-verify-token' }
            { name: 'AUTH_MICROSOFT_ENTRA_ID_ID', value: entraClientId }
            { name: 'AUTH_MICROSOFT_ENTRA_ID_ISSUER', value: entraIssuer }
            { name: 'OUTLOOK_CLIENT_ID', value: outlookClientId }
            { name: 'AUTH_TRUST_HOST', value: 'true' }
            { name: 'APP_BASE_URL', value: appBaseUrl }
          ]
        }
      ]
      // Exactly one replica: in-process scheduler would double-send otherwise.
      scale: { minReplicas: 1, maxReplicas: 1 }
    }
  }
}

// AcrPull for the app's system identity
resource acrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(acr.id, app.id, 'acrpull')
  scope: acr
  properties: {
    principalId: app.identity.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      '7f951dda-4ed3-4680-a7ca-43fe172d538d'
    )
  }
}

// Remote MCP server (Streamable HTTP) — same codebase, mcp Docker stage.
resource mcpApp 'Microsoft.App/containerApps@2024-10-02-preview' = {
  name: '${baseName}-mcp'
  location: location
  identity: { type: 'SystemAssigned' }
  properties: {
    managedEnvironmentId: env.id
    configuration: {
      ingress: {
        external: true
        targetPort: 3001
        transport: 'auto'
      }
      registries: [
        {
          server: acr.properties.loginServer
          identity: 'system'
        }
      ]
      secrets: [
        { name: 'database-url', value: dbUrl }
        { name: 'token-encryption-key', value: tokenEncryptionKey }
        { name: 'outlook-client-secret', value: outlookClientSecret }
        { name: 'mcp-auth-token', value: mcpAuthToken }
      ]
    }
    template: {
      containers: [
        {
          name: 'mcp'
          image: mcpImage
          resources: { cpu: json('0.25'), memory: '0.5Gi' }
          env: [
            { name: 'DATABASE_URL', secretRef: 'database-url' }
            { name: 'TOKEN_ENCRYPTION_KEY', secretRef: 'token-encryption-key' }
            { name: 'OUTLOOK_CLIENT_SECRET', secretRef: 'outlook-client-secret' }
            { name: 'MCP_AUTH_TOKEN', secretRef: 'mcp-auth-token' }
            { name: 'OUTLOOK_CLIENT_ID', value: outlookClientId }
            { name: 'MCP_USER_EMAIL', value: mcpUserEmail }
            { name: 'APP_BASE_URL', value: appBaseUrl }
          ]
        }
      ]
      scale: { minReplicas: 1, maxReplicas: 1 }
    }
  }
}

resource acrPullMcp 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(acr.id, mcpApp.id, 'acrpull')
  scope: acr
  properties: {
    principalId: mcpApp.identity.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      '7f951dda-4ed3-4680-a7ca-43fe172d538d'
    )
  }
}

output appFqdn string = app.properties.configuration.ingress.fqdn
output mcpFqdn string = mcpApp.properties.configuration.ingress.fqdn
output acrLoginServer string = acr.properties.loginServer
output acrName string = acr.name
output pgHost string = pg.properties.fullyQualifiedDomainName
