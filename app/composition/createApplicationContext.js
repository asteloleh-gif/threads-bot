const { loadPrimaryAccount, publicAccountView } = require("../accounts/accountConfig");
const { createProviderRegistry } = require("../providers/providerRegistry");
const { createThreadsProvider } = require("../providers/threadsProvider");
const { createInstagramProvider } = require("../providers/instagramProvider");

function createApplicationContext({ env = process.env, providerFactories = {} } = {}) {
  const primaryAccount = loadPrimaryAccount(env);
  const registry = createProviderRegistry();

  const factories = {
    threads: providerFactories.threads || createThreadsProvider,
    instagram: providerFactories.instagram || createInstagramProvider,
  };

  const factory = factories[primaryAccount.platform];
  if (!factory) throw new Error(`No provider factory for ${primaryAccount.platform}`);

  const primaryProvider = registry.register(factory({ account: primaryAccount }));

  function health() {
    return {
      primaryAccount: publicAccountView(primaryAccount),
      providers: registry.list().map(provider => provider.health()),
    };
  }

  return {
    accounts: Object.freeze([primaryAccount]),
    primaryAccount,
    primaryProvider,
    providers: registry,
    health,
  };
}

module.exports = { createApplicationContext };
