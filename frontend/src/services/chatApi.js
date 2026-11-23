
import { getApiToken } from './authClient'

const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL || 'http://localhost:5000/api'

const NETWORK_RETRIES = 4
const NETWORK_RETRY_DELAY_MS = 1000

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function apiRequest(endpoint, options = {}) {
  const method = (options.method || 'GET').toUpperCase()
  const canRetryNetworkError = method === 'GET'

  for (let attempt = 1; ; attempt++) {
    const token = await getApiToken()

    let response

    try {
      response = await fetch(`${API_BASE_URL}${endpoint}`, {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          ...options.headers,
          Authorization: `Bearer ${token}`,
        },
      })
    } catch {
      if (canRetryNetworkError && attempt < NETWORK_RETRIES) {
        await wait(NETWORK_RETRY_DELAY_MS * attempt)
        continue
      }

      throw new Error('Unable to reach the server. Please try again in a moment.')
    }

    const data = await response.json().catch(() => null)

    if (!response.ok) {
      if (response.status === 401 && attempt === 1) {
        await wait(1500)
        continue
      }
      throw new Error(data?.message || data?.error || 'Something went wrong.')
    }

    return data
  }
}

export const getConversations = () =>
  apiRequest('/conversations')

export const createConversation = (title) =>
  apiRequest('/conversations', {
    method: 'POST',
    body: JSON.stringify({ title }),
  })

export const getMessages = (conversationId) =>
  apiRequest(`/messages/${conversationId}`)

export const sendMessageToBackend = (conversationId, content) =>
  apiRequest(`/messages/${conversationId}`, {
    method: 'POST',
    body: JSON.stringify({
      content,
      role: 'user',
      metadata: {},
    }),
  })
export const deleteConversation = (conversationId) =>
  apiRequest(`/conversations/${conversationId}`, {
    method: 'DELETE',
  })
export default apiRequest
