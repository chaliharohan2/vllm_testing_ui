import type { ChatSummary } from '../types'

export function ChatSidebar({
  chats,
  activeId,
  isOpen,
  onSelect,
  onDelete,
  onNewChat,
  onClose,
}: {
  chats: ChatSummary[]
  activeId: string | null
  isOpen: boolean
  onSelect: (chatId: string) => void
  onDelete: (chatId: string) => void
  onNewChat: () => void
  onClose: () => void
}) {
  return (
    <>
      <button
        className={`sidebar-backdrop ${isOpen ? 'is-visible' : ''}`}
        type="button"
        aria-label="Close chats"
        onClick={onClose}
      />
      <nav className={`chat-sidebar ${isOpen ? 'is-open' : ''}`} aria-label="Chats">
        <button className="secondary-button new-chat-button" type="button" onClick={onNewChat}>
          New chat
        </button>
        {chats.length ? (
          <ul>
            {chats.map((chat) => (
              <li key={chat.id} className={chat.id === activeId ? 'is-active' : ''}>
                <button type="button" className="chat-link" onClick={() => onSelect(chat.id)}>
                  {chat.title}
                </button>
                <button
                  type="button"
                  className="chat-delete"
                  aria-label={`Delete ${chat.title}`}
                  title="Delete chat"
                  onClick={() => onDelete(chat.id)}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="sidebar-empty">Saved chats show up here.</p>
        )}
      </nav>
    </>
  )
}
