export type AiProvider = "gemini" | "openrouter" | "groq" | "ollama" | "openai" | "custom";

export interface ModelOption {
  id: string;
  name: string;
  free?: boolean;
  badge?: string;
}

export interface ProviderDefinition {
  id: AiProvider;
  name: string;
  description: string;
  badge?: string;
  defaultBaseUrl: string;
  defaultModel: string;
  requiresApiKey: boolean;
  apiKeyHelpUrl?: string;
  apiKeyPlaceholder: string;
  models: ModelOption[];
}

export const PROVIDERS: Record<AiProvider, ProviderDefinition> = {
  gemini: {
    id: "gemini",
    name: "Google Gemini",
    description:
      "Modelos de alta velocidade do Google com camada gratuita generosa no Google AI Studio (mesmo ecossistema usado no MistakeMap).",
    badge: "Grátis no AI Studio",
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
    defaultModel: "gemini-2.5-flash",
    requiresApiKey: true,
    apiKeyHelpUrl: "https://aistudio.google.com/apikey",
    apiKeyPlaceholder: "AIzaSy...",
    models: [
      { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", free: true, badge: "Recomendado" },
      { id: "gemini-2.0-flash", name: "Gemini 2.0 Flash", free: true, badge: "Grátis" },
      { id: "gemini-1.5-flash", name: "Gemini 1.5 Flash", free: true, badge: "Grátis" },
      { id: "gemini-2.5-flash-lite", name: "Gemini 2.5 Flash-Lite", free: true, badge: "Ultra-rápido" },
      { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", free: false, badge: "Avançado" },
    ],
  },
  openrouter: {
    id: "openrouter",
    name: "OpenRouter",
    description:
      "Acesso unificado a dezenas de modelos comerciais e abertos, incluindo modelos 100% gratuitos (terminados em :free).",
    badge: "Modelos Gratuitos",
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "google/gemini-2.0-flash-exp:free",
    requiresApiKey: true,
    apiKeyHelpUrl: "https://openrouter.ai/keys",
    apiKeyPlaceholder: "sk-or-v1-...",
    models: [
      { id: "google/gemini-2.0-flash-exp:free", name: "Gemini 2.0 Flash Exp", free: true, badge: "Grátis" },
      { id: "meta-llama/llama-3.3-70b-instruct:free", name: "Llama 3.3 70B Instruct", free: true, badge: "Grátis" },
      { id: "deepseek/deepseek-r1:free", name: "DeepSeek R1", free: true, badge: "Grátis" },
      { id: "qwen/qwen-2.5-72b-instruct:free", name: "Qwen 2.5 72B Instruct", free: true, badge: "Grátis" },
      { id: "meta-llama/llama-3.1-8b-instruct:free", name: "Llama 3.1 8B Instruct", free: true, badge: "Grátis" },
    ],
  },
  groq: {
    id: "groq",
    name: "Groq",
    description:
      "Inferência com aceleração por hardware (LPU) em velocidade extrema e com camada gratuita para Llama 3.3 e 3.1.",
    badge: "Camada Gratuita",
    defaultBaseUrl: "https://api.groq.com/openai/v1",
    defaultModel: "llama-3.3-70b-versatile",
    requiresApiKey: true,
    apiKeyHelpUrl: "https://console.groq.com/keys",
    apiKeyPlaceholder: "gsk_...",
    models: [
      { id: "llama-3.3-70b-versatile", name: "Llama 3.3 70B Versatile", free: true, badge: "Recomendado" },
      { id: "llama-3.1-8b-instant", name: "Llama 3.1 8B Instant", free: true, badge: "Ultra-rápido" },
    ],
  },
  ollama: {
    id: "ollama",
    name: "Ollama (IA Local)",
    description:
      "Execução 100% local e privada diretamente na sua máquina. Não requer internet nem envio de dados para a nuvem.",
    badge: "100% Gratuito & Local",
    defaultBaseUrl: "http://localhost:11434/v1",
    defaultModel: "llama3.2",
    requiresApiKey: false,
    apiKeyHelpUrl: "https://ollama.ai",
    apiKeyPlaceholder: "Não necessária para Ollama local (opcional)",
    models: [
      { id: "llama3.2", name: "Llama 3.2", free: true, badge: "Local" },
      { id: "qwen2.5", name: "Qwen 2.5", free: true, badge: "Local" },
      { id: "mistral", name: "Mistral", free: true, badge: "Local" },
      { id: "gemma2", name: "Gemma 2", free: true, badge: "Local" },
      { id: "deepseek-r1:8b", name: "DeepSeek R1 (8B)", free: true, badge: "Local" },
    ],
  },
  openai: {
    id: "openai",
    name: "OpenAI (ChatGPT)",
    description: "Modelos proprietários oficiais da OpenAI (GPT-4o, GPT-4o Mini, GPT-5).",
    badge: "Oficial",
    defaultBaseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4o-mini",
    requiresApiKey: true,
    apiKeyHelpUrl: "https://platform.openai.com/api-keys",
    apiKeyPlaceholder: "sk-...",
    models: [
      { id: "gpt-4o-mini", name: "GPT-4o Mini", free: false, badge: "Recomendado" },
      { id: "gpt-4o", name: "GPT-4o", free: false, badge: "Completo" },
      { id: "gpt-5.4-mini", name: "GPT-5.4 Mini", free: false },
    ],
  },
  custom: {
    id: "custom",
    name: "Personalizado / Compatível",
    description:
      "Conecte a qualquer servidor ou serviço compatível com a API da OpenAI (DeepSeek, LM Studio, LocalAI, vLLM, etc.).",
    badge: "Customizado",
    defaultBaseUrl: "",
    defaultModel: "",
    requiresApiKey: false,
    apiKeyPlaceholder: "Chave da API (se necessária)",
    models: [],
  },
};

export const PROVIDER_LIST: ProviderDefinition[] = Object.values(PROVIDERS);

export function getProviderInfo(providerId?: string | null): ProviderDefinition {
  if (providerId && providerId in PROVIDERS) {
    return PROVIDERS[providerId as AiProvider];
  }
  return PROVIDERS.gemini;
}
