let currentConversation = 'conv_0';
let conversations = {};
let isStreaming = false;
let currentTheme = 'dark';

function autoResize(textarea) {
  textarea.style.height = 'auto';
  textarea.style.height = Math.min(textarea.scrollHeight, 200) + 'px';
}

function handleKeyDown(event) {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    sendMessage();
  }
}

function toggleTool(btn, toolName) {
  btn.classList.toggle('active');
}

function toggleSidebar() {
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('sidebarOverlay');
  sidebar.classList.toggle('visible');
  overlay.classList.toggle('visible');
}

function toggleRightPanel() {
  const panel = document.getElementById('rightPanel');
  panel.classList.toggle('visible');
}

function cycleTheme() {
  const themes = ['dark', 'light', 'emerald'];
  const currentIndex = themes.indexOf(currentTheme);
  currentTheme = themes[(currentIndex + 1) % themes.length];
  
  document.body.className = '';
  document.body.classList.add(`theme-${currentTheme}`);
  
  const themeBtn = document.getElementById('themeBtn');
  const icons = ['🌙', '☀️', '💚'];
  themeBtn.querySelector('.btn-icon').textContent = icons[themes.indexOf(currentTheme)];
  
  localStorage.setItem('duan-theme', currentTheme);
}

function switchPanelTab(btn, tabName) {
  document.querySelectorAll('.panel-tabs .tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  
  document.querySelectorAll('.panel-section').forEach(s => s.style.display = 'none');
  document.getElementById(`panel-${tabName}`).style.display = 'block';
  
  if (tabName === 'tools') {
    loadTools();
  }
}

function newChat() {
  const convId = `conv_${Date.now()}`;
  currentConversation = convId;
  conversations[convId] = {
    id: convId,
    title: '新的对话',
    messages: [],
    createdAt: new Date().toISOString()
  };
  
  document.getElementById('welcome').style.display = 'none';
  document.getElementById('messageList').innerHTML = '';
  document.getElementById('chatTextarea').value = '';
  
  updateConversationList();
  scrollToBottom();
}

function filterConversations(query) {
  const items = document.querySelectorAll('.conv-item');
  items.forEach(item => {
    const title = item.querySelector('.conv-title').textContent.toLowerCase();
    item.style.display = title.includes(query.toLowerCase()) ? 'flex' : 'none';
  });
}

function updateConversationList() {
  const list = document.getElementById('convList');
  list.innerHTML = '';
  
  Object.values(conversations).forEach(conv => {
    const item = document.createElement('div');
    item.className = `conv-item ${conv.id === currentConversation ? 'active' : ''}`;
    item.innerHTML = `
      <div class="conv-avatar">💬</div>
      <div class="conv-content">
        <div class="conv-title">${conv.title}</div>
        <div class="conv-meta">${formatTime(conv.createdAt)} · ${conv.messages.length} 条消息</div>
      </div>
    `;
    item.onclick = () => switchConversation(conv.id);
    list.appendChild(item);
  });
}

function switchConversation(convId) {
  currentConversation = convId;
  const conv = conversations[convId];
  
  document.getElementById('welcome').style.display = 'none';
  const messageList = document.getElementById('messageList');
  messageList.innerHTML = '';
  
  conv.messages.forEach(msg => {
    addMessage(msg.role, msg.content);
  });
  
  updateConversationList();
  scrollToBottom();
}

function formatTime(dateStr) {
  const date = new Date(dateStr);
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
  return date.toLocaleDateString('zh-CN');
}

function addMessage(role, content, isStreaming = false) {
  const messageList = document.getElementById('messageList');
  const welcome = document.getElementById('welcome');
  
  if (welcome) welcome.style.display = 'none';
  
  const item = document.createElement('div');
  item.className = `message-item ${role}`;
  item.innerHTML = `
    <div class="message-avatar ${role}">${role === 'user' ? '👤' : '🧠'}</div>
    <div class="message-content">
      <div class="message-header">
        <span class="message-name">${role === 'user' ? '用户' : '段先生'}</span>
        <span class="message-time">${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</span>
      </div>
      <div class="message-bubble" id="${isStreaming ? 'streamingBubble' : ''}">${content}</div>
    </div>
  `;
  
  messageList.appendChild(item);
  return item;
}

function updateStreamingBubble(bubble, thinkText, fullText, cursor) {
  let content = '';
  if (thinkText) {
    content += `<span class="thinking">💭 ${thinkText}</span>`;
  }
  if (fullText) {
    content += `<br>${escapeHtml(fullText)}${cursor}`;
  }
  bubble.innerHTML = content;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

async function sendMessage() {
  const textarea = document.getElementById('chatTextarea');
  const message = textarea.value.trim();
  
  if (!message || isStreaming) return;
  
  isStreaming = true;
  textarea.value = '';
  textarea.style.height = 'auto';
  
  const sendBtn = document.getElementById('sendBtn');
  sendBtn.classList.add('loading');
  
  addMessage('user', message);
  scrollToBottom();
  
  if (!conversations[currentConversation]) {
    conversations[currentConversation] = {
      id: currentConversation,
      title: message.substring(0, 30) + (message.length > 30 ? '...' : ''),
      messages: [{ role: 'user', content: message }],
      createdAt: new Date().toISOString()
    };
    updateConversationList();
  } else {
    conversations[currentConversation].messages.push({ role: 'user', content: message });
  }
  
  try {
    await sendStreamMessage(message);
  } catch (error) {
    console.error('发送消息失败:', error);
    addMessage('assistant', `⚠️ 发送失败: ${error.message}`);
  } finally {
    isStreaming = false;
    sendBtn.classList.remove('loading');
    scrollToBottom();
  }
}

function sendQuickPrompt(prompt) {
  const textarea = document.getElementById('chatTextarea');
  textarea.value = prompt;
  autoResize(textarea);
  sendMessage();
}

async function sendStreamMessage(message) {
  const history = conversations[currentConversation]?.messages || [];
  const contextMessages = history.slice(-10);
  
  const response = await fetch('/api/chat/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message,
      history: contextMessages,
      mode: 'chat'
    })
  });
  
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  }
  
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  
  let fullText = '';
  let thinkText = '';
  let bubble = null;
  
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    
    const chunk = decoder.decode(value);
    const lines = chunk.split('\n');
    
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const data = line.slice(6);
        if (data === '[DONE]') {
          if (bubble) {
            const finalContent = thinkText ? `<span class="thinking">💭 ${thinkText}</span><br>${escapeHtml(fullText)}` : escapeHtml(fullText);
            bubble.innerHTML = finalContent;
          }
          saveAssistantMessage(fullText);
          return;
        }
        
        try {
          const parsed = JSON.parse(data);
          
          if (parsed.type === 'think') {
            if (parsed.content && parsed.content !== '完成') {
              thinkText = parsed.content;
            }
          } else if (parsed.type === 'text') {
            fullText += parsed.content;
          } else if (parsed.type === 'tool_call') {
            thinkText = (parsed.toolName || '执行操作') + ': ' + (parsed.content || '');
            fullText += `<br><span class="tool-call">🔧 ${parsed.toolName || '工具'}: ${parsed.content || ''}</span>`;
          } else if (parsed.type === 'tool_result') {
            const resultContent = parsed.content || '';
            fullText += `<br><div class="tool-result">📊 ${resultContent}</div>`;
            thinkText = '';
          } else if (parsed.type === 'error') {
            fullText += `<br>⚠️ 错误: ${parsed.content}`;
          }
        } catch (e) {
          console.warn('解析失败:', e);
        }
        
        if (!bubble) {
          bubble = addMessage('assistant', '', true);
        } else {
          updateStreamingBubble(bubble.querySelector('.message-bubble'), thinkText, fullText, '<span class="streaming-cursor">|</span>');
        }
        
        scrollToBottom();
      }
    }
  }
  
  if (bubble) {
    const finalContent = thinkText ? `<span class="thinking">💭 ${thinkText}</span><br>${escapeHtml(fullText)}` : escapeHtml(fullText);
    bubble.innerHTML = finalContent;
  }
  saveAssistantMessage(fullText);
}

function saveAssistantMessage(content) {
  if (!conversations[currentConversation]) return;
  
  const cleanContent = content.replace(/<[^>]*>/g, '').trim();
  conversations[currentConversation].messages.push({ 
    role: 'assistant', 
    content: cleanContent 
  });
  
  if (conversations[currentConversation].messages.filter(m => m.role === 'user').length === 1) {
    conversations[currentConversation].title = cleanContent.substring(0, 30) + (cleanContent.length > 30 ? '...' : '');
    updateConversationList();
  }
}

function scrollToBottom() {
  const chatScroll = document.getElementById('chatScroll');
  setTimeout(() => {
    chatScroll.scrollTop = chatScroll.scrollHeight;
  }, 100);
}

function clearChat() {
  document.getElementById('messageList').innerHTML = '';
  document.getElementById('welcome').style.display = 'flex';
  conversations[currentConversation] = {
    id: currentConversation,
    title: '新的对话',
    messages: [],
    createdAt: new Date().toISOString()
  };
  updateConversationList();
}

function exportChat() {
  const conv = conversations[currentConversation];
  if (!conv || !conv.messages.length) {
    alert('没有可导出的对话');
    return;
  }
  
  const data = JSON.stringify(conv, null, 2);
  const blob = new Blob([data], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `duan-chat-${currentConversation}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function openSettings() {
  window.open('/config.html', '_blank');
}

async function loadSystemStatus() {
  try {
    const response = await fetch('/api/status');
    const status = await response.json();
    
    document.getElementById('statVersion').textContent = status.version || 'v19.0';
    document.getElementById('statMode').textContent = status.mode || '本地';
    document.getElementById('statSessions').textContent = status.sessions || '-';
    document.getElementById('statTools').textContent = status.tools || '-';
    
    if (status.energy) {
      document.getElementById('energyBar').style.width = `${status.energy}%`;
      document.getElementById('energyValue').textContent = `${status.energy}%`;
    }
    
    if (status.mood) {
      document.getElementById('moodValue').textContent = status.mood;
    }
    
    if (status.heartbeatCount) {
      document.getElementById('heartbeatCount').textContent = status.heartbeatCount;
    }
  } catch (error) {
    console.warn('加载系统状态失败:', error);
  }
}

async function loadTools() {
  try {
    const response = await fetch('/api/tools');
    const tools = await response.json();
    
    const list = document.getElementById('toolsList');
    list.innerHTML = '';
    
    tools.forEach(tool => {
      const item = document.createElement('div');
      item.className = 'tool-item';
      item.innerHTML = `
        <span class="tool-icon">🔧</span>
        <span class="tool-name">${tool.name}</span>
      `;
      list.appendChild(item);
    });
  } catch (error) {
    console.warn('加载工具列表失败:', error);
  }
}

function init() {
  const savedTheme = localStorage.getItem('duan-theme') || 'dark';
  currentTheme = savedTheme;
  document.body.classList.add(`theme-${currentTheme}`);
  
  const icons = ['🌙', '☀️', '💚'];
  const themes = ['dark', 'light', 'emerald'];
  const themeBtn = document.getElementById('themeBtn');
  themeBtn.querySelector('.btn-icon').textContent = icons[themes.indexOf(currentTheme)];
  
  loadSystemStatus();
  loadTools();
  
  setInterval(() => {
    loadSystemStatus();
  }, 10000);
}

document.addEventListener('DOMContentLoaded', init);