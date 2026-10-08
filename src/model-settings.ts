import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';

const modelKey = (model) => `${model.provider}/${model.id}`;

/** The file is the sole source of CodeWalk credentials and default selection.
 * Its key is applied as a Pi runtime override; it is never copied to auth.json
 * or returned to the browser. Existing Pi credentials work when no file exists.
 */
export class ModelSettingsService {
  constructor({
    configPath = process.env.CODEWALK_MODEL_CONFIG?.trim() || 'model-config.json',
    runtime,
    createRuntime = () => ModelRuntime.create(),
  } = {}) {
    this.configPath = path.resolve(configPath);
    this.runtimeValue = runtime;
    this.createRuntime = createRuntime;
    this.runtimePromise = null;
    this.config = null;
  }

  async loadConfig() {
    let content;
    try {
      content = await readFile(this.configPath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw new Error(`无法读取模型配置：${this.configPath}`);
    }
    let input;
    // JSON parse diagnostics can include the API key; expose only the location.
    try {
      input = JSON.parse(content);
    } catch {
      throw new Error(`模型配置不是有效的 JSON：${this.configPath}`);
    }
    if (!input || Array.isArray(input) || typeof input !== 'object')
      throw new Error('模型配置必须是 JSON 对象');
    for (const field of ['provider', 'apiKey']) {
      if (typeof input[field] !== 'string' || !input[field].trim())
        throw new Error(`模型配置缺少 ${field}`);
    }
    if (input.model != null && typeof input.model !== 'string')
      throw new Error('模型配置的 model 必须是字符串');
    if (input.apiKey.length > 20000) throw new Error('模型配置的 API Key 过长');
    const model = input.model?.trim();
    return {
      provider: input.provider.trim(),
      apiKey: input.apiKey.trim(),
      ...(model ? { model } : {}),
    };
  }

  async initialize() {
    const config = await this.loadConfig();
    const runtime = this.runtimeValue ?? (await this.createRuntime());
    if (config) {
      const provider = runtime.getProvider(config.provider);
      if (!provider?.auth.apiKey)
        throw new Error('模型配置的供应商不支持 API Key，请使用 Pi 的供应商 ID');
      try {
        await runtime.setRuntimeApiKey(config.provider, config.apiKey);
      } catch {
        throw new Error('模型凭据加载失败，请检查本机配置及模型缓存目录的权限');
      }
      const available = await runtime.getAvailable(config.provider);
      if (!available.length) throw new Error('当前供应商没有可用模型');
      const model = config.model
        ? available.find((item) => item.id === config.model)
        : available[0];
      if (!model) {
        throw new Error('默认模型在当前供应商配置下不可用');
      }
      this.config = { ...config, model: model.id };
    } else {
      this.config = null;
    }
    return runtime;
  }

  async runtime() {
    return (this.runtimePromise ??= this.initialize());
  }

  async availableModels() {
    const runtime = await this.runtime();
    return (await runtime.getAvailable(this.config?.provider))
      .map((model) => ({ id: modelKey(model), name: model.name }))
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  async describe() {
    const runtime = await this.runtime();
    return {
      configPath: this.configPath,
      providerId: this.config?.provider ?? null,
      providerName: this.config ? runtime.getProvider(this.config.provider)?.name : null,
      defaultModelId: this.config ? `${this.config.provider}/${this.config.model}` : null,
    };
  }
}
