import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { Message, Conversation, SystemStatus, ToolInfo, BackendConfig, Theme } from '@/types';

interface ChatState {
  conversations: Conversation[];
  currentConversationId: string | null;
  isStreaming: boolean;
  systemStatus: SystemStatus | null;
  tools: ToolInfo[];
  config: BackendConfig | null;
  currentTheme: Theme;
  searchQuery: string;

  addMessage: (conversationId: string, message: Message) => void;
  createConversation: () => string;
  setCurrentConversation: (id: string | null) => void;
  updateConversationTitle: (id: string, title: string) => void;
  removeMessagesFrom: (conversationId: string, messageId: string) => void;
  deleteConversation: (id: string) => void;
  setIsStreaming: (streaming: boolean) => void;
  updateSystemStatus: (status: Partial<SystemStatus>) => void;
  setTools: (tools: ToolInfo[]) => void;
  setConfig: (config: BackendConfig) => void;
  setTheme: (theme: Theme) => void;
  setSearchQuery: (query: string) => void;
  filteredConversations: () => Conversation[];
  currentConversation: () => Conversation | undefined;
}

const defaultTheme: Theme = {
  id: 'dark',
  name: '深色模式',
  icon: '🌙',
};

export const useChatStore = create<ChatState>()(
  persist(
    (set, get) => ({
      conversations: [],
      currentConversationId: null,
      isStreaming: false,
      systemStatus: null,
      tools: [],
      config: null,
      currentTheme: defaultTheme,
      searchQuery: '',

      addMessage: (conversationId, message) => {
        set((state) => ({
          conversations: state.conversations.map((conv) =>
            conv.id === conversationId
              ? { ...conv, messages: [...conv.messages, message], updatedAt: new Date() }
              : conv
          ),
        }));
      },

      createConversation: () => {
        const id = `conv_${Date.now()}`;
        const newConversation: Conversation = {
          id,
          title: '新的对话',
          messages: [],
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        set((state) => ({
          conversations: [newConversation, ...state.conversations],
          currentConversationId: id,
        }));
        return id;
      },

      setCurrentConversation: (id) => {
        set({ currentConversationId: id });
      },

      updateConversationTitle: (id, title) => {
        set((state) => ({
          conversations: state.conversations.map((conv) =>
            conv.id === id ? { ...conv, title } : conv
          ),
        }));
      },

      removeMessagesFrom: (conversationId, messageId) => {
        set((state) => ({
          conversations: state.conversations.map((conv) => {
            if (conv.id !== conversationId) return conv;
            const idx = conv.messages.findIndex(m => m.id === messageId);
            if (idx < 0) return conv;
            return {
              ...conv,
              messages: conv.messages.slice(0, idx),
              updatedAt: new Date(),
            };
          }),
        }));
      },

      deleteConversation: (id) => {
        set((state) => ({
          conversations: state.conversations.filter((conv) => conv.id !== id),
          currentConversationId: state.currentConversationId === id ? null : state.currentConversationId,
        }));
      },

      setIsStreaming: (streaming) => {
        set({ isStreaming: streaming });
      },

      updateSystemStatus: (status) => {
        set((state) => ({
          systemStatus: state.systemStatus ? { ...state.systemStatus, ...status } : (status as SystemStatus),
        }));
      },

      setTools: (tools) => {
        set({ tools });
      },

      setConfig: (config) => {
        set({ config });
      },

      setTheme: (theme) => {
        set({ currentTheme: theme });
        document.body.className = `theme-${theme.id}`;
        localStorage.setItem('duan-theme', theme.id);
      },

      setSearchQuery: (query) => {
        set({ searchQuery: query });
      },

      filteredConversations: () => {
        const { conversations, searchQuery } = get();
        if (!searchQuery) return conversations;
        const query = searchQuery.toLowerCase();
        return conversations.filter(
          (conv) =>
            conv.title.toLowerCase().includes(query) ||
            conv.messages.some((msg) => msg.content.toLowerCase().includes(query))
        );
      },

      currentConversation: () => {
        const { conversations, currentConversationId } = get();
        return conversations.find((conv) => conv.id === currentConversationId);
      },
    }),
    {
      name: 'duan-chat-storage',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        conversations: state.conversations,
        currentConversationId: state.currentConversationId,
      }),
      // P2 修复：localStorage 序列化后 Date 会变成字符串，反序列化时还原为 Date 对象
      // P2 修复：创建新对象而非直接突变，保持状态不可变性
      onRehydrateStorage: () => (state) => {
        if (!state?.conversations) return;
        state.conversations = state.conversations.map((conv) => {
          const c = conv as unknown as { createdAt: string | Date; updatedAt: string | Date };
          return {
            ...conv,
            createdAt: c.createdAt && typeof c.createdAt === 'string' ? new Date(c.createdAt) : c.createdAt,
            updatedAt: c.updatedAt && typeof c.updatedAt === 'string' ? new Date(c.updatedAt) : c.updatedAt,
          };
        }) as Conversation[];
      },
    }
  )
);

export const themes: Theme[] = [
  { id: 'dark', name: '深色模式', icon: '🌙' },
  { id: 'light', name: '浅色模式', icon: '☀️' },
  { id: 'emerald', name: '翡翠模式', icon: '💚' },
];
