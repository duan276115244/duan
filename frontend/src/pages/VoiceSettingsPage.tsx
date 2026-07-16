import { useState, useEffect, useRef } from 'react';
import { ArrowLeft, Mic, Volume2, Play, Loader2, CheckCircle, X } from 'lucide-react';
import { clearVoiceConfigCache } from '../components/VoiceOutput';

interface VoiceConfig {
  enabled: boolean;
  voice: string;
  rate: number;
  pitch: number;
  volume: number;
  autoPlay: boolean;
}

interface VoiceInfo {
  name: string;
  label: string;
  gender: string;
  language: string;
  style: string;
}

// 默认音色列表（与 main.js BUILTIN_VOICES 保持一致）
// 注意：仅包含 edge-tts 免费服务实际可用的语音，不可随意添加 Azure 专属语音
const DEFAULT_VOICES: VoiceInfo[] = [
  { name: 'zh-CN-XiaoxiaoNeural', label: '晓晓', gender: 'female', language: 'zh-CN', style: '温柔亲切·客服女声' },
  { name: 'zh-CN-XiaoyiNeural', label: '晓伊', gender: 'female', language: 'zh-CN', style: '活泼俏皮·少女音' },
  { name: 'zh-CN-YunjianNeural', label: '云健', gender: 'male', language: 'zh-CN', style: '沉稳厚重·男中音' },
  { name: 'zh-CN-YunxiNeural', label: '云希', gender: 'male', language: 'zh-CN', style: '阳光开朗·少年音' },
  { name: 'zh-CN-YunxiaNeural', label: '云夏', gender: 'male', language: 'zh-CN', style: '清亮少年·正太音' },
  { name: 'zh-CN-YunyangNeural', label: '云扬', gender: 'male', language: 'zh-CN', style: '专业沉稳·新闻男主播' },
];

export function VoiceSettingsPage({ onBack }: { onBack?: () => void }) {
  const [voiceConfig, setVoiceConfig] = useState<VoiceConfig>({
    enabled: false, voice: 'zh-CN-XiaoxiaoNeural', rate: 1.0, pitch: 0, volume: 1.0, autoPlay: false,
  });
  const [voiceList, setVoiceList] = useState<VoiceInfo[]>(DEFAULT_VOICES);
  const [voiceTesting, setVoiceTesting] = useState(false);
  const [voiceMsg, setVoiceMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [testingVoice, setTestingVoice] = useState<string | null>(null);

  // 加载语音配置和音色列表
  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.voice) {
      setLoading(false);
      return;
    }
    Promise.all([
      api.voice.load().catch(() => null),
      api.voice.listVoices().catch(() => null),
    ]).then(([cfg, voices]) => {
      if (cfg) {
        setVoiceConfig(prev => ({
          ...prev,
          enabled: cfg.enabled ?? false,
          voice: cfg.voice ?? 'zh-CN-XiaoxiaoNeural',
          rate: cfg.rate ?? 1.0,
          pitch: cfg.pitch ?? 0,
          volume: cfg.volume ?? 1.0,
          autoPlay: cfg.autoPlay ?? false,
        }));
      }
      if (voices?.voices && Array.isArray(voices.voices) && voices.voices.length > 0) {
        setVoiceList(voices.voices);
      }
      setLoading(false);
    });
  }, []);

  // 自动保存：当音色或参数变化时自动保存（让用户无需手动点保存）
  const autoSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isFirstLoad = useRef(true);
  useEffect(() => {
    if (isFirstLoad.current) {
      isFirstLoad.current = false;
      return; // 首次加载不触发自动保存
    }
    const api = window.electronAPI;
    if (!api?.voice) return;
    // 防抖：500ms 后保存
    if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
    autoSaveTimer.current = setTimeout(async () => {
      try {
        const res = await api.voice.save(voiceConfig);
        if (res?.success) {
          try { clearVoiceConfigCache(); } catch { /* ignore */ }
        }
      } catch { /* ignore */ }
    }, 500);
    return () => { if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current); };
  }, [voiceConfig.voice, voiceConfig.rate, voiceConfig.pitch, voiceConfig.volume]); // P2 修复：监听所有参数变化

  const showMsg = (type: 'success' | 'error', text: string) => {
    setVoiceMsg({ type, text });
    setTimeout(() => setVoiceMsg(null), 3000);
  };

  // 保存语音配置
  const handleSave = async () => {
    const api = window.electronAPI;
    if (!api?.voice) {
      showMsg('error', '当前环境不支持语音设置');
      return;
    }
    try {
      const res = await api.voice.save(voiceConfig);
      if (res?.success) {
        // 清除 VoiceOutput 的配置缓存，使新配置立即生效
        try { clearVoiceConfigCache(); } catch { /* ignore */ }
        showMsg('success', '语音设置已保存');
      } else {
        showMsg('error', res?.error || '保存失败');
      }
    } catch (e: unknown) {
      showMsg('error', e instanceof Error ? e.message : '保存失败');
    }
  };

  // 试听指定音色
  const handleTest = async (voiceName?: string) => {
    const api = window.electronAPI;
    if (!api?.voice) {
      showMsg('error', '当前环境不支持语音试听');
      return;
    }
    const targetVoice = voiceName || voiceConfig.voice;
    setVoiceTesting(true);
    setTestingVoice(targetVoice);
    try {
      const result = await api.voice.testVoice({
        voice: targetVoice,
        rate: voiceConfig.rate,
        pitch: voiceConfig.pitch,
        // 不传 text，由后端根据语音语言自动选择合适的测试文本
        // （英文语音无法合成中文，日文语音无法合成中文，等等）
      });
      if (result?.success && result.audio) {
        const byteChars = atob(result.audio);
        const byteArrays: BlobPart[] = [];
        for (let i = 0; i < byteChars.length; i += 8192) {
          const slice = byteChars.slice(i, i + 8192);
          const byteNumbers = new Array(slice.length);
          for (let j = 0; j < slice.length; j++) byteNumbers[j] = slice.charCodeAt(j);
          byteArrays.push(new Uint8Array(byteNumbers));
        }
        const blob = new Blob(byteArrays, { type: result.mime || 'audio/mpeg' });
        if (blob.size === 0) {
          showMsg('error', 'TTS 返回了空音频数据');
          return;
        }
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        audio.volume = voiceConfig.volume;
        // P2 修复：添加 onerror/onabort 清理 URL，防止内存泄漏
        const cleanup = () => URL.revokeObjectURL(url);
        audio.onended = cleanup;
        audio.onerror = cleanup;
        audio.onabort = cleanup;
        await audio.play();
        showMsg('success', `正在试听：${voiceList.find(v => v.name === targetVoice)?.label || targetVoice}`);
      } else {
        showMsg('error', result?.error || 'TTS 服务不可用，请确保 Agent 服务已启动');
      }
    } catch (e: unknown) {
      showMsg('error', e instanceof Error ? e.message : '试听失败');
    } finally {
      setVoiceTesting(false);
      setTestingVoice(null);
    }
  };

  return (
    <div style={{ height: '100%', overflowY: 'auto', background: '#0a0e1a' }}>
      <div className="tech-bg" />
      <div style={{ maxWidth: 900, margin: '0 auto', padding: '24px 28px', position: 'relative', zIndex: 1 }}>
        {/* 头部 */}
        <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            {onBack && (
              <button onClick={onBack} style={{
                padding: 8, borderRadius: 10,
                background: 'rgba(255,255,255,.03)', border: '1px solid rgba(255,255,255,.08)',
                cursor: 'pointer', color: '#94a3b8',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                backdropFilter: 'blur(12px)', transition: 'all .15s',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(6,182,212,.08)'; e.currentTarget.style.borderColor = 'rgba(6,182,212,.2)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,.03)'; e.currentTarget.style.borderColor = 'rgba(255,255,255,.08)'; }}
              >
                <ArrowLeft style={{ width: 16, height: 16 }} />
              </button>
            )}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{
                width: 40, height: 40, borderRadius: 12,
                background: 'linear-gradient(135deg, #ec4899, #8b5cf6)',
                color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
                boxShadow: '0 0 16px rgba(236,72,153,.3)',
              }}>
                <Mic style={{ width: 20, height: 20 }} />
              </div>
              <div>
                <h1 className="gradient-text" style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>语音对话设置</h1>
                <p style={{ fontSize: 12, color: '#64748b', margin: '4px 0 0' }}>音色选择 · 语速 · 音调 · 音量 · 模拟真人发音</p>
              </div>
            </div>
            <span className="live-indicator" style={{ marginLeft: 8 }}>LIVE</span>
          </div>
        </header>

        {/* 消息提示 */}
        {voiceMsg && (
          <div style={{
            marginBottom: 16, padding: '12px 16px', borderRadius: 10,
            background: voiceMsg.type === 'success' ? 'rgba(16,185,129,.08)' : 'rgba(239,68,68,.08)',
            border: `1px solid ${voiceMsg.type === 'success' ? 'rgba(16,185,129,.25)' : 'rgba(239,68,68,.25)'}`,
            fontSize: 13, color: voiceMsg.type === 'success' ? '#10b981' : '#ef4444',
            display: 'flex', alignItems: 'center', gap: 8,
            animation: 'slide-up 0.3s ease-out',
          }}>
            {voiceMsg.type === 'success' ? <CheckCircle style={{ width: 14, height: 14 }} /> : <X style={{ width: 14, height: 14 }} />}
            {voiceMsg.text}
          </div>
        )}

        {loading ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 64 }}>
            <Loader2 style={{ width: 28, height: 28, color: '#06b6d4', animation: 'spin 1s linear infinite' }} />
          </div>
        ) : (
          <>
            {/* 音色选择卡片 */}
            <section className="glass-effect" style={{ borderRadius: 16, padding: 20, marginBottom: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
                <h2 className="title-decorate" style={{ fontSize: 15, fontWeight: 600, color: '#e2e8f0', margin: 0 }}>音色选择</h2>
                <span style={{ fontSize: 11, color: '#475569' }}>共 {voiceList.length} 个音色</span>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 10 }}>
                {voiceList.map(v => {
                  const isSelected = voiceConfig.voice === v.name;
                  const isTestingThis = testingVoice === v.name;
                  return (
                    <div
                      key={v.name}
                      onClick={() => setVoiceConfig(prev => ({ ...prev, voice: v.name }))}
                      className="hover-glow"
                      style={{
                        padding: 14, borderRadius: 12, cursor: 'pointer',
                        border: isSelected ? '1px solid rgba(236,72,153,.4)' : '1px solid rgba(255,255,255,.06)',
                        background: isSelected ? 'rgba(236,72,153,.08)' : 'rgba(255,255,255,.02)',
                        transition: 'all .2s',
                        position: 'relative',
                        boxShadow: isSelected ? '0 0 16px rgba(236,72,153,.15)' : 'none',
                      }}
                    >
                      {isSelected && (
                        <div style={{ position: 'absolute', top: 8, right: 8 }}>
                          <CheckCircle style={{ width: 14, height: 14, color: '#ec4899' }} />
                        </div>
                      )}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                        <div style={{
                          width: 28, height: 28, borderRadius: 8,
                          background: v.gender === 'female' ? 'rgba(236,72,153,.15)' : 'rgba(59,130,246,.15)',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          fontSize: 14,
                        }}>
                          {v.gender === 'female' ? '♀' : '♂'}
                        </div>
                        <div>
                          <span style={{ fontSize: 13, fontWeight: 600, color: isSelected ? '#ec4899' : '#e2e8f0' }}>{v.label}</span>
                          <span style={{ fontSize: 10, color: '#475569', marginLeft: 6 }}>{v.gender === 'female' ? '女声' : '男声'}</span>
                        </div>
                      </div>
                      <p style={{ fontSize: 11, color: '#64748b', margin: '0 0 8px' }}>{v.style}</p>
                      <button
                        onClick={(e) => { e.stopPropagation(); handleTest(v.name); }}
                        disabled={voiceTesting}
                        style={{
                          padding: '4px 10px', borderRadius: 6, fontSize: 10,
                          background: 'rgba(236,72,153,.08)', border: '1px solid rgba(236,72,153,.15)',
                          color: '#ec4899', cursor: voiceTesting ? 'wait' : 'pointer', fontFamily: 'inherit',
                          display: 'inline-flex', alignItems: 'center', gap: 4,
                          transition: 'all .15s',
                        }}
                      >
                        {isTestingThis ? <Loader2 style={{ width: 10, height: 10, animation: 'spin 1s linear infinite' }} /> : <Play style={{ width: 10, height: 10 }} />}
                        {isTestingThis ? '试听中' : '试听'}
                      </button>
                    </div>
                  );
                })}
              </div>
            </section>

            {/* 参数调节 */}
            <section className="glass-effect" style={{ borderRadius: 16, padding: 20, marginBottom: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
                <h2 className="title-decorate" style={{ fontSize: 15, fontWeight: 600, color: '#e2e8f0', margin: 0 }}>参数调节</h2>
                <span style={{ fontSize: 11, color: '#475569' }}>微调语速、音调、音量，模拟真人发音</span>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 20, marginBottom: 16 }}>
                {/* 语速 */}
                <div>
                  <label style={{ fontSize: 12, color: '#94a3b8', display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                    <span>语速</span>
                    <span style={{ color: '#06b6d4', fontWeight: 600, fontSize: 13 }}>{voiceConfig.rate.toFixed(1)}x</span>
                  </label>
                  <input
                    type="range" min="0.5" max="2.0" step="0.1"
                    value={voiceConfig.rate}
                    onChange={(e) => setVoiceConfig(prev => ({ ...prev, rate: parseFloat(e.target.value) }))}
                    style={{ width: '100%', accentColor: '#06b6d4' }}
                  />
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, color: '#475569', marginTop: 4 }}>
                    <span>慢</span><span>正常</span><span>快</span>
                  </div>
                </div>
                {/* 音调 */}
                <div>
                  <label style={{ fontSize: 12, color: '#94a3b8', display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                    <span>音调</span>
                    <span style={{ color: '#8b5cf6', fontWeight: 600, fontSize: 13 }}>{voiceConfig.pitch > 0 ? '+' : ''}{voiceConfig.pitch}</span>
                  </label>
                  <input
                    type="range" min="-10" max="10" step="1"
                    value={voiceConfig.pitch}
                    onChange={(e) => setVoiceConfig(prev => ({ ...prev, pitch: parseInt(e.target.value) }))}
                    style={{ width: '100%', accentColor: '#8b5cf6' }}
                  />
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, color: '#475569', marginTop: 4 }}>
                    <span>低沉</span><span>自然</span><span>尖锐</span>
                  </div>
                </div>
                {/* 音量 */}
                <div>
                  <label style={{ fontSize: 12, color: '#94a3b8', display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                    <span>音量</span>
                    <span style={{ color: '#10b981', fontWeight: 600, fontSize: 13 }}>{Math.round(voiceConfig.volume * 100)}%</span>
                  </label>
                  <input
                    type="range" min="0" max="1" step="0.1"
                    value={voiceConfig.volume}
                    onChange={(e) => setVoiceConfig(prev => ({ ...prev, volume: parseFloat(e.target.value) }))}
                    style={{ width: '100%', accentColor: '#10b981' }}
                  />
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, color: '#475569', marginTop: 4 }}>
                    <span>静音</span><span>正常</span><span>最大</span>
                  </div>
                </div>
              </div>

              {/* 推荐预设 */}
              <div style={{ marginBottom: 16 }}>
                <p style={{ fontSize: 11, color: '#475569', marginBottom: 8 }}>推荐预设：</p>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {[
                    { label: '自然真人', rate: 1.0, pitch: 0, volume: 1.0 },
                    { label: '温柔客服', rate: 0.9, pitch: 2, volume: 0.9 },
                    { label: '活泼少女', rate: 1.2, pitch: 5, volume: 1.0 },
                    { label: '沉稳播音', rate: 0.95, pitch: -2, volume: 1.0 },
                    { label: '快速播报', rate: 1.5, pitch: 0, volume: 1.0 },
                  ].map(preset => (
                    <button
                      key={preset.label}
                      onClick={() => setVoiceConfig(prev => ({ ...prev, rate: preset.rate, pitch: preset.pitch, volume: preset.volume }))}
                      style={{
                        padding: '5px 12px', borderRadius: 8, fontSize: 11,
                        background: 'rgba(6,182,212,.08)', border: '1px solid rgba(6,182,212,.15)',
                        color: '#06b6d4', cursor: 'pointer', fontFamily: 'inherit',
                        transition: 'all .15s',
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(6,182,212,.15)'; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(6,182,212,.08)'; }}
                    >{preset.label}</button>
                  ))}
                </div>
              </div>
            </section>

            {/* 自动播放开关 */}
            <section className="glass-effect" style={{ borderRadius: 16, padding: 20, marginBottom: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div style={{
                    width: 32, height: 32, borderRadius: 8,
                    background: 'rgba(6,182,212,.1)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}>
                    <Volume2 style={{ width: 16, height: 16, color: '#06b6d4' }} />
                  </div>
                  <div>
                    <p style={{ fontSize: 14, fontWeight: 500, color: '#e2e8f0', margin: '0 0 2px' }}>自动朗读回复</p>
                    <p style={{ fontSize: 11, color: '#475569', margin: 0 }}>Agent 回复后自动播放语音</p>
                  </div>
                </div>
                <div
                  onClick={() => setVoiceConfig(prev => ({ ...prev, autoPlay: !prev.autoPlay }))}
                  style={{
                    width: 44, height: 24, borderRadius: 12, cursor: 'pointer',
                    background: voiceConfig.autoPlay ? 'rgba(6,182,212,.3)' : 'rgba(255,255,255,.08)',
                    border: `1px solid ${voiceConfig.autoPlay ? 'rgba(6,182,212,.4)' : 'rgba(255,255,255,.1)'}`,
                    transition: 'all .2s', position: 'relative',
                  }}
                >
                  <div style={{
                    position: 'absolute', top: 2, left: voiceConfig.autoPlay ? 22 : 2,
                    width: 18, height: 18, borderRadius: '50%',
                    background: voiceConfig.autoPlay ? '#06b6d4' : '#64748b',
                    transition: 'all .2s',
                    boxShadow: voiceConfig.autoPlay ? '0 0 8px rgba(6,182,212,.5)' : 'none',
                  }} />
                </div>
              </div>
            </section>

            {/* 操作按钮 */}
            <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end', marginBottom: 32 }}>
              <button
                onClick={() => handleTest()}
                disabled={voiceTesting}
                style={{
                  padding: '11px 24px', borderRadius: 10,
                  background: 'rgba(236,72,153,.08)', border: '1px solid rgba(236,72,153,.2)',
                  cursor: voiceTesting ? 'wait' : 'pointer', color: '#ec4899',
                  fontSize: 13, fontFamily: 'inherit',
                  display: 'inline-flex', alignItems: 'center', gap: 8,
                  transition: 'all .15s',
                }}
              >
                {voiceTesting ? <Loader2 style={{ width: 14, height: 14, animation: 'spin 1s linear infinite' }} /> : <Play style={{ width: 14, height: 14 }} />}
                {voiceTesting ? '生成中...' : '试听当前音色'}
              </button>
              <button
                onClick={handleSave}
                style={{
                  padding: '11px 28px', borderRadius: 10,
                  background: 'linear-gradient(135deg, #06b6d4, #3b82f6)',
                  border: 'none', cursor: 'pointer', color: '#fff',
                  fontSize: 13, fontFamily: 'inherit', fontWeight: 500,
                  display: 'inline-flex', alignItems: 'center', gap: 8,
                  boxShadow: '0 4px 12px rgba(6,182,212,.2)',
                  transition: 'all .15s',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.boxShadow = '0 6px 20px rgba(6,182,212,.35)'; e.currentTarget.style.transform = 'translateY(-1px)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.boxShadow = '0 4px 12px rgba(6,182,212,.2)'; e.currentTarget.style.transform = 'translateY(0)'; }}
              >
                <Volume2 style={{ width: 14, height: 14 }} />
                保存设置
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
