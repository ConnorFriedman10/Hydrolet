import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import { AuthProvider, SubjectProvider } from './lib/auth'
import { registerServiceWorker } from './lib/push'
import './index.css'

registerServiceWorker()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <SubjectProvider>
          <App />
        </SubjectProvider>
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
)
