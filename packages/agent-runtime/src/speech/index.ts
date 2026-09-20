export {
  assertSameOrigin,
  executeSpeechHttp,
  joinProviderUrl,
  type SpeechHttpBody,
  type SpeechHttpCall,
  type SpeechHttpContext,
  type SpeechHttpParse,
  type SpeechHttpResult,
} from "./http.js";
export {
  builtinSpeechCall,
  openaiAudioCall,
  openaiChatAudioCall,
  runBuiltinSpeech,
  type SpeechEndpoint,
  type SpeechJob,
} from "./adapters.js";
