// 新会话和复用会话都选择配置中的原生提供方，避免遗留会话留在旧代理。
export function isNativeConversationProvider(provider) {
  return ['our-free-model', 'our-free-model-region'].includes(provider);
}

export function nativeConversationModel(config = {}) {
  if (!isNativeConversationProvider(config.provider)) return null;
  if (!String(config.model || '').trim()) throw new Error('Our Free Model 对话模型未配置');
  return { provider: config.provider, model: String(config.model).trim(),
    ...(config.reasoningEffort ? { reasoningEffort: config.reasoningEffort } : {}) };
}

export function createSessionModelGuard({ readConfig, selectModel, log = () => {} }) {
  const selected = new Map();
  return async (sessionId) => {
    const model = nativeConversationModel(readConfig());
    if (!model) return;
    const key = JSON.stringify(model);
    if (selected.get(sessionId) === key) return;
    await selectModel({ sessionId, ...model });
    selected.set(sessionId, key);
    log('[dsh] conversation route', `${model.provider}/${model.model}`);
  };
}
