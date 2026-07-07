/**
 * 语音数据模块 — 从 voice-system.ts 拆分的大型静态语音列表
 *
 * 将 Edge-TTS / OpenAI 语音名称列表独立为数据模块，
 * 避免 voice-system.ts 主类逻辑与静态数据混杂。
 */

export interface VoiceInfo {
  name: string;
  language: string;
  gender: 'male' | 'female';
  provider: string;
}

/** Edge-TTS 可用语音列表（按语言分组） */
export const EDGE_TTS_VOICES: VoiceInfo[] = [
  // ===== 中文 =====
  { name: 'zh-CN-XiaoxiaoNeural', language: 'zh-CN', gender: 'female', provider: 'edge-tts' },
  { name: 'zh-CN-XiaoyiNeural', language: 'zh-CN', gender: 'female', provider: 'edge-tts' },
  { name: 'zh-CN-YunjianNeural', language: 'zh-CN', gender: 'male', provider: 'edge-tts' },
  { name: 'zh-CN-YunxiNeural', language: 'zh-CN', gender: 'male', provider: 'edge-tts' },
  { name: 'zh-CN-YunxiaNeural', language: 'zh-CN', gender: 'male', provider: 'edge-tts' },
  { name: 'zh-CN-YunyangNeural', language: 'zh-CN', gender: 'male', provider: 'edge-tts' },
  { name: 'zh-CN-liaoning-XiaobeiNeural', language: 'zh-CN-liaoning', gender: 'female', provider: 'edge-tts' },
  { name: 'zh-CN-shaanxi-XiaoniNeural', language: 'zh-CN-shaanxi', gender: 'female', provider: 'edge-tts' },
  { name: 'zh-TW-HsiaoChenNeural', language: 'zh-TW', gender: 'female', provider: 'edge-tts' },
  { name: 'zh-TW-HsiaoYuNeural', language: 'zh-TW', gender: 'female', provider: 'edge-tts' },
  { name: 'zh-TW-YunJheNeural', language: 'zh-TW', gender: 'male', provider: 'edge-tts' },
  { name: 'zh-HK-HiuMaanNeural', language: 'zh-HK', gender: 'female', provider: 'edge-tts' },
  { name: 'zh-HK-WanLungNeural', language: 'zh-HK', gender: 'male', provider: 'edge-tts' },
  // ===== 英语 =====
  { name: 'en-US-JennyNeural', language: 'en-US', gender: 'female', provider: 'edge-tts' },
  { name: 'en-US-GuyNeural', language: 'en-US', gender: 'male', provider: 'edge-tts' },
  { name: 'en-US-AriaNeural', language: 'en-US', gender: 'female', provider: 'edge-tts' },
  { name: 'en-US-DavisNeural', language: 'en-US', gender: 'male', provider: 'edge-tts' },
  { name: 'en-US-AmberNeural', language: 'en-US', gender: 'female', provider: 'edge-tts' },
  { name: 'en-US-AnaNeural', language: 'en-US', gender: 'female', provider: 'edge-tts' },
  { name: 'en-GB-SoniaNeural', language: 'en-GB', gender: 'female', provider: 'edge-tts' },
  { name: 'en-GB-RyanNeural', language: 'en-GB', gender: 'male', provider: 'edge-tts' },
  { name: 'en-AU-NatashaNeural', language: 'en-AU', gender: 'female', provider: 'edge-tts' },
  { name: 'en-AU-WilliamNeural', language: 'en-AU', gender: 'male', provider: 'edge-tts' },
  { name: 'en-IN-NeerjaNeural', language: 'en-IN', gender: 'female', provider: 'edge-tts' },
  { name: 'en-IN-PrabhatNeural', language: 'en-IN', gender: 'male', provider: 'edge-tts' },
  { name: 'en-CA-ClaraNeural', language: 'en-CA', gender: 'female', provider: 'edge-tts' },
  // ===== 日语 =====
  { name: 'ja-JP-NanamiNeural', language: 'ja-JP', gender: 'female', provider: 'edge-tts' },
  { name: 'ja-JP-KeitaNeural', language: 'ja-JP', gender: 'male', provider: 'edge-tts' },
  // ===== 韩语 =====
  { name: 'ko-KR-SunHiNeural', language: 'ko-KR', gender: 'female', provider: 'edge-tts' },
  { name: 'ko-KR-InJoonNeural', language: 'ko-KR', gender: 'male', provider: 'edge-tts' },
  // ===== 法语 =====
  { name: 'fr-FR-DeniseNeural', language: 'fr-FR', gender: 'female', provider: 'edge-tts' },
  { name: 'fr-FR-HenriNeural', language: 'fr-FR', gender: 'male', provider: 'edge-tts' },
  { name: 'fr-CA-SylvieNeural', language: 'fr-CA', gender: 'female', provider: 'edge-tts' },
  { name: 'fr-CA-AntoineNeural', language: 'fr-CA', gender: 'male', provider: 'edge-tts' },
  // ===== 德语 =====
  { name: 'de-DE-KatjaNeural', language: 'de-DE', gender: 'female', provider: 'edge-tts' },
  { name: 'de-DE-ConradNeural', language: 'de-DE', gender: 'male', provider: 'edge-tts' },
  // ===== 西班牙语 =====
  { name: 'es-ES-ElviraNeural', language: 'es-ES', gender: 'female', provider: 'edge-tts' },
  { name: 'es-ES-AlvaroNeural', language: 'es-ES', gender: 'male', provider: 'edge-tts' },
  { name: 'es-MX-DaliaNeural', language: 'es-MX', gender: 'female', provider: 'edge-tts' },
  { name: 'es-MX-JorgeNeural', language: 'es-MX', gender: 'male', provider: 'edge-tts' },
  // ===== 葡萄牙语 =====
  { name: 'pt-BR-FranciscaNeural', language: 'pt-BR', gender: 'female', provider: 'edge-tts' },
  { name: 'pt-BR-AntonioNeural', language: 'pt-BR', gender: 'male', provider: 'edge-tts' },
  { name: 'pt-PT-RaquelNeural', language: 'pt-PT', gender: 'female', provider: 'edge-tts' },
  // ===== 意大利语 =====
  { name: 'it-IT-ElsaNeural', language: 'it-IT', gender: 'female', provider: 'edge-tts' },
  { name: 'it-IT-DiegoNeural', language: 'it-IT', gender: 'male', provider: 'edge-tts' },
  // ===== 俄语 =====
  { name: 'ru-RU-SvetlanaNeural', language: 'ru-RU', gender: 'female', provider: 'edge-tts' },
  { name: 'ru-RU-DmitryNeural', language: 'ru-RU', gender: 'male', provider: 'edge-tts' },
  // ===== 阿拉伯语 =====
  { name: 'ar-SA-ZariyahNeural', language: 'ar-SA', gender: 'female', provider: 'edge-tts' },
  { name: 'ar-SA-HamedNeural', language: 'ar-SA', gender: 'male', provider: 'edge-tts' },
  // ===== 印地语 =====
  { name: 'hi-IN-SwaraNeural', language: 'hi-IN', gender: 'female', provider: 'edge-tts' },
  { name: 'hi-IN-MadhurNeural', language: 'hi-IN', gender: 'male', provider: 'edge-tts' },
  // ===== 泰语 =====
  { name: 'th-TH-PremwadeeNeural', language: 'th-TH', gender: 'female', provider: 'edge-tts' },
  { name: 'th-TH-NiwatNeural', language: 'th-TH', gender: 'male', provider: 'edge-tts' },
  // ===== 越南语 =====
  { name: 'vi-VN-HoaiMyNeural', language: 'vi-VN', gender: 'female', provider: 'edge-tts' },
  { name: 'vi-VN-NamMinhNeural', language: 'vi-VN', gender: 'male', provider: 'edge-tts' },
  // ===== 印尼语 =====
  { name: 'id-ID-GadisNeural', language: 'id-ID', gender: 'female', provider: 'edge-tts' },
  { name: 'id-ID-ArdiNeural', language: 'id-ID', gender: 'male', provider: 'edge-tts' },
  // ===== 土耳其语 =====
  { name: 'tr-TR-EmelNeural', language: 'tr-TR', gender: 'female', provider: 'edge-tts' },
  { name: 'tr-TR-AhmetNeural', language: 'tr-TR', gender: 'male', provider: 'edge-tts' },
  // ===== 荷兰语 =====
  { name: 'nl-NL-ColetteNeural', language: 'nl-NL', gender: 'female', provider: 'edge-tts' },
  { name: 'nl-NL-FennaNeural', language: 'nl-NL', gender: 'female', provider: 'edge-tts' },
  // ===== 波兰语 =====
  { name: 'pl-PL-ZofiaNeural', language: 'pl-PL', gender: 'female', provider: 'edge-tts' },
  { name: 'pl-PL-MarekNeural', language: 'pl-PL', gender: 'male', provider: 'edge-tts' },
  // ===== 瑞典语 =====
  { name: 'sv-SE-SofieNeural', language: 'sv-SE', gender: 'female', provider: 'edge-tts' },
  { name: 'sv-SE-MattiasNeural', language: 'sv-SE', gender: 'male', provider: 'edge-tts' },
  // ===== 乌克兰语 =====
  { name: 'uk-UA-PolinaNeural', language: 'uk-UA', gender: 'female', provider: 'edge-tts' },
  { name: 'uk-UA-OstapNeural', language: 'uk-UA', gender: 'male', provider: 'edge-tts' },
  // ===== 捷克语 =====
  { name: 'cs-CZ-VlastaNeural', language: 'cs-CZ', gender: 'female', provider: 'edge-tts' },
  { name: 'cs-CZ-AntoninNeural', language: 'cs-CZ', gender: 'male', provider: 'edge-tts' },
  // ===== 希腊语 =====
  { name: 'el-GR-AthinaNeural', language: 'el-GR', gender: 'female', provider: 'edge-tts' },
  { name: 'el-GR-NestorasNeural', language: 'el-GR', gender: 'male', provider: 'edge-tts' },
  // ===== 芬兰语 =====
  { name: 'fi-FI-SelmaNeural', language: 'fi-FI', gender: 'female', provider: 'edge-tts' },
  { name: 'fi-FI-HarriNeural', language: 'fi-FI', gender: 'male', provider: 'edge-tts' },
  // ===== 丹麦语 =====
  { name: 'da-DK-ChristelNeural', language: 'da-DK', gender: 'female', provider: 'edge-tts' },
  { name: 'da-DK-JeppeNeural', language: 'da-DK', gender: 'male', provider: 'edge-tts' },
  // ===== 罗马尼亚语 =====
  { name: 'ro-RO-AlinaNeural', language: 'ro-RO', gender: 'female', provider: 'edge-tts' },
  { name: 'ro-RO-EmilNeural', language: 'ro-RO', gender: 'male', provider: 'edge-tts' },
  // ===== 匈牙利语 =====
  { name: 'hu-HU-NoemiNeural', language: 'hu-HU', gender: 'female', provider: 'edge-tts' },
  { name: 'hu-HU-TamasNeural', language: 'hu-HU', gender: 'male', provider: 'edge-tts' },
  // ===== 希伯来语 =====
  { name: 'he-IL-HilaNeural', language: 'he-IL', gender: 'female', provider: 'edge-tts' },
  { name: 'he-IL-AvriNeural', language: 'he-IL', gender: 'male', provider: 'edge-tts' },
  // ===== 马来语 =====
  { name: 'ms-MY-YasminNeural', language: 'ms-MY', gender: 'female', provider: 'edge-tts' },
  { name: 'ms-MY-OsmanNeural', language: 'ms-MY', gender: 'male', provider: 'edge-tts' },
  // ===== 挪威语 =====
  { name: 'nb-NO-PernilleNeural', language: 'nb-NO', gender: 'female', provider: 'edge-tts' },
  { name: 'nb-NO-FinnNeural', language: 'nb-NO', gender: 'male', provider: 'edge-tts' },
];

/** 有效语音名称集合（用于校验，避免传入 Azure 专属语音导致 NoAudioReceived） */
export const VALID_EDGE_TTS_VOICE_NAMES = new Set(EDGE_TTS_VOICES.map(v => v.name));

/** OpenAI TTS 可用语音列表 */
export const OPENAI_TTS_VOICES: VoiceInfo[] = [
  { name: 'alloy', language: 'multi', gender: 'female', provider: 'openai' },
  { name: 'echo', language: 'multi', gender: 'male', provider: 'openai' },
  { name: 'fable', language: 'multi', gender: 'male', provider: 'openai' },
  { name: 'onyx', language: 'multi', gender: 'male', provider: 'openai' },
  { name: 'nova', language: 'multi', gender: 'female', provider: 'openai' },
  { name: 'shimmer', language: 'multi', gender: 'female', provider: 'openai' },
];
