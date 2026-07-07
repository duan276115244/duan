// V19 贾维斯增强：Web 端贾维斯模式（最小实现）
// 基于浏览器 webkitSpeechRecognition + speechSynthesis，无需后端依赖
// 复用 /api/chat/stream 流式接口获取段先生回复

(function () {
  try {
    var JARVIS_STORAGE_KEY = 'duan-jarvis-state';
    var isActive = false;
    var recognition = null;
    var autoSpeak = true;
    var continuous = true;
    var isProcessing = false;

    // 状态恢复
    try {
      var saved = localStorage.getItem(JARVIS_STORAGE_KEY);
      if (saved) {
        var state = JSON.parse(saved);
        autoSpeak = state.autoSpeak !== false;
        continuous = state.continuous !== false;
      }
    } catch (e) {}

    function saveState() {
      try {
        localStorage.setItem(JARVIS_STORAGE_KEY, JSON.stringify({ isActive: isActive, autoSpeak: autoSpeak, continuous: continuous }));
      } catch (e) {}
    }

    // 转义文本，防止注入
    function escapeText(text) {
      return String(text).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
      });
    }

    function setStatus(text) {
      try {
        var el = document.getElementById('jarvisStatus');
        if (el) el.textContent = text;
      } catch (e) {}
    }

    function appendTranscript(speaker, text) {
      try {
        var el = document.getElementById('jarvisTranscript');
        if (!el) return;
        var line = document.createElement('div');
        line.style.marginBottom = '4px';
        var name = speaker === 'user' ? '你' : '段先生';
        var color = speaker === 'user' ? '#06B6D4' : '#8B5CF6';
        line.innerHTML = '<strong style="color:' + color + '">' + name + ':</strong> ' + escapeText(text);
        el.appendChild(line);
        el.scrollTop = el.scrollHeight;
      } catch (e) {}
    }

    function speak(text) {
      try {
        if (!autoSpeak || !('speechSynthesis' in window)) return;
        var utterance = new SpeechSynthesisUtterance(text);
        utterance.lang = 'zh-CN';
        utterance.rate = 1.0;
        speechSynthesis.speak(utterance);
      } catch (e) {}
    }

    function startListening() {
      try {
        var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SR) {
          setStatus('浏览器不支持语音识别');
          return;
        }
        if (recognition) {
          try { recognition.stop(); } catch (e) {}
        }
        recognition = new SR();
        recognition.lang = 'zh-CN';
        // V19 流式 ASR：边说边转写，实时显示 interim 文本
        recognition.continuous = false;
        recognition.interimResults = true;
        recognition.maxAlternatives = 1;

        recognition.onresult = function (event) {
          try {
            var interim = '';
            var finalChunk = '';
            for (var i = event.resultIndex; i < event.results.length; i++) {
              var result = event.results[i];
              var transcript = result[0] && result[0].transcript ? result[0].transcript : '';
              if (result.isFinal) {
                finalChunk += transcript;
              } else {
                interim += transcript;
              }
            }
            // 实时显示 interim 文本（覆盖式更新）
            if (interim) {
              setStatus('正在聆听... ' + interim);
            }
            // 最终结果：发送给 Agent
            if (finalChunk) {
              appendTranscript('user', finalChunk);
              isProcessing = true;
              setStatus('思考中...');
              sendToAgent(finalChunk);
            }
          } catch (e) {}
        };

        recognition.onerror = function (event) {
          try {
            if (event.error !== 'no-speech' && event.error !== 'aborted') {
              setStatus('识别错误: ' + event.error);
            }
          } catch (e) {}
        };

        recognition.onend = function () {
          if (!isActive) return;
          // 连续模式下由 sendToAgent 完成后自动重新监听，避免覆盖"思考中"状态
          if (!continuous && !isProcessing) {
            setStatus('对话结束');
          }
        };

        recognition.start();
        setStatus('正在聆听...');
      } catch (e) {
        setStatus('启动聆听失败: ' + (e.message || String(e)));
      }
    }

    // V19 贾维斯增强：消费 /api/chat/stream SSE 流，累积段先生回复
    // 兼容 type=text（/api/chat/stream）与 type=chunk（/api/chat）两种事件格式
    async function sendToAgent(text) {
      try {
        var response = await fetch('/api/chat/stream', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: text, history: [], mode: 'chat' })
        });
        if (!response.ok) {
          throw new Error('HTTP ' + response.status);
        }
        var reader = response.body.getReader();
        var decoder = new TextDecoder('utf-8');
        var fullText = '';
        var buffer = '';
        while (true) {
          var chunk = await reader.read();
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          var lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (var i = 0; i < lines.length; i++) {
            var line = lines[i];
            if (line.indexOf('data: ') !== 0) continue;
            var data = line.slice(6);
            if (data === '[DONE]') continue;
            try {
              var parsed = JSON.parse(data);
              if (parsed.type === 'text' && parsed.content) {
                fullText += parsed.content;
              } else if (parsed.type === 'chunk' && parsed.chunk) {
                fullText += parsed.chunk;
              } else if (parsed.type === 'error') {
                fullText += '\n[错误] ' + (parsed.content || '');
              }
            } catch (e) {}
          }
        }
        var reply = fullText.replace(/<[^>]*>/g, '').trim() || '无响应';
        appendTranscript('agent', reply);
        speak(reply);
      } catch (e) {
        appendTranscript('agent', '⚠️ ' + (e.message || String(e)));
        setStatus('发送失败: ' + (e.message || String(e)));
      } finally {
        isProcessing = false;
        if (isActive && continuous) {
          setStatus('点击麦克风继续对话');
          setTimeout(function () {
            if (isActive && continuous && !isProcessing) startListening();
          }, 500);
        }
      }
    }

    function toggle() {
      try {
        isActive = !isActive;
        var panel = document.getElementById('jarvisModePanel');
        if (panel) panel.style.display = isActive ? 'block' : 'none';
        if (isActive) {
          setStatus('点击麦克风开始对话');
        } else {
          if (recognition) { try { recognition.stop(); } catch (e) {} }
          if (window.speechSynthesis) { try { speechSynthesis.cancel(); } catch (e) {} }
          isProcessing = false;
        }
        saveState();
      } catch (e) {}
    }

    function init() {
      try {
        var micBtn = document.getElementById('jarvisMicBtn');
        var speakBtn = document.getElementById('jarvisSpeakBtn');
        var closeBtn = document.getElementById('jarvisCloseBtn');
        var autoSpeakChk = document.getElementById('jarvisAutoSpeak');
        var continuousChk = document.getElementById('jarvisContinuous');

        if (micBtn) micBtn.onclick = startListening;
        if (speakBtn) speakBtn.onclick = function () {
          try {
            if (!('speechSynthesis' in window)) return;
            var el = document.getElementById('jarvisTranscript');
            if (!el) return;
            var lines = el.querySelectorAll('div');
            var lastAgent = null;
            for (var i = lines.length - 1; i >= 0; i--) {
              if (lines[i].innerHTML.indexOf('段先生') !== -1) {
                lastAgent = lines[i];
                break;
              }
            }
            if (lastAgent) {
              var text = lastAgent.textContent.replace('段先生:', '').trim();
              if (text) {
                var utterance = new SpeechSynthesisUtterance(text);
                utterance.lang = 'zh-CN';
                speechSynthesis.speak(utterance);
              }
            }
          } catch (e) {}
        };
        if (closeBtn) closeBtn.onclick = toggle;
        if (autoSpeakChk) {
          autoSpeakChk.checked = autoSpeak;
          autoSpeakChk.onchange = function () { autoSpeak = autoSpeakChk.checked; saveState(); };
        }
        if (continuousChk) {
          continuousChk.checked = continuous;
          continuousChk.onchange = function () { continuous = continuousChk.checked; saveState(); };
        }
      } catch (e) {}
    }

    // 暴露切换函数给全局，供导航栏按钮调用
    window.toggleJarvisMode = toggle;

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init);
    } else {
      init();
    }
  } catch (e) {
    console.error('贾维斯模式初始化失败:', e);
  }
})();
