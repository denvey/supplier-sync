import { config } from "./config.js";
import { createRuntime } from "./integrations/cj/runtime.js";

const command = process.argv[2];

async function main() {
  const runtime = createRuntime();
  try {
    switch (command) {
      case "cj:auth:token": {
        if (!config.CJ_API_KEY) {
          throw new Error("CJ_API_KEY is required for pnpm cj:auth:token");
        }

        const result = await runtime.apiClient.getAccessTokenByApiKey(config.CJ_API_KEY);
        const account = await runtime.accountService.storeToken({
          accountId: config.CJ_ACCOUNT_ID,
          name: config.CJ_ACCOUNT_NAME,
          tokenData: result.envelope.data,
          registeredAt: config.CJ_REGISTERED_AT,
          qpsLimit: config.CJ_ACCOUNT_QPS_LIMIT
        });
        await runtime.usageLogger.logSuccess(account.id, result);
        printTokenResult("CJ token fetched", account.id, result.envelope.data);
        break;
      }
      case "cj:auth:refresh": {
        const existingAccount = config.CJ_REFRESH_TOKEN
          ? undefined
          : await runtime.accountService.getActiveAccount(config.CJ_ACCOUNT_ID);
        const refreshToken = config.CJ_REFRESH_TOKEN ?? existingAccount?.refreshToken;
        if (!refreshToken) {
          throw new Error("CJ_REFRESH_TOKEN is required, or the selected account must already have a refresh token");
        }

        const result = await runtime.apiClient.refreshAccessToken(refreshToken);
        const account = await runtime.accountService.storeToken({
          accountId: existingAccount?.id ?? config.CJ_ACCOUNT_ID,
          name: config.CJ_ACCOUNT_NAME,
          tokenData: result.envelope.data,
          registeredAt: config.CJ_REGISTERED_AT,
          qpsLimit: config.CJ_ACCOUNT_QPS_LIMIT
        });
        await runtime.usageLogger.logSuccess(account.id, result);
        printTokenResult("CJ token refreshed", account.id, result.envelope.data);
        break;
      }
      case "cj:sync:categories":
        await runtime.metadataSync.syncCategories(await ensureAccount(runtime));
        break;
      case "cj:sync:warehouses":
        await runtime.metadataSync.syncWarehouses(await ensureAccount(runtime));
        break;
      case "cj:sync:index":
        await runtime.productIndexer.run(await ensureAccount(runtime));
        break;
      case "cj:worker": {
        const account = await ensureAccount(runtime);
        await runtime.metadataSync.syncCategories(account);
        await runtime.metadataSync.syncWarehouses(account);
        await runtime.productIndexer.run(account);
        break;
      }
      default:
        throw new Error(`Unknown command: ${command ?? "(missing)"}`);
    }
  } finally {
    await runtime.close();
  }
}

async function ensureAccount(runtime: ReturnType<typeof createRuntime>) {
  return runtime.accountService.ensureDefaultAccount({
    accountId: config.CJ_ACCOUNT_ID,
    name: config.CJ_ACCOUNT_NAME,
    accessToken: config.CJ_ACCESS_TOKEN,
    refreshToken: config.CJ_REFRESH_TOKEN,
    registeredAt: config.CJ_REGISTERED_AT,
    qpsLimit: config.CJ_ACCOUNT_QPS_LIMIT
  });
}

function printTokenResult(message: string, accountId: string, data: {
  accessTokenExpiryDate: string;
  refreshTokenExpiryDate: string;
}) {
  console.log(`${message}: account_id=${accountId}`);
  console.log(`accessTokenExpiryDate=${data.accessTokenExpiryDate}`);
  console.log(`refreshTokenExpiryDate=${data.refreshTokenExpiryDate}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
