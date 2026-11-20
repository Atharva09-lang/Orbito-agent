import { useEffect, useRef } from 'react'
import MessageBubble from './MessageBubble'
import TypingIndicator from './TypingIndicator'

function ChatWindow({ messages, isTyping }) {
  const scrollRef = useRef(null)

  useEffect(() => {
    const element = scrollRef.current
    if (element) {
      element.scrollTo({ top: element.scrollHeight })
    }
  }, [messages, isTyping])

  return (
    <section className="chat-content" ref={scrollRef}>
      {messages.length === 0 ? (
        <div className="welcome-message">
          <div className="ai-icon">
            <span className="orbit-ring" />
            O
          </div>
          <h1>What can I help you with?</h1>
          <p>
            Ask anything. Search the web, explore ideas,
            or get help with your tasks.
          </p>
          <div className="welcome-chips">
            <span>✦ Web search</span>
            <span>🧠 Remembers you</span>
            <span>⏰ Reminders</span>
            <span>💬 Past chats</span>
          </div>
        </div>
      ) : (
        <div className="messages-container">
          {messages.map((message) => (
            <MessageBubble key={message.id} message={message} />
          ))}

          {isTyping && <TypingIndicator />}
        </div>
      )}
    </section>
  )
}

export default ChatWindow
