const PROVIDER_MODELS = {
  openai: [
    { id: 'gpt-4o', name: 'GPT-4o' },
    { id: 'gpt-4o-mini', name: 'GPT-4o Mini' },
    { id: 'gpt-4-turbo', name: 'GPT-4 Turbo' },
    { id: 'o1-mini', name: 'O1 Mini' },
    { id: 'o3-mini', name: 'O3 Mini' },
  ],
  anthropic: [
    { id: 'claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet' },
    { id: 'claude-3-opus-20240229', name: 'Claude 3 Opus' },
    { id: 'claude-3-haiku-20240307', name: 'Claude 3 Haiku' },
    { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4' },
  ],
  deepseek: [
    { id: 'deepseek-chat', name: 'DeepSeek Chat' },
    { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' },
  ],
  gemini: [
    { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
    { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
    { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash' },
  ],
  groq: [
    { id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B' },
    { id: 'llama-3.1-8b-instant', name: 'Llama 3.1 8B' },
    { id: 'mixtral-8x7b-32768', name: 'Mixtral 8x7B' },
    { id: 'gemma2-9b-it', name: 'Gemma 2 9B' },
  ],
  openrouter: [
    { id: 'meta-llama/llama-3.3-70b-instruct:free', name: 'Llama 3.3 70B (免费)' },
    { id: 'deepseek/deepseek-chat:free', name: 'DeepSeek Chat (免费)' },
    { id: 'deepseek/deepseek-r1:free', name: 'DeepSeek R1 (免费)' },
    { id: 'microsoft/phi-4:free', name: 'Phi-4 (免费)' },
    { id: 'google/gemini-2.5-flash-preview', name: 'Gemini 2.5 Flash (免费)' },
    { id: 'openai/gpt-4o-mini', name: 'GPT-4o Mini' },
    { id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet' },
  ],
  qwen: [
    { id: 'qwen-max', name: 'Qwen Max' },
    { id: 'qwen-plus', name: 'Qwen Plus' },
    { id: 'qwen-turbo', name: 'Qwen Turbo' },
    { id: 'qwq-32b', name: 'QwQ 32B' },
  ],
  zhipu: [
    { id: 'glm-5.2', name: 'GLM-5.2' },
    { id: 'glm-5.1', name: 'GLM-5.1' },
    { id: 'glm-4-plus', name: 'GLM-4 Plus' },
    { id: 'glm-4-flash', name: 'GLM-4 Flash (免费)' },
    { id: 'glm-4-air', name: 'GLM-4 Air' },
    { id: 'glm-4v-flash', name: 'GLM-4V Flash' },
  ],
  doubao: [
    { id: 'ep-doubao-pro', name: '豆包 Pro' },
    { id: 'ep-doubao-lite', name: '豆包 Lite' },
  ],
  coding_plan: [
    { id: 'ark-code-latest', name: 'Auto（控制台切换）', desc: '方舟控制台智能调度（推荐）' },
    { id: 'doubao-seed-2.0-code', name: 'Doubao Seed 2.0 Code', desc: '编程旗舰' },
    { id: 'doubao-seed-2.0-pro', name: 'Doubao Seed 2.0 Pro', desc: '通用旗舰' },
    { id: 'doubao-seed-2.0-lite', name: 'Doubao Seed 2.0 Lite', desc: '轻量快速' },
    { id: 'doubao-seed-code', name: 'Doubao Seed Code', desc: '编程模型' },
    { id: 'doubao-seed-2.0-mini', name: 'Doubao Seed 2.0 Mini', desc: '轻量模型' },
    { id: 'glm-5.1', name: 'GLM 5.1', desc: '智谱模型' },
    { id: 'glm-5.2', name: 'GLM 5.2', desc: '智谱最新模型' },
    { id: 'glm-4.7', name: 'GLM 4.7', desc: '智谱模型' },
    { id: 'deepseek-v3.2', name: 'DeepSeek V3.2', desc: 'DeepSeek模型' },
    { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', desc: 'DeepSeek模型' },
    { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', desc: 'DeepSeek模型' },
    { id: 'kimi-k2.5', name: 'Kimi K2.5', desc: '月之暗面模型' },
    { id: 'kimi-k2.6', name: 'Kimi K2.6', desc: '月之暗面模型' },
    { id: 'minimax-m2.7', name: 'MiniMax M2.7', desc: 'MiniMax模型' },
    { id: 'minimax-m3', name: 'MiniMax M3', desc: 'MiniMax模型' },
  ],
  ernie: [
    { id: 'ernie-4.0-8k-latest', name: '文心一言 4.0' },
    { id: 'ernie-3.5-8k', name: '文心一言 3.5' },
  ],
  mistral: [
    { id: 'mistral-small-latest', name: 'Mistral Small' },
    { id: 'mistral-large-latest', name: 'Mistral Large' },
  ],
  siliconflow: [
    { id: 'deepseek-ai/DeepSeek-V3', name: 'DeepSeek V3' },
    { id: 'deepseek-ai/DeepSeek-R1', name: 'DeepSeek R1' },
    { id: 'Qwen/Qwen2.5-72B-Instruct', name: 'Qwen 2.5 72B' },
  ],
  together: [
    { id: 'meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo', name: 'Llama 3.1 70B' },
  ],
  fireworks: [
    { id: 'accounts/fireworks/models/llama-v3p1-70b-instruct', name: 'Llama 3.1 70B' },
  ],
  perplexity: [
    { id: 'sonar-pro', name: 'Sonar Pro' },
    { id: 'sonar', name: 'Sonar' },
  ],
  xai: [
    { id: 'grok-2', name: 'Grok 2' },
  ],
  moonshot: [
    { id: 'moonshot-v1-8k', name: 'Moonshot 8K' },
    { id: 'moonshot-v1-32k', name: 'Moonshot 32K' },
    { id: 'moonshot-v1-128k', name: 'Moonshot 128K' },
  ],
  minimax: [
    { id: 'MiniMax-Text-01', name: 'MiniMax Text' },
  ],
  cohere: [
    { id: 'command-r-plus', name: 'Command R+' },
  ],
  agnes: [
    { id: 'agnes-2.0-flash', name: 'Agnes 2.0 Flash' },
  ],
  ollama: [
    { id: 'llama3', name: 'Llama 3' },
    { id: 'llama3:70b', name: 'Llama 3 70B' },
    { id: 'qwen2:7b', name: 'Qwen 2 7B' },
    { id: 'gemma2:9b', name: 'Gemma 2 9B' },
  ],
  custom: [
    { id: '__custom__', name: '自定义模型' },
  ],
};

const PROVIDER_INFO = {
  openai: { label: 'OpenAI', icon: '🤖', baseURL: 'https://api.openai.com/v1' },
  anthropic: { label: 'Anthropic Claude', icon: '🦉', baseURL: '' },
  deepseek: { label: 'DeepSeek', icon: '🔍', baseURL: 'https://api.deepseek.com/v1' },
  gemini: { label: 'Google Gemini', icon: '🌐', baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai' },
  groq: { label: 'Groq', icon: '⚡', baseURL: 'https://api.groq.com/openai/v1' },
  openrouter: { label: 'OpenRouter', icon: '🔗', baseURL: 'https://openrouter.ai/api/v1' },
  qwen: { label: '阿里通义千问', icon: '🐼', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  zhipu: { label: '智谱 GLM', icon: '🧠', baseURL: 'https://open.bigmodel.cn/api/paas/v4' },
  doubao: { label: '字节豆包', icon: '🟣', baseURL: 'https://ark.cn-beijing.volces.com/api/v3' },
  coding_plan: { label: '火山引擎 Coding Plan', icon: '💻', baseURL: 'https://ark.cn-beijing.volces.com/api/coding/v3' },
  ernie: { label: '百度文心', icon: '🔵', baseURL: 'https://aip.baidubce.com/rpc/2.0/ai_custom/v1/wenxinworkshop' },
  mistral: { label: 'Mistral AI', icon: '🌫️', baseURL: 'https://api.mistral.ai/v1' },
  siliconflow: { label: 'SiliconFlow', icon: '🔬', baseURL: 'https://api.siliconflow.cn/v1' },
  together: { label: 'Together AI', icon: '🧩', baseURL: 'https://api.together.xyz/v1' },
  fireworks: { label: 'Fireworks AI', icon: '🎆', baseURL: 'https://api.fireworks.ai/inference/v1' },
  perplexity: { label: 'Perplexity', icon: '🔍', baseURL: 'https://api.perplexity.ai' },
  xai: { label: 'xAI (Grok)', icon: '👽', baseURL: 'https://api.x.ai/v1' },
  moonshot: { label: '月之暗面 Kimi', icon: '🌙', baseURL: 'https://api.moonshot.cn/v1' },
  minimax: { label: 'MiniMax', icon: '🎯', baseURL: 'https://api.minimax.chat/v1' },
  cohere: { label: 'Cohere', icon: '📊', baseURL: 'https://api.cohere.ai/v2' },
  agnes: { label: 'Agnes AI', icon: '✨', baseURL: 'https://apihub.agnes-ai.com/v1' },
  ollama: { label: 'Ollama', icon: '🖥️', baseURL: 'http://localhost:11434/v1' },
  custom: { label: '自定义 API', icon: '⚙️', baseURL: '' },
};

let currentConfig = {
  providers: [],
  channels: {},
  settings: {
    defaultProvider: '',
    defaultModel: '',
    autoSaveMemory: true,
    multiAgentMode: true,
    smartDetection: true,
    temperature: 0.7,
    maxTokens: 4096,
    httpProxy: '',
    httpsProxy: '',
    timeout: 60,
    retryCount: 3,
  },
};

let confirmCallback = null;

document.addEventListener('DOMContentLoaded', async () => {
  initTabs();
  initProviderSelect();
  await loadConfig();
  initEventListeners();
});

function initTabs() {
  document.querySelectorAll('.nav-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const tabName = tab.dataset.tab;
      switchTab(tabName);
    });
  });
}

function switchTab(tabName) {
  document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
  document.querySelector(`.nav-tab[data-tab="${tabName}"]`).classList.add('active');
  
  document.querySelectorAll('.tab-content').forEach(c => c.classList.add('hidden'));
  document.getElementById(`${tabName}-tab`).classList.remove('hidden');
  
  const titles = {
    providers: { title: 'AI 提供商配置', desc: '管理您的 AI 模型提供商和 API 密钥' },
    channels: { title: '移动通道配置', desc: '配置多平台移动端交互通道' },
    settings: { title: '系统设置', desc: '配置智能体行为和推理参数' },
  };
  document.getElementById('page-title').textContent = titles[tabName].title;
  document.getElementById('page-desc').textContent = titles[tabName].desc;
}

function initProviderSelect() {
  const select = document.getElementById('modal-provider');
  Object.entries(PROVIDER_INFO).forEach(([id, info]) => {
    const option = document.createElement('option');
    option.value = id;
    option.textContent = `${info.icon} ${info.label}`;
    select.appendChild(option);
  });
  
  select.addEventListener('change', (e) => {
    updateModelSelect(e.target.value);
    updateModalHint(e.target.value);
  });
}

function updateModelSelect(providerId) {
  const select = document.getElementById('modal-model');
  select.innerHTML = '<option value="">请选择模型</option>';
  
  if (!providerId || !PROVIDER_MODELS[providerId]) return;
  
  PROVIDER_MODELS[providerId].forEach(model => {
    const option = document.createElement('option');
    option.value = model.id;
    option.textContent = model.name + (model.desc ? ` — ${model.desc}` : '');
    select.appendChild(option);
  });
  
  const customUrlDiv = document.getElementById('modal-custom-url');
  if (providerId === 'custom') {
    customUrlDiv.classList.remove('hidden');
  } else {
    customUrlDiv.classList.add('hidden');
  }
}

function updateModalHint(providerId) {
  const hint = document.getElementById('modal-key-hint');
  const codingHint = document.getElementById('modal-coding-plan-hint');
  
  if (providerId === 'coding_plan') {
    hint.textContent = '接入密钥格式: ark-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx';
    codingHint.classList.remove('hidden');
  } else if (providerId === 'doubao') {
    hint.textContent = '接入密钥格式: ark-xxx，模型使用接入点ID (ep-xxx)';
    codingHint.classList.add('hidden');
  } else {
    hint.textContent = '在提供商控制台获取 API Key';
    codingHint.classList.add('hidden');
  }
}

async function loadConfig() {
  try {
    const response = await fetch('/api/config');
    const config = await response.json();
    await loadDuanConfig();
    renderProviders();
    renderChannels();
    renderSettings();
  } catch (error) {
    console.warn('加载配置失败:', error);
    await loadDuanConfig();
    renderProviders();
    renderChannels();
    renderSettings();
  }
}

async function loadDuanConfig() {
  try {
    const response = await fetch('/api/duan/config');
    if (response.ok) {
      const data = await response.json();
      if (data.profiles) {
        currentConfig.providers = data.profiles.map(p => ({
          id: p.id,
          provider: p.provider,
          label: p.label,
          apiKey: p.apiKey,
          model: p.model,
          baseURL: p.baseURL,
          isDefault: p.id === data.defaultProfileId,
        }));
      }
      if (data.mobileChannels) {
        data.mobileChannels.forEach(ch => {
          currentConfig.channels[ch.type] = ch.config;
        });
      }
    }
  } catch {
    console.warn('加载 Duan 配置失败');
  }
}

function renderProviders() {
  const container = document.getElementById('providers-list');
  
  if (currentConfig.providers.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📭</div>
        <h3>暂无配置的提供商</h3>
        <p>点击上方按钮或使用快捷卡片添加</p>
      </div>
    `;
    return;
  }
  
  container.innerHTML = currentConfig.providers.map(p => {
    const info = PROVIDER_INFO[p.provider] || PROVIDER_INFO.custom;
    return `
      <div class="provider-card ${p.isDefault ? 'default' : ''}" data-id="${p.id}">
        <div class="provider-header">
          <div class="provider-icon" style="background: ${info.color || '#333'}20;">${info.icon}</div>
          <div class="provider-info">
            <h3>${p.label || info.label}</h3>
            <p>${info.label}</p>
          </div>
          <span class="provider-status online">已配置</span>
        </div>
        <div class="provider-details">
          <div class="provider-detail">
            <label>模型</label>
            <value>${p.model}</value>
          </div>
          <div class="provider-detail">
            <label>API 地址</label>
            <value style="font-size: 11px;">${p.baseURL || info.baseURL || '-'}</value>
          </div>
        </div>
        <div class="provider-actions">
          <button class="btn btn-secondary" onclick="setDefaultProvider('${p.id}')">
            ${p.isDefault ? '默认' : '设为默认'}
          </button>
          <button class="btn btn-outline" onclick="testProvider('${p.id}')">测试</button>
          <button class="btn btn-outline" onclick="deleteProvider('${p.id}')">删除</button>
        </div>
      </div>
    `;
  }).join('');
  
  updateDefaultProviderSelect();
}

function updateDefaultProviderSelect() {
  const select = document.getElementById('default-provider');
  select.innerHTML = '<option value="">请选择</option>';
  
  currentConfig.providers.forEach(p => {
    const info = PROVIDER_INFO[p.provider] || PROVIDER_INFO.custom;
    const option = document.createElement('option');
    option.value = p.id;
    option.textContent = `${info.icon} ${p.label || info.label} — ${p.model}`;
    option.dataset.provider = p.provider;
    option.dataset.model = p.model;
    select.appendChild(option);
  });
  
  select.addEventListener('change', (e) => {
    const selected = e.target.options[e.target.selectedIndex];
    if (selected) {
      const modelSelect = document.getElementById('default-model');
      modelSelect.innerHTML = '<option value="">请选择</option>';
      const providerId = selected.dataset.provider;
      if (PROVIDER_MODELS[providerId]) {
        PROVIDER_MODELS[providerId].forEach(m => {
          const opt = document.createElement('option');
          opt.value = m.id;
          opt.textContent = m.name;
          if (m.id === selected.dataset.model) opt.selected = true;
          modelSelect.appendChild(opt);
        });
      }
    }
  });
  
  const defaultProvider = currentConfig.providers.find(p => p.isDefault);
  if (defaultProvider) {
    select.value = defaultProvider.id;
    select.dispatchEvent(new Event('change'));
  }
}

function renderChannels() {
  document.querySelectorAll('.channel-card').forEach(card => {
    const channel = card.dataset.channel;
    const toggle = card.querySelector('.toggle-input');
    const configs = card.querySelectorAll('.config-input');
    
    if (currentConfig.channels[channel]) {
      toggle.checked = true;
      configs.forEach(input => {
        const field = input.dataset.field;
        if (currentConfig.channels[channel][field]) {
          input.value = currentConfig.channels[channel][field];
        }
      });
    }
    
    toggle.addEventListener('change', () => {
      if (!toggle.checked) {
        configs.forEach(input => input.value = '');
      }
    });
  });
}

function renderSettings() {
  document.getElementById('setting-auto-save').checked = currentConfig.settings.autoSaveMemory !== false;
  document.getElementById('setting-multi-agent').checked = currentConfig.settings.multiAgentMode !== false;
  document.getElementById('setting-smart-detection').checked = currentConfig.settings.smartDetection !== false;
  document.getElementById('setting-temperature').value = currentConfig.settings.temperature || 0.7;
  document.getElementById('temp-value').textContent = currentConfig.settings.temperature || 0.7;
  document.getElementById('setting-max-tokens').value = currentConfig.settings.maxTokens || 4096;
  document.getElementById('setting-http-proxy').value = currentConfig.settings.httpProxy || '';
  document.getElementById('setting-https-proxy').value = currentConfig.settings.httpsProxy || '';
  document.getElementById('setting-timeout').value = currentConfig.settings.timeout || 60;
  document.getElementById('setting-retry').value = currentConfig.settings.retryCount || 3;
}

function initEventListeners() {
  document.getElementById('setting-temperature').addEventListener('input', (e) => {
    document.getElementById('temp-value').textContent = e.target.value;
  });
}

function openAddModal(providerId = '') {
  const modal = document.getElementById('add-provider-modal');
  modal.classList.remove('hidden');
  
  if (providerId) {
    document.getElementById('modal-provider').value = providerId;
    updateModelSelect(providerId);
    updateModalHint(providerId);
  } else {
    document.getElementById('modal-provider').value = '';
    document.getElementById('modal-model').innerHTML = '<option value="">请选择模型</option>';
    document.getElementById('modal-api-key').value = '';
    document.getElementById('modal-base-url').value = '';
    document.getElementById('modal-coding-plan-hint').classList.add('hidden');
  }
}

function closeAddModal() {
  document.getElementById('add-provider-modal').classList.add('hidden');
}

async function addProvider() {
  const providerId = document.getElementById('modal-provider').value;
  const apiKey = document.getElementById('modal-api-key').value;
  const model = document.getElementById('modal-model').value;
  const baseURL = document.getElementById('modal-base-url').value;
  
  if (!providerId) {
    showToast('请选择提供商', 'error');
    return;
  }
  if (!apiKey || apiKey.length < 8) {
    showToast('请输入有效的 API Key', 'error');
    return;
  }
  if (!model) {
    showToast('请选择模型', 'error');
    return;
  }
  
  const info = PROVIDER_INFO[providerId];
  const profile = {
    id: `${providerId}:${Date.now()}`,
    provider: providerId,
    label: info.label,
    apiKey,
    model,
    baseURL: baseURL || info.baseURL || '',
    isDefault: currentConfig.providers.length === 0,
  };
  
  try {
    const response = await fetch('/api/duan/config/profiles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(profile),
    });
    
    if (response.ok) {
      showToast(`已添加 ${info.label}`, 'success');
      currentConfig.providers.push(profile);
      renderProviders();
      closeAddModal();
    } else {
      const error = await response.json();
      showToast(error.message || '添加失败', 'error');
    }
  } catch (error) {
    showToast('添加失败: ' + error.message, 'error');
  }
}

async function setDefaultProvider(profileId) {
  try {
    const response = await fetch(`/api/duan/config/default/${profileId}`, {
      method: 'POST',
    });
    
    if (response.ok) {
      currentConfig.providers.forEach(p => p.isDefault = p.id === profileId);
      renderProviders();
      showToast('已设为默认提供商', 'success');
    } else {
      showToast('设置失败', 'error');
    }
  } catch (error) {
    showToast('设置失败: ' + error.message, 'error');
  }
}

async function testProvider(profileId) {
  const profile = currentConfig.providers.find(p => p.id === profileId);
  if (!profile) return;
  
  const card = document.querySelector(`.provider-card[data-id="${profileId}"]`);
  const status = card.querySelector('.provider-status');
  status.textContent = '测试中...';
  status.classList.remove('online', 'offline');
  status.classList.add('testing');
  
  try {
    const response = await fetch('/api/duan/config/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        baseURL: profile.baseURL || PROVIDER_INFO[profile.provider]?.baseURL || '',
        model: profile.model,
        apiKey: profile.apiKey,
        label: profile.label,
      }),
    });
    
    const result = await response.json();
    
    if (result.success) {
      status.textContent = '在线';
      status.classList.remove('testing');
      status.classList.add('online');
      showToast(`${profile.label} 测试通过`, 'success');
    } else {
      status.textContent = '异常';
      status.classList.remove('testing');
      status.classList.add('offline');
      showToast(`${profile.label} 测试失败: ${result.message}`, 'error');
    }
  } catch (error) {
    status.textContent = '异常';
    status.classList.remove('testing');
    status.classList.add('offline');
    showToast('测试失败: ' + error.message, 'error');
  }
}

async function testAllProviders() {
  showToast('正在测试所有提供商...', 'warning');
  for (const p of currentConfig.providers) {
    await testProvider(p.id);
    await new Promise(r => setTimeout(r, 500));
  }
}

function deleteProvider(profileId) {
  const profile = currentConfig.providers.find(p => p.id === profileId);
  openConfirmModal(`确定要删除 ${profile?.label || '此提供商'} 吗？`, async () => {
    try {
      const response = await fetch(`/api/duan/config/profiles/${profileId}`, {
        method: 'DELETE',
      });
      
      if (response.ok) {
        currentConfig.providers = currentConfig.providers.filter(p => p.id !== profileId);
        renderProviders();
        showToast('已删除', 'success');
      } else {
        showToast('删除失败', 'error');
      }
    } catch (error) {
      showToast('删除失败: ' + error.message, 'error');
    }
    closeConfirmModal();
  });
}

async function saveAllConfig() {
  const channels = {};
  document.querySelectorAll('.channel-card').forEach(card => {
    const channel = card.dataset.channel;
    const toggle = card.querySelector('.toggle-input');
    if (toggle.checked) {
      const config = {};
      card.querySelectorAll('.config-input').forEach(input => {
        const field = input.dataset.field;
        if (input.value) {
          config[field] = input.value;
        }
      });
      if (Object.keys(config).length > 0) {
        channels[channel] = config;
      }
    }
  });
  
  const settings = {
    defaultProvider: document.getElementById('default-provider').value,
    defaultModel: document.getElementById('default-model').value,
    autoSaveMemory: document.getElementById('setting-auto-save').checked,
    multiAgentMode: document.getElementById('setting-multi-agent').checked,
    smartDetection: document.getElementById('setting-smart-detection').checked,
    temperature: parseFloat(document.getElementById('setting-temperature').value),
    maxTokens: parseInt(document.getElementById('setting-max-tokens').value),
    httpProxy: document.getElementById('setting-http-proxy').value,
    httpsProxy: document.getElementById('setting-https-proxy').value,
    timeout: parseInt(document.getElementById('setting-timeout').value),
    retryCount: parseInt(document.getElementById('setting-retry').value),
  };
  
  currentConfig.channels = channels;
  currentConfig.settings = settings;
  
  try {
    await Promise.all([
      fetch('/api/duan/config/channels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(channels),
      }),
      fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          defaultModel: settings.defaultModel,
          defaultProvider: settings.defaultProvider,
          settings: {
            autoSaveMemory: settings.autoSaveMemory,
            multiAgentMode: settings.multiAgentMode,
            smartDetection: settings.smartDetection,
          },
        }),
      }),
    ]);
    
    showToast('配置已保存', 'success');
  } catch (error) {
    showToast('保存失败: ' + error.message, 'error');
  }
}

function resetAllConfig() {
  openConfirmModal('确定要重置所有配置吗？此操作不可恢复。', async () => {
    try {
      const response = await fetch('/api/duan/config/reset', {
        method: 'POST',
      });
      
      if (response.ok) {
        currentConfig = {
          providers: [],
          channels: {},
          settings: {
            defaultProvider: '',
            defaultModel: '',
            autoSaveMemory: true,
            multiAgentMode: true,
            smartDetection: true,
            temperature: 0.7,
            maxTokens: 4096,
            httpProxy: '',
            httpsProxy: '',
            timeout: 60,
            retryCount: 3,
          },
        };
        renderProviders();
        renderChannels();
        renderSettings();
        showToast('已重置配置', 'success');
      } else {
        showToast('重置失败', 'error');
      }
    } catch (error) {
      showToast('重置失败: ' + error.message, 'error');
    }
    closeConfirmModal();
  });
}

function openConfirmModal(message, callback) {
  document.getElementById('confirm-message').textContent = message;
  confirmCallback = callback;
  document.getElementById('confirm-modal').classList.remove('hidden');
}

function closeConfirmModal() {
  document.getElementById('confirm-modal').classList.add('hidden');
  confirmCallback = null;
}

document.getElementById('confirm-btn').addEventListener('click', () => {
  if (confirmCallback) {
    confirmCallback();
  }
});

function showToast(message, type = 'success') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  
  const icons = { success: '✅', error: '❌', warning: '⚠️' };
  toast.innerHTML = `
    <span class="toast-icon">${icons[type]}</span>
    <span class="toast-message">${message}</span>
  `;
  
  container.appendChild(toast);
  
  setTimeout(() => {
    toast.style.animation = 'fadeOut 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}