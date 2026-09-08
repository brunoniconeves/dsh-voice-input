/** Voice-input copy: composer mic button states, waveform, hands-free, and failure copy. */

/** Dictionary keys of the `voice` namespace. */
export type VoiceKey =
  | 'aria.start'
  | 'aria.stop'
  | 'aria.recording'
  | 'aria.transcribing'
  | 'aria.listening'
  | 'aria.capturing'
  | 'aria.serverDown'
  | 'menu.configs'
  | 'config.title'
  | 'config.close'
  | 'config.endpoint'
  | 'config.listen'
  | 'config.stop'
  | 'config.send'
  | 'config.handsFree'
  | 'config.handsFreeHint'
  | 'config.cleanup'
  | 'config.cleanupHint'
  | 'config.cleanupModel'
  | 'config.cleanupEffort'
  | 'config.cleanupApiKey'
  | 'config.serverDir'
  | 'config.save'
  | 'config.cancel'
  | 'config.language'
  | 'effort.off'
  | 'effort.low'
  | 'effort.high'
  | 'effort.max'
  | 'error.mic'
  | 'error.transcribe'
  | 'error.empty'
  | 'error.server'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh: Record<VoiceKey, string> = {
  'aria.start': '语音输入',
  'aria.stop': '停止录音',
  'aria.recording': '正在录音',
  'aria.transcribing': '正在转写',
  'aria.listening': '正在监听指令',
  'aria.capturing': '正在录入指令',
  'aria.serverDown': 'Whisper 服务未运行',
  'menu.configs': '配置',
  'config.title': '语音输入设置',
  'config.close': '关闭',
  'config.endpoint': '语音转写服务地址',
  'config.listen': '激活短语（逗号分隔，例如“开始转录，开始录音”）',
  'config.stop': '暂停短语（逗号分隔，例如“停止转录，暂停”）',
  'config.send': '发送短语（逗号分隔，例如“发送提示，提交”）',
  'config.handsFree': '免提模式（麦克风常开）',
  'config.handsFreeHint': '保持麦克风开启并持续识别“激活”命令；关闭它可改回点击录音。',
  'config.cleanup': 'LLM 清理转录文本',
  'config.cleanupHint': '用本地服务器配置的 LLM 清理转录（需在该服务器的 CLEANUP_API_KEY 中设置）。',
  'config.cleanupModel': '清理模型（如 deepseek-chat）',
  'config.cleanupEffort': '清理推理等级',
  'config.cleanupApiKey': 'API 密钥（sk-...）',
  'config.serverDir': '本地 Whisper 服务目录（免提模式下自动启动）',
  'config.save': '保存',
  'config.cancel': '取消',
  'config.language': '转写语言（ISO 双字母，如 en/pt）',
  'effort.off': 'Off',
  'effort.low': 'Low',
  'effort.high': 'High',
  'effort.max': 'Max',
  'error.mic': '无法访问麦克风，请检查浏览器权限',
  'error.transcribe': '语音转写失败',
  'error.empty': '未识别到语音',
  'error.server': '无法连接本地 Whisper 服务',
}

/** English dictionary, checked complete against the zh key set. */
export const en: Record<VoiceKey, string> = {
  'aria.start': 'Voice input',
  'aria.stop': 'Stop recording',
  'aria.recording': 'Recording',
  'aria.transcribing': 'Transcribing',
  'aria.listening': 'Listening for commands',
  'aria.capturing': 'Capturing your command',
  'aria.serverDown': 'Whisper server is not running',
  'menu.configs': 'Configs',
  'config.title': 'Voice input settings',
  'config.close': 'Close',
  'config.endpoint': 'Whisper endpoint',
  'config.listen': 'Activation phrases (comma-separated, e.g. "start transcription, begin")',
  'config.stop': 'Pause phrases (comma-separated, e.g. "stop recording, pause")',
  'config.send': 'Send phrases (comma-separated, e.g. "send the prompt, submit")',
  'config.handsFree': 'Hands-free mode (mic always on)',
  'config.handsFreeHint': 'Keeps the microphone on and listens for the activation command; turn it off to return to click-to-record.',
  'config.cleanup': 'Clean up transcription with an LLM',
  'config.cleanupHint': 'Uses the LLM configured on the local server (set its CLEANUP_API_KEY) to clean the transcription using recent conversation context.',
  'config.cleanupModel': 'Cleanup model (e.g. deepseek-chat)',
  'config.cleanupEffort': 'Cleanup reasoning effort',
  'config.cleanupApiKey': 'API key (sk-...)',
  'config.serverDir': 'Local Whisper server directory (auto-started in hands-free mode)',
  'config.save': 'Save',
  'config.cancel': 'Cancel',
  'config.language': 'Transcription language (ISO 2-letter, e.g. en/pt)',
  'effort.off': 'Off',
  'effort.low': 'Low',
  'effort.high': 'High',
  'effort.max': 'Max',
  'error.mic': 'Microphone unavailable; check your browser permissions',
  'error.transcribe': 'Transcription failed',
  'error.empty': 'No speech recognized',
  'error.server': 'Could not reach the local Whisper service',
}
