
import { createAuthClient } from '@neondatabase/auth'
import { BetterAuthReactAdapter } from '@neondatabase/auth/react/adapters'

const authUrl = import.meta.env.VITE_NEON_AUTH_URL

if (!authUrl) {
  throw new Error('VITE_NEON_AUTH_URL is missing from .env.local')
}

const authClient = createAuthClient(authUrl, {
  adapter: BetterAuthReactAdapter(),
})

const TOKEN_RETRIES = 4
const RETRY_DELAY_MS = 1500

async function fetchTokenOnce() {
  const response = await fetch(`${authUrl}/token`, {
    method: 'GET',
    credentials: 'include',
  })

  const data = await response.json().catch(() => null)

  if (!response.ok || !data?.token) {
    const error = new Error('Unable to retrieve authentication token. Please sign in again.')
    error.retryable = response.status >= 500 || response.status === 401 || response.status === 429
    throw error
  }

  return data.token
}

export async function getApiToken() {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetchTokenOnce()
    } catch (err) {
      const isNetworkError = err instanceof TypeError
      if (attempt >= TOKEN_RETRIES || (!isNetworkError && !err.retryable)) {
        throw err
      }
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS * attempt))
    }
  }
}

export default authClient
