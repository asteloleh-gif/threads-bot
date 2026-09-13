const { assertSocialProvider } = require("./socialProvider");

function createProviderRegistry(initialProviders = []) {
  const byAccount = new Map();

  function register(provider) {
    const valid = assertSocialProvider(provider);
    if (byAccount.has(valid.accountKey)) {
      throw new Error(`Social provider already registered for ${valid.accountKey}`);
    }
    byAccount.set(valid.accountKey, valid);
    return valid;
  }

  function getForAccount(accountKey) {
    const provider = byAccount.get(String(accountKey || "").toLowerCase());
    if (!provider) throw new Error(`No social provider registered for ${accountKey || "missing account"}`);
    return provider;
  }

  function findForAccount(accountKey) {
    return byAccount.get(String(accountKey || "").toLowerCase()) || null;
  }

  function list() {
    return Array.from(byAccount.values());
  }

  for (const provider of initialProviders) register(provider);

  return { register, getForAccount, findForAccount, list };
}

module.exports = { createProviderRegistry };
